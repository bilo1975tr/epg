import http from 'http'
import fs from 'fs'
import path from 'path'
import { ChildProcess, spawn } from 'child_process'
import {
  SiteValidationReport,
  validateAndPrune,
  ValidationMode,
  ValidationProgress
} from './scripts/validate-and-prune'
import {
  getAllSitesSummary,
  getAvailableLanguages,
  getSiteChannels
} from './scripts/site-channels'
import { generateCombinedChannelsXML } from './scripts/generate-combined-channels'
import { syncSitesFromUpstream } from './scripts/sync-sites'
import { SITES_DIR } from './scripts/constants'
import { AppErrorRecord, createErrorRecord } from './scripts/error-diagnostics'
import {
  applyGrabResultsToSites,
  ApplyGrabResult,
  discoverNewChannelsForScope,
  removeChannelFromSite
} from './scripts/grab-and-prune'
import { Channel } from './scripts/models'

const PORT = Number(process.env.PORT) || 3000
const PUBLIC_DIR = path.resolve(__dirname, 'public')
const GUIDE_OUTPUT_PATH = path.resolve('guide.xml')
const DEFAULT_GITHUB_REPO = process.env.GITHUB_REPO || 'iptv-org/epg'
const DEFAULT_GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'master'

const liveLogs: string[] = []
const systemErrors: AppErrorRecord[] = []
let isGrabbing = false
let isValidating = false
let isSyncing = false
let validationProgress: ValidationProgress | null = null
let validationAbortController: AbortController | null = null
let activeGrabProcess: ChildProcess | null = null
let grabStopRequested = false
let lastValidationReport: SiteValidationReport[] | null = null
let lastValidationError: string | null = null
let lastGrabSummary: ApplyGrabResult | null = null

function addLog(msg: string) {
  const timestamp = new Date().toLocaleTimeString()
  const line = `[${timestamp}] ${msg}`
  console.log(line)
  liveLogs.push(line)
  if (liveLogs.length > 500) liveLogs.shift()
}

function pushErrorRecords(records: AppErrorRecord[], replaceSource?: AppErrorRecord['source']) {
  if (replaceSource) {
    for (let i = systemErrors.length - 1; i >= 0; i--) {
      if (systemErrors[i].source === replaceSource) {
        systemErrors.splice(i, 1)
      }
    }
  }
  for (const rec of records) {
    const isDup = systemErrors.some(
      existing =>
        existing.site === rec.site &&
        existing.site_id === rec.site_id &&
        existing.message === rec.message
    )
    if (!isDup) {
      systemErrors.unshift(rec)
    }
  }
  if (systemErrors.length > 1000) {
    systemErrors.length = 1000
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > 1024 * 1024) {
        reject(new Error('İstek gövdesi çok büyük'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(raw)
        resolve(typeof parsed === 'object' && parsed !== null ? parsed : {})
      } catch {
        reject(new Error('Geçersiz JSON formatı'))
      }
    })

    req.on('error', err => reject(err))
  })
}

function parseStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const cleaned = value.map(v => String(v).trim()).filter(Boolean)
    return cleaned.length > 0 ? cleaned : undefined
  }
  if (typeof value === 'string') {
    const cleaned = value
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
    return cleaned.length > 0 ? cleaned : undefined
  }
  return undefined
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

