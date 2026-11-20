import fs from 'fs'
import path from 'path'
import pLimit from 'p-limit'
import epgGrabber, { EPGGrabber } from 'epg-grabber'
import { Collection } from '@freearhey/core'
import axios from 'axios'

axios.defaults.validateStatus = status => (status >= 200 && status < 300) || status === 403 || status === 404
axios.interceptors.response.use(
  response => {
    if (response.status === 403 || response.status === 404) {
      console.warn(`[Axios Warning] Status ${response.status} for URL: ${response.config.url}`)
      response.data = ''
    }
    return response
  },
  error => {
    console.error(`[Axios Error Caught & Skipped] URL: ${error.config?.url || 'unknown'} | Status: ${error.response?.status || 'N/A'} | Message: ${error.message}`)
    return Promise.resolve({ status: error.response?.status || 500, data: '' })
  }
)
import { SITES_DIR } from './constants'
import { loadJs, generateChannelsXML } from './core'
import { Channel } from './models'
import { invalidateSitesCache, normalizeChannelName } from './site-channels'
import { AppErrorRecord, createErrorRecord } from './error-diagnostics'

interface OnlineChannel {
  site_id?: string | number
  name?: string
  lang?: string
  xmltv_id?: string
  logo?: string | null
  url?: string | null
  lcn?: string | null
}

interface SiteConfigModule extends Omit<epgGrabber.Types.SiteConfig, 'channels'> {
  channels?: (args: Record<string, string>) => OnlineChannel[] | Promise<OnlineChannel[]>
}

export interface GrabChannelReportItem {
  site: string
  site_id: string
  xmltv_id: string
  name: string
  lang: string
  programCount: number
  error: string | null
}

export interface ApplyGrabResult {
  addedCount: number
  removedCount: number
  skippedNoEpgCount: number
  addedChannels: string[]
  removedChannels: string[]
  errors: AppErrorRecord[]
}

const DISCOVER_TIMEOUT_MS = 10000

function listXmlFilesRecursive(dir: string): string[] {
  const results: string[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__data__') {
        results.push(...listXmlFilesRecursive(fullPath))
      }
    } else if (entry.name.endsWith('.channels.xml')) {
      results.push(fullPath)
    }
  }
  return results
}

export async function discoverNewChannelsForScope(options: {
  langs?: string[]
  sites?: string[]
  onProgress?: (msg: string) => void
}): Promise<{ candidates: Channel[]; errors: AppErrorRecord[] }> {
  const allowedLangs =
    options.langs && options.langs.length > 0
      ? new Set(options.langs.map(l => l.trim().toLowerCase()).filter(Boolean))
      : null
  const allowedSites =
    options.sites && options.sites.length > 0
      ? new Set(options.sites.map(s => s.trim()).filter(Boolean))
      : null

  const allSites = fs.readdirSync(SITES_DIR).sort()
  const targetSites: { site: string; sitePath: string; configFile: string; existingKeys: Set<string> }[] = []

  for (const site of allSites) {
    if (allowedSites && !allowedSites.has(site)) continue
    const sitePath = path.join(SITES_DIR, site)
    if (!fs.existsSync(sitePath) || !fs.statSync(sitePath).isDirectory()) continue

    const files = fs.readdirSync(sitePath)
    const configFile = files.find(f => f.endsWith('.config.js'))
    const xmlFiles = listXmlFilesRecursive(sitePath)
    if (!configFile || xmlFiles.length === 0) continue

    const existingKeys = new Set<string>()
    let hasMatchingLang = false

    for (const xmlPath of xmlFiles) {
      const parsed = EPGGrabber.parseChannelsXML(fs.readFileSync(xmlPath, 'utf8'))
      for (const ch of parsed) {
        const lang = (ch.lang || '').toLowerCase()
        if (ch.site_id && lang) {
          existingKeys.add(`${lang}:${ch.site_id}`)
        }
        if (allowedLangs && allowedLangs.has(lang)) {
          hasMatchingLang = true
        }
      }
    }

    if (allowedLangs && !allowedSites && !hasMatchingLang) continue
    targetSites.push({ site, sitePath, configFile, existingKeys })
  }

  const candidates: Channel[] = []
  const errors: AppErrorRecord[] = []
  const limit = pLimit(4)

  if (targetSites.length > 0) {
    options.onProgress?.(
      `${targetSites.length} ilgili sitede yeni kanallar araştırılıyor...`
    )
  }

  await Promise.all(
    targetSites.map(entry =>
      limit(async () => {
        const { site, sitePath, configFile, existingKeys } = entry
        try {
          const configPath = path.resolve(sitePath, configFile)
          const resolvedPath = require.resolve(configPath)
          Reflect.deleteProperty(require.cache, resolvedPath)
          const config = (await loadJs(configPath)) as SiteConfigModule

          if (typeof config.channels !== 'function') return

          const args: Record<string, string> = {}
          if (site === 'dazn.com') {
            if (allowedLangs && allowedLangs.size === 1) {
              const onlyLang = Array.from(allowedLangs)[0]
              args.country = onlyLang === 'en' ? 'gb' : onlyLang
              args.lang = onlyLang
            } else {
              args.country = 'de'
              args.lang = 'de'
            }
          }

          let timer: NodeJS.Timeout | undefined
          let online: OnlineChannel[] = []
          try {
            const timeoutPromise = new Promise<OnlineChannel[]>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Kanal listesi zaman aşımı')), DISCOVER_TIMEOUT_MS)
            })
            const res = await Promise.race([Promise.resolve(config.channels(args)), timeoutPromise])
            if (Array.isArray(res)) online = res
          } finally {
            if (timer) clearTimeout(timer)
          }

          let foundForSite = 0
          for (const ch of online) {
            if (!ch.site_id) continue
            const siteId = String(ch.site_id)
            const lang = (ch.lang || '').toLowerCase()
            if (!lang) continue
            if (allowedLangs && !allowedLangs.has(lang)) continue
            const key = `${lang}:${siteId}`
            if (existingKeys.has(key)) continue

            const rawName = ch.name || ''
            const normKey = normalizeChannelName(rawName) || siteId
            if (normKey.includes('test') || normKey.includes('dummy')) continue

            existingKeys.add(key)
            candidates.push(
              new Channel({
                xmltv_id: ch.xmltv_id || siteId,
                name: rawName,
                site_id: siteId,
                lang,
                site,
                logo: ch.logo || null,
                url: ch.url || null,
                lcn: ch.lcn || null,
                index: -1
              })
            )
            foundForSite++
          }

          if (foundForSite > 0) {
            options.onProgress?.(`[Keşif] [${site}] ${foundForSite} yeni kanal adayı bulundu (EPG çekiminde test edilecek).`)
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          errors.push(
            createErrorRecord({
              source: 'grab',
              site,
              message
            })
          )
        }
      })
    )
  )

  return { candidates, errors }
}

