import fs from 'fs'
import os from 'os'
import path from 'path'
import axios from 'axios'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { SITES_DIR } from './constants'
import { invalidateSitesCache } from './site-channels'

const execFileAsync = promisify(execFile)

const UPSTREAM_TARBALL_URL =
  process.env.UPSTREAM_EPG_TARBALL ||
  'https://codeload.github.com/iptv-org/epg/tar.gz/refs/heads/master'

export interface SyncSitesResult {
  totalSites: number
  addedSites: number
  updatedSites: number
  totalChannels: number
}

function countXmlChannels(dir: string): number {
  let count = 0
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== '__data__') {
      count += countXmlChannels(fullPath)
    } else if (entry.name.endsWith('.channels.xml')) {
      const content = fs.readFileSync(fullPath, 'utf8')
      const matches = content.match(/<channel\b/g)
      if (matches) count += matches.length
    }
  }
  return count
}

export async function syncSitesFromUpstream(
  onProgress?: (msg: string) => void
): Promise<SyncSitesResult> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-epg-sync-'))
  const archivePath = path.join(tempRoot, 'epg.tar.gz')
  const extractDir = path.join(tempRoot, 'extracted')

  try {
    onProgress?.('GitHub (iptv-org/epg) üzerinden güncel dünya site arşivi indiriliyor...')
    const response = await axios.get<ArrayBuffer>(UPSTREAM_TARBALL_URL, {
      responseType: 'arraybuffer',
      timeout: 120000
    })

    fs.writeFileSync(archivePath, Buffer.from(response.data))
    fs.mkdirSync(extractDir, { recursive: true })

    onProgress?.('Arşiv açılıyor ve siteler senkronize ediliyor...')
    await execFileAsync('tar', ['-xzf', archivePath, '-C', extractDir, '--strip-components=1'])

    const upstreamSitesDir = path.join(extractDir, 'sites')
    if (!fs.existsSync(upstreamSitesDir)) {
      throw new Error('İndirilen arşivde sites klasörü bulunamadı')
    }

    const targetSitesDir = path.resolve(SITES_DIR)
    if (!fs.existsSync(targetSitesDir)) {
      fs.mkdirSync(targetSitesDir, { recursive: true })
    }

    let addedSites = 0
    let updatedSites = 0
    let totalSites = 0

    const upstreamEntries = fs.readdirSync(upstreamSitesDir, { withFileTypes: true })
    for (const entry of upstreamEntries) {
      if (!entry.isDirectory()) continue
      totalSites++
      const srcDir = path.join(upstreamSitesDir, entry.name)
      const dstDir = path.join(targetSitesDir, entry.name)

      if (!fs.existsSync(dstDir)) {
        fs.cpSync(srcDir, dstDir, { recursive: true })
        addedSites++
      } else {
        fs.cpSync(srcDir, dstDir, { recursive: true })
        updatedSites++
      }
    }

    applyLocalFixes(targetSitesDir)
    invalidateSitesCache()
    const totalChannels = countXmlChannels(targetSitesDir)

    onProgress?.(
      `Siteler yükseltildi: ${totalSites} site (+${addedSites} yeni, ${updatedSites} güncellendi, ${totalChannels} toplam kanal kaydı).`
    )

    return {
      totalSites,
      addedSites,
      updatedSites,
      totalChannels
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

function applyLocalFixes(targetSitesDir: string) {
  // 1. turksatkablo.com.tr SSL fix
  const turksatFile = path.join(targetSitesDir, 'turksatkablo.com.tr', 'turksatkablo.com.tr.config.js')
  if (fs.existsSync(turksatFile)) {
    let content = fs.readFileSync(turksatFile, 'utf8')
    if (!content.includes('rejectUnauthorized: false')) {
      if (!content.includes("const https = require('https')")) {
        content = "const https = require('https')\n" + content
      }
      content = content.replace(
        /request:\s*\{/,
        `request: {\n    httpsAgent: new https.Agent({ rejectUnauthorized: false }),`
      )
      fs.writeFileSync(turksatFile, content, 'utf8')
    }
  }

  // 2. m.tv.sms.cz TLS cipher fix
  const smsFile = path.join(targetSitesDir, 'm.tv.sms.cz', 'm.tv.sms.cz.config.js')
  if (fs.existsSync(smsFile)) {
    let content = fs.readFileSync(smsFile, 'utf8')
    if (!content.includes('@SECLEVEL=0')) {
      if (!content.includes("const https = require('https')")) {
        content = "const https = require('https')\n" + content
      }
      content = content.replace(
        /request:\s*\{/,
        `request: {\n    httpsAgent: new https.Agent({ ciphers: 'DEFAULT:@SECLEVEL=0', rejectUnauthorized: false }),`
      )
      fs.writeFileSync(smsFile, content, 'utf8')
    }
  }

  // 3. programtv.onet.pl 429 rate limit fix
  const onetFile = path.join(targetSitesDir, 'programtv.onet.pl', 'programtv.onet.pl.config.js')
  if (fs.existsSync(onetFile)) {
    let content = fs.readFileSync(onetFile, 'utf8')
    if (content.includes('catch(console.error)') || content.includes('catch(console.log)')) {
      content = content.replace(
        /async function loadProgramDetails[\s\S]*?^\}/m,
        `async function loadProgramDetails(url) {
  if (!url) return null
  try {
    const html = await axios
      .get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
        },
        timeout: 4000
      })
      .then(r => r.data)
    if (!html) return null

    const $ = cheerio.load(html)

    return {
      image: $('meta[property="og:image"]').attr('content')
    }
  } catch {
    return null
  }
}`
      )
      fs.writeFileSync(onetFile, content, 'utf8')
    }
  }

  // 4. pickx.be fallback & User-Agent fix
  const pickxFile = path.join(targetSitesDir, 'pickx.be', 'pickx.be.config.js')
  if (fs.existsSync(pickxFile)) {
    let content = fs.readFileSync(pickxFile, 'utf8')
    if (!content.includes("apiVersion = 'v3'")) {
      content = content.replace(
        /async function fetchApiVersion[\s\S]*?^\}/m,
        `async function fetchApiVersion() {
  if (apiVersion) return
  const headers = {
    Origin: 'https://www.pickx.be',
    Referer: 'https://www.pickx.be/'
  }

  try {
    const hashUrl = 'https://www.pickx.be/nl/televisie/tv-gids'
    const res = await axios.get(hashUrl, {
      headers: {
        ...headers,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
      }
    })
    let hash
    if (res.data) {
      if (typeof res.data === 'object' && Array.isArray(res.data.hashes)) {
        hash = res.data.hashes[0]
      } else if (typeof res.data === 'string') {
        const match = res.data.match(/"hashes"\\s*:\\s*\\[\\s*"(.*?)"\\s*\\]/)
        if (match) hash = match[1]
      }
    }

    if (hash) {
      const versionUrl = \`https://www.pickx.be/api/s-\${hash}\`
      const vRes = await axios.get(versionUrl, { headers })
      if (vRes && vRes.status === 200 && vRes.data && vRes.data.version) {
        apiVersion = vRes.data.version
        return
      }
    }
  } catch {
    // fallback
  }

  apiVersion = 'v3'
}`
      )
      fs.writeFileSync(pickxFile, content, 'utf8')
    }
  }
}

if (require.main === module) {
  syncSitesFromUpstream(msg => console.log(msg))
    .then(result => {
      console.log('Sync complete:', result)
    })
    .catch(err => {
      console.error('Sync failed:', err)
      process.exit(1)
    })
}