const server = http.createServer(async (req, res) => {
  let parsedUrl: URL
  try {
    const host = req.headers.host || `localhost:${PORT}`
    parsedUrl = new URL(req.url || '/', `http://${host}`)
  } catch {
    sendJson(res, 400, { error: 'Geçersiz URL' })
    return
  }

  const pathname = parsedUrl.pathname

  // API: Status
  if (pathname === '/api/status' && req.method === 'GET') {
    try {
      const langParam = parsedUrl.searchParams.get('lang')
      const langFilter = langParam
        ? langParam
            .split(',')
            .map(l => l.trim())
            .filter(Boolean)
        : undefined
      const summary = getAllSitesSummary(langFilter)

      sendJson(res, 200, {
        siteCount: summary.sites.length,
        totalChannels: summary.totalChannels,
        languageCount: summary.languageCount,
        sites: summary.sites,
        isGrabbing,
        isValidating,
        isSyncing,
        validationProgress,
        errorCount: systemErrors.length,
        hasGuide: fs.existsSync(GUIDE_OUTPUT_PATH),
        githubRepo: DEFAULT_GITHUB_REPO,
        githubBranch: DEFAULT_GITHUB_BRANCH
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: message })
    }
    return
  }

  // API: Available World Languages
  if (pathname === '/api/languages' && req.method === 'GET') {
    try {
      const languages = getAvailableLanguages()
      sendJson(res, 200, {
        languages,
        githubRepo: DEFAULT_GITHUB_REPO,
        githubBranch: DEFAULT_GITHUB_BRANCH
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: message })
    }
    return
  }

  // API: Errors Center
  if (pathname === '/api/errors' && req.method === 'GET') {
    sendJson(res, 200, { errors: systemErrors })
    return
  }

  if (pathname === '/api/errors/clear' && req.method === 'POST') {
    systemErrors.length = 0
    sendJson(res, 200, { success: true })
    return
  }

  if (pathname === '/api/errors/dismiss' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req)
      const site = typeof body.site === 'string' ? body.site.trim() : ''
      const category = typeof body.category === 'string' ? body.category.trim() : ''
      const message = typeof body.message === 'string' ? body.message : ''

      for (let i = systemErrors.length - 1; i >= 0; i--) {
        const err = systemErrors[i]
        if (
          (!site || err.site === site) &&
          (!category || err.category === category) &&
          (!message || err.message === message)
        ) {
          systemErrors.splice(i, 1)
        }
      }
      sendJson(res, 200, { success: true, remaining: systemErrors.length })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      sendJson(res, 400, { error: msg })
    }
    return
  }

  // API: Remove broken channel from site XML
  if (pathname === '/api/sites/remove-channel' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req)
      const site = typeof body.site === 'string' ? body.site.trim() : ''
      const siteId = typeof body.site_id === 'string' ? body.site_id.trim() : ''
      const lang = typeof body.lang === 'string' ? body.lang.trim() : undefined

      if (!site || !/^[a-zA-Z0-9.-]+$/.test(site) || !siteId) {
        sendJson(res, 400, { error: 'Geçersiz site veya kanal kimliği' })
        return
      }

      const result = removeChannelFromSite(site, siteId, lang)
      // Remove matching errors from active list
      for (let i = systemErrors.length - 1; i >= 0; i--) {
        if (systemErrors[i].site === site && systemErrors[i].site_id === siteId) {
          systemErrors.splice(i, 1)
        }
      }
      addLog(`[Hata Çözümü] [${site}] ${siteId} kanalı listeden çıkarıldı.`)
      sendJson(res, 200, { success: true, ...result })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: message })
    }
    return
  }

  // API: Site Channels Detail
  if (pathname.startsWith('/api/site-channels/') && req.method === 'GET') {
    const rawSiteName = pathname.slice('/api/site-channels/'.length)
    let siteName = ''
    try {
      siteName = decodeURIComponent(rawSiteName)
    } catch {
      sendJson(res, 400, { error: 'Geçersiz site adı' })
      return
    }

    if (!/^[a-zA-Z0-9.-]+$/.test(siteName)) {
      sendJson(res, 400, { error: 'Geçersiz site adı' })
      return
    }

    const baseDir = path.resolve(SITES_DIR)
    const siteDir = path.resolve(baseDir, siteName)
    if (!siteDir.startsWith(baseDir + path.sep) || !fs.existsSync(siteDir)) {
      sendJson(res, 404, { error: 'Site bulunamadı' })
      return
    }

    try {
      const langParam = parsedUrl.searchParams.get('lang')
      const langFilter = langParam
        ? langParam
            .split(',')
            .map(l => l.trim())
            .filter(Boolean)
        : undefined
      const channels = getSiteChannels(siteName, langFilter)
      sendJson(res, 200, { site: siteName, channels })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 500, { error: message })
    }
    return
  }

  // API: Sync/Upgrade World Sites from GitHub (iptv-org/epg)
  if (pathname === '/api/sites/sync' && req.method === 'POST') {
    if (isSyncing) {
      sendJson(res, 409, { error: 'Siteleri yükseltme işlemi zaten devam ediyor.' })
      return
    }

    isSyncing = true
    try {
      addLog('Dünya siteleri GitHub üzerinden yükseltiliyor...')
      const result = await syncSitesFromUpstream(msg => addLog(msg))
      sendJson(res, 200, result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      addLog(`[HATA] Site yükseltme hatası: ${message}`)
      pushErrorRecords([createErrorRecord({ source: 'sync', site: 'github', message })])
      sendJson(res, 500, { error: message })
    } finally {
      isSyncing = false
    }
    return
  }

  // API: Stop active channel validation
  if ((pathname === '/api/check-new/stop' || pathname === '/api/check-new/cancel') && req.method === 'POST') {
    if (!isValidating || !validationAbortController) {
      sendJson(res, 200, { success: false, message: 'Aktif doğrulama işlemi yok.' })
      return
    }
    validationAbortController.abort()
    addLog('Doğrulama işlemini durdurma talebi alındı. Açık siteler tamamlanıp kapatılıyor...')
    sendJson(res, 200, { success: true, message: 'Durdurma sinyali gönderildi.' })
    return
  }

  // API: Validate & Prune Channels / Sites (Background execution to prevent HTTP proxy timeouts)
  if (pathname === '/api/check-new' && (req.method === 'GET' || req.method === 'POST')) {
    if (isValidating) {
      sendJson(res, 409, { error: 'Doğrulama işlemi zaten devam ediyor.' })
      return
    }

    let body: Record<string, unknown> = {}
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        sendJson(res, 400, { error: message })
        return
      }
    }

    const sites =
      parseStringArray(body.sites) || parseStringArray(parsedUrl.searchParams.get('sites'))
    const langs =
      parseStringArray(body.langs) || parseStringArray(parsedUrl.searchParams.get('langs'))
    const verifyEpg =
      typeof body.verifyEpg === 'boolean'
        ? body.verifyEpg
        : parsedUrl.searchParams.get('verifyEpg') !== 'false'
    const rawMode =
      typeof body.mode === 'string'
        ? body.mode
        : parsedUrl.searchParams.get('mode') || 'fast'
    const mode: ValidationMode = rawMode === 'full' ? 'full' : 'fast'
    const maxVerifyPerSite =
      typeof body.maxVerifyPerSite === 'number'
        ? body.maxVerifyPerSite
        : Number(parsedUrl.searchParams.get('maxVerifyPerSite')) || 0
    const concurrency =
      typeof body.concurrency === 'number'
        ? body.concurrency
        : Number(parsedUrl.searchParams.get('concurrency')) || 12
    const siteConcurrency =
      typeof body.siteConcurrency === 'number'
        ? body.siteConcurrency
        : Number(parsedUrl.searchParams.get('siteConcurrency')) || 4

    isValidating = true
    lastValidationReport = null
    lastValidationError = null
    validationAbortController = new AbortController()
    validationProgress = null

    addLog(
      `Kanal doğrulama başlatıldı (Mod: ${mode === 'full' ? 'Tam' : 'Hızlı'} | Canlı EPG: ${verifyEpg ? 'Açık (ilk 2 program)' : 'Kapalı'})...`
    )

    // Respond immediately so long-running validation never hits Cloud Run/reverse proxy 504 timeouts
    sendJson(res, 200, {
      success: true,
      started: true,
      message: 'Kanal doğrulama arkaplanda başlatıldı. İlerleme ve sonuçlar canlı olarak güncellenecek.'
    })

    const controller = validationAbortController
    void (async () => {
      try {
        const report = await validateAndPrune({
          sites,
          langs,
          verifyEpg,
          mode,
          concurrency,
          siteConcurrency,
          maxVerifyPerSite,
          signal: controller.signal,
          onProgress: (msg, stats) => {
            if (stats) validationProgress = stats
            addLog(msg)
          }
        })

        lastValidationReport = report

        const extractedErrors: AppErrorRecord[] = []
        for (const item of report) {
          if (item.status === 'error' && item.error) {
            extractedErrors.push(
              createErrorRecord({
                source: 'validate',
                site: item.site,
                message: item.error
              })
            )
          } else if (item.status === 'warning' && item.reason) {
            extractedErrors.push(
              createErrorRecord({
                source: 'validate',
                site: item.site,
                message: item.reason
              })
            )
          }
        }
        if (extractedErrors.length > 0) {
          pushErrorRecords(extractedErrors)
        }

        addLog(
          controller.signal.aborted
            ? 'Kanal doğrulama kullanıcı tarafından durduruldu.'
            : 'Kanal doğrulama ve araştırma tamamlandı.'
        )
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        lastValidationError = message
        addLog(`[HATA] Doğrulama hatası: ${message}`)
        pushErrorRecords([createErrorRecord({ source: 'validate', site: 'genel', message })])
      } finally {
        isValidating = false
        validationAbortController = null
      }
    })()
    return
  }

  // API: Get Live Logs + Current Job Results + Errors
  if (pathname === '/api/logs' && req.method === 'GET') {
    sendJson(res, 200, {
      logs: liveLogs,
      isGrabbing,
      isValidating,
      isSyncing,
      validationProgress,
      lastValidationReport,
      lastValidationError,
      lastGrabSummary,
      errors: systemErrors,
      errorCount: systemErrors.length
    })
    return
  }

  // API: Download generated guide.xml
  if (pathname === '/api/guide' && req.method === 'GET') {
    if (!fs.existsSync(GUIDE_OUTPUT_PATH)) {
      sendJson(res, 404, { error: 'Henüz oluşturulmuş guide.xml bulunamadı.' })
      return
    }

    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="guide.xml"'
    })
    fs.createReadStream(GUIDE_OUTPUT_PATH).pipe(res)
    return
  }

  // API: Stop active EPG Grab
  if ((pathname === '/api/grab/stop' || pathname === '/api/grab/cancel') && req.method === 'POST') {
    if (!isGrabbing) {
      sendJson(res, 200, { success: false, message: 'Aktif EPG çekme işlemi yok.' })
      return
    }
    grabStopRequested = true
    if (activeGrabProcess) {
      activeGrabProcess.kill('SIGTERM')
    }
    addLog('EPG çekme işlemini durdurma sinyali gönderildi.')
    sendJson(res, 200, { success: true, message: 'EPG çekme durduruluyor...' })
    return
  }

  // API: Grab EPG + Unified Discovery & Post-Grab Pruning
  if (pathname === '/api/grab' && req.method === 'POST') {
    if (isGrabbing) {
      sendJson(res, 409, { error: 'EPG çekme işlemi zaten çalışıyor.' })
      return
    }

    let body: Record<string, unknown> = {}
    try {
      body = await readJsonBody(req)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      sendJson(res, 400, { error: message })
      return
    }

    const langs = parseStringArray(body.langs)
    const sites = parseStringArray(body.sites)
    const skipEmpty = body.skipEmpty !== false
    const discoverAndPrune = body.discoverAndPrune !== false
    const days = typeof body.days === 'number' && body.days > 0 ? Math.min(body.days, 7) : null

    isGrabbing = true
    grabStopRequested = false
    lastGrabSummary = null

    const langSummary = langs ? langs.map(l => l.toUpperCase()).join(', ') : 'Tüm Diller'
    addLog(
      `[${langSummary}] EPG veri çekme başlatıldı${discoverAndPrune ? ' (Yeni kanal keşfi + çekim sonrası 0 içerik temizliği açık)' : ''}...`
    )

    sendJson(res, 200, {
      success: true,
      started: true,
      message: `${langSummary} için EPG çekme süreci arkaplanda başlatıldı.`
    })

    const tempChannelsPath = path.resolve('temp_all.channels.xml')
    const tempReportPath = path.resolve('temp_grab_report.json')

    void (async () => {
      let newCandidates: Channel[] = []
      try {
        let discoveryErrors: AppErrorRecord[] = []
        if (discoverAndPrune) {
          const discovered = await discoverNewChannelsForScope({
            langs,
            sites,
            onProgress: msg => addLog(msg)
          })
          newCandidates = discovered.candidates
          discoveryErrors = discovered.errors
        }

        if (grabStopRequested) {
          isGrabbing = false
          addLog('EPG çekme işlemi durduruldu.')
          return
        }

        const count = generateCombinedChannelsXML(tempChannelsPath, {
          langs,
          sites,
          extraChannels: newCandidates
        })

        if (count === 0) {
          if (fs.existsSync(tempChannelsPath)) fs.unlinkSync(tempChannelsPath)
          isGrabbing = false
          addLog('[HATA] Seçilen diller/siteler için EPG çekilecek kanal bulunamadı.')
          return
        }

        addLog(
          `[${langSummary}] ${count} kanal (${newCandidates.length} yeni aday dahil) için yayın akışı indiriliyor...`
        )

        const grabArgs = [
          '-r',
          '@swc-node/register',
          'scripts/commands/epg/grab.ts',
          '--channels',
          tempChannelsPath,
          '-o',
          GUIDE_OUTPUT_PATH,
          '--maxConnections',
          '8',
          '--report',
          tempReportPath
        ]
        if (skipEmpty) {
          grabArgs.push('--skip-empty')
        }
        if (days) {
          grabArgs.push('--days', String(days))
        }

        const grabProcess = spawn(process.execPath, grabArgs, { shell: false })
        activeGrabProcess = grabProcess

        grabProcess.stdout.on('data', (data: Buffer) => {
          const lines = data.toString().split(/\r?\n/)
          for (const rawLine of lines) {
            const text = rawLine.trim()
            if (text) addLog(text)
          }
        })

        grabProcess.stderr.on('data', (data: Buffer) => {
          const text = data.toString().trim()
          if (text) {
            addLog(`[HATA] ${text}`)
            pushErrorRecords([createErrorRecord({ source: 'grab', site: 'epg-grab', message: text })])
          }
        })

        grabProcess.on('error', err => {
          activeGrabProcess = null
          isGrabbing = false
          if (fs.existsSync(tempChannelsPath)) fs.unlinkSync(tempChannelsPath)
          if (fs.existsSync(tempReportPath)) fs.unlinkSync(tempReportPath)
          addLog(`[HATA] Süreç başlatılamadı: ${err.message}`)
          pushErrorRecords([createErrorRecord({ source: 'grab', site: 'epg-grab', message: err.message })])
        })

        grabProcess.on('close', code => {
          activeGrabProcess = null
          try {
            if (!grabStopRequested && fs.existsSync(tempReportPath)) {
              const applyRes = applyGrabResultsToSites({
                grabReportPath: tempReportPath,
                newCandidates,
                pruneEmptyExisting: discoverAndPrune,
                onProgress: msg => addLog(msg)
              })
              lastGrabSummary = applyRes
              const allGrabErrors = [...discoveryErrors, ...applyRes.errors]
              pushErrorRecords(allGrabErrors, 'grab')
              addLog(
                `[Otomatik Doğrulama & Temizlik] +${applyRes.addedCount} yeni kanal eklendi | -${applyRes.removedCount} ölü kanal silindi | ${applyRes.skippedNoEpgCount} boş aday reddedildi | ${applyRes.errors.length} aktif kanal hatası kaydedildi.`
              )
            }
          } catch (applyErr: unknown) {
            const msg = applyErr instanceof Error ? applyErr.message : String(applyErr)
            addLog(`[HATA] Çekim sonrası temizlik hatası: ${msg}`)
          } finally {
            isGrabbing = false
            if (fs.existsSync(tempChannelsPath)) fs.unlinkSync(tempChannelsPath)
            if (fs.existsSync(tempReportPath)) fs.unlinkSync(tempReportPath)
            addLog(
              grabStopRequested
                ? 'EPG çekme işlemi kullanıcı tarafından durduruldu.'
                : `EPG çekme süreci tamamlandı (çıkış kodu: ${code}). Kaydedilen dosya: ${GUIDE_OUTPUT_PATH}`
            )
          }
        })
      } catch (err: unknown) {
        activeGrabProcess = null
        isGrabbing = false
        if (fs.existsSync(tempChannelsPath)) fs.unlinkSync(tempChannelsPath)
        if (fs.existsSync(tempReportPath)) fs.unlinkSync(tempReportPath)
        const message = err instanceof Error ? err.message : String(err)
        addLog(`[HATA] ${message}`)
        pushErrorRecords([createErrorRecord({ source: 'grab', site: 'epg-grab', message })])
      }
    })()
    return
  }

  // Static files (HTML, CSS, JS) with path traversal guard
  const safeRelativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const filePath = path.resolve(PUBLIC_DIR, safeRelativePath)

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('403 Forbidden')
    return
  }

  const extname = path.extname(filePath).toLowerCase()
  const contentType = MIME_TYPES[extname] || 'application/octet-stream'

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('404 Not Found')
    } else {
      res.writeHead(200, { 'Content-Type': contentType })
      res.end(content)
    }
  })
})

server.listen(PORT, () => {
  console.log('========================================')
  console.log(' EPG IPTV Arayüzü çalışıyor:')
  console.log(` http://localhost:${PORT}`)
  console.log('========================================')
})