export function applyGrabResultsToSites(options: {
  grabReportPath: string
  newCandidates: Channel[]
  pruneEmptyExisting: boolean
  onProgress?: (msg: string) => void
}): ApplyGrabResult {
  if (!fs.existsSync(options.grabReportPath)) {
    return {
      addedCount: 0,
      removedCount: 0,
      skippedNoEpgCount: 0,
      addedChannels: [],
      removedChannels: [],
      errors: []
    }
  }

  const raw = JSON.parse(fs.readFileSync(options.grabReportPath, 'utf8')) as {
    channels?: GrabChannelReportItem[]
  }
  const items = Array.isArray(raw.channels) ? raw.channels : []

  const itemsBySite = new Map<string, GrabChannelReportItem[]>()
  for (const item of items) {
    if (!item.site) continue
    const arr = itemsBySite.get(item.site) || []
    arr.push(item)
    itemsBySite.set(item.site, arr)
  }

  const candidateKeys = new Set<string>(
    options.newCandidates.map(c => `${c.site}|${(c.lang || '').toLowerCase()}|${c.site_id}`)
  )
  const candidatesBySite = new Map<string, Channel[]>()
  for (const c of options.newCandidates) {
    const arr = candidatesBySite.get(c.site) || []
    arr.push(c)
    candidatesBySite.set(c.site, arr)
  }

  const addedChannels: string[] = []
  const removedChannels: string[] = []
  const errors: AppErrorRecord[] = []
  let skippedNoEpgCount = 0

  for (const [site, siteItems] of itemsBySite.entries()) {
    const sitePath = path.join(SITES_DIR, site)
    if (!fs.existsSync(sitePath)) continue
    const xmlFiles = listXmlFilesRecursive(sitePath)
    if (xmlFiles.length === 0) continue

    const resultMap = new Map<string, GrabChannelReportItem>()
    let anySuccess = false

    for (const it of siteItems) {
      const key = `${it.site}|${(it.lang || '').toLowerCase()}|${it.site_id}`
      resultMap.set(key, it)
      if (it.programCount > 0) anySuccess = true
    }

    const siteCandidates = candidatesBySite.get(site) || []
    const workingNewChannels: Channel[] = []

    for (const cand of siteCandidates) {
      const key = `${cand.site}|${(cand.lang || '').toLowerCase()}|${cand.site_id}`
      const resItem = resultMap.get(key)
      if (resItem && resItem.programCount > 0) {
        workingNewChannels.push(cand)
        addedChannels.push(`${site}: ${cand.name || cand.site_id} (${resItem.programCount} program)`)
      } else {
        skippedNoEpgCount++
        if (resItem && resItem.error && !resItem.error.includes('404') && !resItem.error.includes('410')) {
          errors.push(
            createErrorRecord({
              source: 'grab',
              site: resItem.site,
              channel: resItem.name || resItem.site_id,
              site_id: resItem.site_id,
              lang: resItem.lang,
              message: resItem.error
            })
          )
        }
      }
    }

    let siteModified = false
    const prunedKeys = new Set<string>()

    xmlFiles.forEach((xmlPath, fileIdx) => {
      const parsed = EPGGrabber.parseChannelsXML(fs.readFileSync(xmlPath, 'utf8'))
      const kept: Channel[] = []
      const seenKeys = new Set<string>()
      let fileChanged = false

      for (const ch of parsed) {
        const lang = (ch.lang || '').toLowerCase()
        const key = `${site}|${lang}|${ch.site_id}`
        if (seenKeys.has(key)) {
          fileChanged = true
          continue
        }
        seenKeys.add(key)

        const grabbedItem = resultMap.get(key)
        if (
          options.pruneEmptyExisting &&
          grabbedItem &&
          !candidateKeys.has(key) &&
          grabbedItem.programCount === 0
        ) {
          const isExplicitNotFound =
            Boolean(grabbedItem.error) &&
            (grabbedItem.error?.includes('404') || grabbedItem.error?.includes('410'))
          const isCleanEmpty = !grabbedItem.error && anySuccess

          if (isCleanEmpty || isExplicitNotFound) {
            removedChannels.push(`${site}: ${ch.name || ch.site_id}`)
            prunedKeys.add(key)
            fileChanged = true
            continue
          }
        }

        kept.push(
          new Channel({
            xmltv_id: ch.xmltv_id || ch.site_id,
            name: ch.name,
            site_id: ch.site_id,
            lang,
            site,
            logo: ch.logo || null,
            url: ch.url || null,
            lcn: ch.lcn || null,
            index: -1
          })
        )
      }

      if (fileIdx === 0 && workingNewChannels.length > 0) {
        for (const newCh of workingNewChannels) {
          const key = `${site}|${(newCh.lang || '').toLowerCase()}|${newCh.site_id}`
          if (!seenKeys.has(key)) {
            seenKeys.add(key)
            kept.push(newCh)
            fileChanged = true
          }
        }
      }

      if (fileChanged && kept.length > 0) {
        const updatedXml = generateChannelsXML(new Collection(kept))
        fs.writeFileSync(xmlPath, updatedXml, 'utf8')
        siteModified = true
      }
    })

    for (const it of siteItems) {
      const key = `${it.site}|${(it.lang || '').toLowerCase()}|${it.site_id}`
      if (prunedKeys.has(key) || candidateKeys.has(key)) continue

      if (it.error) {
        errors.push(
          createErrorRecord({
            source: 'grab',
            site: it.site,
            channel: it.name || it.site_id,
            site_id: it.site_id,
            lang: it.lang,
            message: it.error
          })
        )
      } else if (it.programCount === 0) {
        errors.push(
          createErrorRecord({
            source: 'grab',
            site: it.site,
            channel: it.name || it.site_id,
            site_id: it.site_id,
            lang: it.lang,
            message: '0 program döndü (yayın akışı boş)'
          })
        )
      }
    }

    if (siteModified) {
      options.onProgress?.(`[Temizlik & Güncelleme] [${site}] XML kanalları güncellendi.`)
    }
  }

  invalidateSitesCache()

  return {
    addedCount: addedChannels.length,
    removedCount: removedChannels.length,
    skippedNoEpgCount,
    addedChannels,
    removedChannels,
    errors
  }
}

export function removeChannelFromSite(
  siteName: string,
  siteId: string,
  lang?: string
): { removed: boolean; remaining: number } {
  const sitePath = path.resolve(SITES_DIR, siteName)
  if (!fs.existsSync(sitePath)) return { removed: false, remaining: 0 }

  const xmlFiles = listXmlFilesRecursive(sitePath)
  let removed = false
  let totalRemaining = 0
  const targetLang = lang ? lang.toLowerCase() : null

  for (const xmlPath of xmlFiles) {
    const parsed = EPGGrabber.parseChannelsXML(fs.readFileSync(xmlPath, 'utf8'))
    const kept: Channel[] = []

    for (const ch of parsed) {
      const chLang = (ch.lang || '').toLowerCase()
      const matchesId = ch.site_id === siteId
      const matchesLang = !targetLang || chLang === targetLang
      if (matchesId && matchesLang) {
        removed = true
        continue
      }
      kept.push(
        new Channel({
          xmltv_id: ch.xmltv_id || ch.site_id,
          name: ch.name,
          site_id: ch.site_id,
          lang: chLang,
          site: siteName,
          logo: ch.logo || null,
          url: ch.url || null,
          lcn: ch.lcn || null,
          index: -1
        })
      )
    }

    totalRemaining += kept.length
    if (removed && kept.length > 0) {
      const updatedXml = generateChannelsXML(new Collection(kept))
      fs.writeFileSync(xmlPath, updatedXml, 'utf8')
    }
  }

  if (removed) {
    invalidateSitesCache()
  }

  return { removed, remaining: totalRemaining }
}
