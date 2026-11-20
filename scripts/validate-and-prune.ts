import fs from 'fs'
import path from 'path'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import pLimit from 'p-limit'
import epgGrabber, { EPGGrabber } from 'epg-grabber'
import { Collection } from '@freearhey/core'
import { SITES_DIR } from './constants'
import defaultConfig from './default.config'
import { loadJs, generateChannelsXML } from './core'
import { Channel } from './models'
import { invalidateSitesCache, normalizeChannelName } from './site-channels'

dayjs.extend(utc)

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

export type ValidationMode = 'fast' | 'full'

export interface ValidationProgress {
  phase: 'scanning' | 'completed' | 'cancelled'
  completedSites: number
  totalSites: number
  checkedChannels: number
  totalChannels: number
  currentSite: string
  addedCount: number
  removedCount: number
  skippedNoEpgCount: number
  elapsedMs: number
}

export interface ValidateAndPruneOptions {
  sites?: string[]
  langs?: string[]
  verifyEpg?: boolean
  mode?: ValidationMode
  concurrency?: number
  siteConcurrency?: number
  maxVerifyPerSite?: number
  deepCheck?: boolean
  signal?: AbortSignal
  onProgress?: (msg: string, stats?: ValidationProgress) => void
}

export interface SiteValidationReport {
  site: string
  status: 'ok' | 'warning' | 'error'
  reason?: string
  error?: string
  totalChannels?: number
  addedCount?: number
  removedCount?: number
  skippedNoEpgCount?: number
  addedChannels?: string[]
  removedChannels?: string[]
}

const CHANNEL_FETCH_TIMEOUT_MS = 12000
const EPG_VERIFY_TIMEOUT_MS = 8000
const FAST_MODE_EXISTING_SAMPLE = 10
const MAX_RESPONSE_CACHE_ENTRIES = 200
const FIRST_PROGRAMS_CHECK_LIMIT = 2

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

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('base64')
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => stableSerialize(v)).join(',')}]`
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map(k => `${k}:${stableSerialize(obj[k])}`).join(',')}}`
  }
  return ''
}

function installCoalescingClientCache(grabber: EPGGrabber, signal?: AbortSignal): void {
  const client = grabber.client
  const originalSend = client.sendRequest.bind(client)
  const inflight = new Map<string, Promise<epgGrabber.Types.ClientResponse>>()
  const responseCache = new Map<string, epgGrabber.Types.ClientResponse>()

  client.sendRequest = async request => {
    if (signal?.aborted) {
      throw new Error('Doğrulama kullanıcı tarafından durduruldu')
    }

    const method = String(request.method || 'GET').toUpperCase()
    const url = String(request.url || '')
    const dataKey = stableSerialize(request.data)
    const headersKey = stableSerialize(request.headers)
    const cacheKey = `${method}|${url}|${dataKey}|${headersKey}`

    const cached = responseCache.get(cacheKey)
    if (cached) {
      return {
        ...cached,
        cached: true
      }
    }

    const existingInflight = inflight.get(cacheKey)
    if (existingInflight) {
      const shared = await existingInflight
      return {
        ...shared,
        cached: true
      }
    }

    const requestPromise = (async () => {
      const res = await originalSend({
        ...request,
        signal
      })
      if (res && res.content && res.content.length > 0) {
        if (responseCache.size >= MAX_RESPONSE_CACHE_ENTRIES) {
          const oldestKey = responseCache.keys().next().value
          if (oldestKey !== undefined) {
            responseCache.delete(oldestKey)
          }
        }
        responseCache.set(cacheKey, res)
      }
      return res
    })()

    inflight.set(cacheKey, requestPromise)
    try {
      return await requestPromise
    } finally {
      inflight.delete(cacheKey)
    }
  }
}

async function fetchOnlineChannelsWithTimeout(
  site: string,
  config: SiteConfigModule,
  langsFilter: Set<string> | null,
  signal?: AbortSignal
): Promise<{ ok: boolean; channels: OnlineChannel[] }> {
  if (signal?.aborted || typeof config.channels !== 'function') {
    return { ok: false, channels: [] }
  }

  const args: Record<string, string> = {}
  if (site === 'dazn.com') {
    if (langsFilter && langsFilter.size === 1) {
      const onlyLang = Array.from(langsFilter)[0]
      args.country = onlyLang === 'en' ? 'gb' : onlyLang
      args.lang = onlyLang
    } else {
      args.country = 'de'
      args.lang = 'de'
    }
  }

  let timer: NodeJS.Timeout | undefined
  try {
    const channelPromise = Promise.resolve(config.channels(args))
    const timeoutPromise = new Promise<OnlineChannel[]>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Zaman aşımı')), CHANNEL_FETCH_TIMEOUT_MS)
    })

    const res = await Promise.race([channelPromise, timeoutPromise])
    if (Array.isArray(res) && res.length > 0) {
      return { ok: true, channels: res }
    }
    return { ok: false, channels: [] }
  } catch {
    return { ok: false, channels: [] }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

interface EpgCheckResult {
  hasPrograms: boolean
  programCount: number
  error: Error | null
  statusCode: number | null
}

async function checkChannelEpgLive(
  grabber: EPGGrabber,
  channel: Channel,
  config: SiteConfigModule,
  deepCheck: boolean,
  signal?: AbortSignal
): Promise<EpgCheckResult> {
  if (signal?.aborted) {
    return {
      hasPrograms: false,
      programCount: 0,
      error: new Error('Durduruldu'),
      statusCode: null
    }
  }

  const today = dayjs.utc()
  const datesToTry = deepCheck ? [today, today.add(1, 'd')] : [today]
  const originalParser = config.parser

  let lastError: Error | null = null
  let lastStatusCode: number | null = null

  for (const date of datesToTry) {
    if (signal?.aborted) break

    let grabError: Error | null = null
    let timer: NodeJS.Timeout | undefined
    let totalRawCount = 0

    try {
      const fastParser: epgGrabber.Types.SiteConfig['parser'] = async context => {
        if (!originalParser) return []
        const raw = await originalParser(context)
        if (!Array.isArray(raw)) return []
        const valid = raw.filter(Boolean)
        totalRawCount = valid.length
        return valid.slice(0, FIRST_PROGRAMS_CHECK_LIMIT)
      }

      const grabConfig: epgGrabber.Types.SiteConfig = {
        ...config,
        delay: 0,
        channels: undefined,
        parser: fastParser
      }

      const grabPromise = grabber.grab(
        channel,
        date,
        grabConfig,
        (_ctx: epgGrabber.Types.GrabCallbackContext, err: Error | null) => {
          if (err) grabError = err
        }
      )
      const timeoutPromise = new Promise<epgGrabber.Program[]>((_, reject) => {
        timer = setTimeout(() => reject(new Error('EPG zaman aşımı')), EPG_VERIFY_TIMEOUT_MS)
      })

      const programs = await Promise.race([grabPromise, timeoutPromise])
      if (Array.isArray(programs) && programs.length > 0) {
        return {
          hasPrograms: true,
          programCount: Math.max(programs.length, totalRawCount),
          error: null,
          statusCode: 200
        }
      }

      if (grabError) {
        lastError = grabError
        const maybeAxios = grabError as Error & { response?: { status?: number }; status?: number }
        lastStatusCode = maybeAxios.response?.status ?? maybeAxios.status ?? null
        break
      }
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const maybeAxios = lastError as Error & { response?: { status?: number }; status?: number }
      lastStatusCode = maybeAxios.response?.status ?? maybeAxios.status ?? null
      break
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  return {
    hasPrograms: false,
    programCount: 0,
    error: lastError,
    statusCode: lastStatusCode
  }
}

interface PreparedSiteInfo {
  site: string
  sitePath: string
  configFile: string | undefined
  xmlFiles: string[]
  fileEntries: { xmlPath: string; parsed: epgGrabber.Channel[] }[]
}

interface VerificationCandidate {
  fileIndex: number
  channel: Channel
  isNew: boolean
  rawName: string
}

export async function validateAndPrune(
  options: ValidateAndPruneOptions = {}
): Promise<SiteValidationReport[]> {
  const verifyEpg = options.verifyEpg !== false
  const mode: ValidationMode = options.mode === 'full' ? 'full' : 'fast'
  const concurrency = Math.max(1, options.concurrency || 12)
  const siteConcurrency = Math.max(1, options.siteConcurrency || 4)
  const maxVerifyPerSite = options.maxVerifyPerSite || 0
  const deepCheck = Boolean(options.deepCheck)
  const signal = options.signal

  const allowedLangs =
    options.langs && options.langs.length > 0
      ? new Set(options.langs.map(l => l.trim().toLowerCase()).filter(Boolean))
      : null
  const allowedSites =
    options.sites && options.sites.length > 0
      ? new Set(options.sites.map(s => s.trim()).filter(Boolean))
      : null

  const startTime = Date.now()
  const allSiteNames = fs.readdirSync(SITES_DIR).sort()
  const report: SiteValidationReport[] = []
  const preparedSites: PreparedSiteInfo[] = []

  // Phase 1: Fast local XML pre-scan so we know exact totalSites & filter languages immediately
  for (const site of allSiteNames) {
    if (allowedSites && !allowedSites.has(site)) continue
    const sitePath = path.join(SITES_DIR, site)
    if (!fs.existsSync(sitePath) || !fs.statSync(sitePath).isDirectory()) continue

    const files = fs.readdirSync(sitePath)
    const configFile = files.find(f => f.endsWith('.config.js'))
    const xmlFiles = listXmlFilesRecursive(sitePath)

    if (!configFile || xmlFiles.length === 0) {
      report.push({
        site,
        status: 'warning',
        reason: 'Eksik konfigürasyon veya channels.xml dosyası'
      })
      continue
    }

    const fileEntries = xmlFiles.map(xmlPath => {
      const xmlContent = fs.readFileSync(xmlPath, 'utf8')
      return {
        xmlPath,
        parsed: EPGGrabber.parseChannelsXML(xmlContent)
      }
    })

    if (allowedLangs && !allowedSites) {
      const hasMatchingLang = fileEntries.some(entry =>
        entry.parsed.some(ch => allowedLangs.has((ch.lang || '').toLowerCase()))
      )
      if (!hasMatchingLang) {
        continue
      }
    }

    preparedSites.push({
      site,
      sitePath,
      configFile,
      xmlFiles,
      fileEntries
    })
  }

  const totalSites = preparedSites.length
  let completedSites = 0
  let globalCheckedChannels = 0
  let globalTotalChannels = 0
  let globalAddedCount = 0
  let globalRemovedCount = 0
  let globalSkippedNoEpgCount = 0

  const emitProgress = (msg: string, currentSite: string, phase: ValidationProgress['phase'] = 'scanning') => {
    options.onProgress?.(msg, {
      phase,
      completedSites,
      totalSites,
      checkedChannels: globalCheckedChannels,
      totalChannels: globalTotalChannels,
      currentSite,
      addedCount: globalAddedCount,
      removedCount: globalRemovedCount,
      skippedNoEpgCount: globalSkippedNoEpgCount,
      elapsedMs: Date.now() - startTime
    })
  }

  if (totalSites === 0) {
    emitProgress('Seçilen filtrelere uygun site bulunamadı.', '-', 'completed')
    return report
  }

  emitProgress(
    `Toplam ${totalSites} site taranacak (Mod: ${mode === 'full' ? 'Tam Doğrulama' : 'Hızlı Doğrulama'}, Eşzamanlı Site: ${siteConcurrency}, Kanal: ${concurrency})...`,
    preparedSites[0].site
  )

  const grabber = new EPGGrabber({
    delay: 0,
    request: {
      ...defaultConfig.request,
      timeout: EPG_VERIFY_TIMEOUT_MS,
      cache: false
    }
  })
  installCoalescingClientCache(grabber, signal)

  const channelLimit = pLimit(concurrency)
  const siteLimit = pLimit(siteConcurrency)

  await Promise.all(
    preparedSites.map((siteInfo, idx) =>
      siteLimit(async () => {
        if (signal?.aborted) return

        const { site, sitePath, configFile, fileEntries } = siteInfo
        const sitePosition = `${idx + 1}/${totalSites}`

        try {
          if (!configFile) return
          const configPath = path.resolve(sitePath, configFile)
          const resolvedPath = require.resolve(configPath)
          Reflect.deleteProperty(require.cache, resolvedPath)
          const config = (await loadJs(configPath)) as SiteConfigModule

          if (typeof config.channels !== 'function' && typeof config.parser !== 'function') {
            report.push({
              site,
              status: 'warning',
              reason: 'Geçersiz konfigürasyon yapısı'
            })
            completedSites++
            return
          }

          emitProgress(`[Site ${sitePosition}] [${site}] Çevrimiçi kanal listesi kontrol ediliyor...`, site)

          const { ok: hasOnlineList, channels: onlineChannels } = await fetchOnlineChannelsWithTimeout(
            site,
            config,
            allowedLangs,
            signal
          )

          if (signal?.aborted) return

          const onlineSiteIds = new Set<string>()
          const onlineNormKeys = new Set<string>()
          onlineChannels.forEach(ch => {
            if (ch.site_id) onlineSiteIds.add(String(ch.site_id))
            const normKey = normalizeChannelName(ch.name || '')
            if (normKey) onlineNormKeys.add(normKey)
          })

          // Multi-file sites (e.g. abc.net.au_act, abc.net.au_mel) often have parameterized channels()
          // that only returns one default region; do not delete existing channels based on online list mismatch.
          const enforceOnlineMembership = hasOnlineList && fileEntries.length === 1

          const seenSiteIds = new Set<string>()
          const keptByFile: Channel[][] = fileEntries.map(() => [])
          const allCandidates: VerificationCandidate[] = []
          const removedChannels: string[] = []
          const addedChannels: string[] = []
          let skippedNoEpgCount = 0

          fileEntries.forEach((entry, fileIndex) => {
            entry.parsed.forEach(ch => {
              const lang = (ch.lang || '').toLowerCase()
              const rawName = ch.name || ''
              const siteId = String(ch.site_id || '')
              const normKey = normalizeChannelName(rawName) || siteId

              if (!siteId || !lang || seenSiteIds.has(`${lang}:${siteId}`)) {
                removedChannels.push(`${rawName || siteId} (mükerrer)`)
                return
              }

              if (normKey.includes('test') || normKey.includes('dummy')) {
                removedChannels.push(`${rawName || siteId} (test)`)
                return
              }

              // Preserve channels from other languages untouched when a language filter is active
              if (allowedLangs && !allowedLangs.has(lang)) {
                seenSiteIds.add(`${lang}:${siteId}`)
                keptByFile[fileIndex].push(
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
                return
              }

              const existsOnline =
                !enforceOnlineMembership || onlineSiteIds.has(siteId) || onlineNormKeys.has(normKey)

              if (!existsOnline) {
                removedChannels.push(`${rawName || siteId} (siteden kaldırılmış)`)
                return
              }

              seenSiteIds.add(`${lang}:${siteId}`)
              const channelModel = new Channel({
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

              allCandidates.push({
                fileIndex,
                channel: channelModel,
                isNew: false,
                rawName
              })
            })
          })

          // Discover new channels from online list into primary XML file
          if (hasOnlineList && fileEntries.length > 0) {
            onlineChannels.forEach(ch => {
              if (!ch.site_id) return
              const siteId = String(ch.site_id)
              const lang = (ch.lang || '').toLowerCase()
              if (!lang) return
              if (allowedLangs && !allowedLangs.has(lang)) return
              if (seenSiteIds.has(`${lang}:${siteId}`)) return

              const rawName = ch.name || ''
              const normKey = normalizeChannelName(rawName) || siteId
              if (normKey.includes('test') || normKey.includes('dummy')) return

              seenSiteIds.add(`${lang}:${siteId}`)
              const channelModel = new Channel({
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

              allCandidates.push({
                fileIndex: 0,
                channel: channelModel,
                isNew: true,
                rawName
              })
            })
          }

          const canVerifyLive = verifyEpg && typeof config.parser === 'function' && Boolean(config.url)

          if (canVerifyLive && allCandidates.length > 0) {
            const newCandidates = allCandidates.filter(c => c.isNew)
            const existingCandidates = allCandidates.filter(c => !c.isNew)

            // Determine how many existing channels to test live
            let existingLimit = existingCandidates.length
            if (maxVerifyPerSite > 0) {
              existingLimit = Math.min(existingCandidates.length, maxVerifyPerSite)
            } else if (mode === 'fast' && !allowedSites && (!allowedLangs || totalSites > 20)) {
              existingLimit = Math.min(existingCandidates.length, FAST_MODE_EXISTING_SAMPLE)
            }

            const existingToCheck = existingCandidates.slice(0, existingLimit)
            const uncheckedTail = existingCandidates.slice(existingLimit)
            const toCheck = [...newCandidates, ...existingToCheck]

            globalTotalChannels += toCheck.length

            emitProgress(
              `[Site ${sitePosition}] [${site}] ${toCheck.length}/${allCandidates.length} kanal canlı EPG (ilk 2 program) doğrulanıyor...`,
              site
            )

            let siteChecked = 0
            let siteActive = 0
            let siteEmptyOrErr = 0
            let lastEmitTime = Date.now()

            const results = await Promise.all(
              toCheck.map(item =>
                channelLimit(async () => {
                  if (signal?.aborted) {
                    return {
                      item,
                      check: {
                        hasPrograms: false,
                        programCount: 0,
                        error: new Error('Durduruldu'),
                        statusCode: null
                      }
                    }
                  }

                  const check = await checkChannelEpgLive(grabber, item.channel, config, deepCheck, signal)
                  siteChecked++
                  globalCheckedChannels++
                  if (check.hasPrograms) siteActive++
                  else siteEmptyOrErr++

                  const now = Date.now()
                  if (
                    siteChecked === toCheck.length ||
                    siteChecked % 20 === 0 ||
                    now - lastEmitTime >= 2500
                  ) {
                    lastEmitTime = now
                    const pct = Math.round((siteChecked / toCheck.length) * 100)
                    emitProgress(
                      `[Site ${sitePosition}] [${site}] Kanal ${siteChecked}/${toCheck.length} (%${pct}) • Aktif: ${siteActive} • Boş/Hata: ${siteEmptyOrErr}`,
                      site
                    )
                  }

                  return { item, check }
                })
              )
            )

            if (signal?.aborted) return

            const anySuccess = results.some(r => r.check.hasPrograms)
            const allNetworkErrors =
              results.length > 0 && results.every(r => r.check.error !== null && !r.check.hasPrograms)

            for (const { item, check } of results) {
              if (check.hasPrograms) {
                keptByFile[item.fileIndex].push(item.channel)
                if (item.isNew) {
                  addedChannels.push(`${item.rawName || item.channel.site_id} (${check.programCount} program)`)
                }
              } else if (item.isNew) {
                skippedNoEpgCount++
              } else if (allNetworkErrors) {
                keptByFile[item.fileIndex].push(item.channel)
              } else if (!check.error || check.statusCode === 404 || check.statusCode === 410 || anySuccess) {
                removedChannels.push(
                  `${item.rawName || item.channel.site_id} (${check.error ? `EPG hatası ${check.statusCode || ''}`.trim() : '0 yayın akışı'})`
                )
              } else {
                keptByFile[item.fileIndex].push(item.channel)
              }
            }

            for (const tailItem of uncheckedTail) {
              keptByFile[tailItem.fileIndex].push(tailItem.channel)
            }

            if (allNetworkErrors && existingToCheck.length > 0) {
              completedSites++
              globalSkippedNoEpgCount += skippedNoEpgCount
              report.push({
                site,
                status: 'warning',
                reason: 'Siteye canlı yayın akışı için erişilemedi - mevcut kanallar korundu',
                skippedNoEpgCount
              })
              emitProgress(
                `[Site ${sitePosition} !] [${site}] Erişim hatası (mevcut kanallar korundu)`,
                site
              )
              return
            }
          } else {
            for (const item of allCandidates) {
              keptByFile[item.fileIndex].push(item.channel)
              if (item.isNew) addedChannels.push(item.rawName || item.channel.site_id)
            }
          }

          if (signal?.aborted) return

          let totalSiteChannels = 0
          fileEntries.forEach((entry, fileIndex) => {
            const kept = keptByFile[fileIndex]
            if (kept.length > 0) {
              const updatedCollection = new Collection(kept)
              const updatedXml = generateChannelsXML(updatedCollection)
              fs.writeFileSync(entry.xmlPath, updatedXml, 'utf8')
              totalSiteChannels += kept.length
            }
          })

          completedSites++
          globalAddedCount += addedChannels.length
          globalRemovedCount += removedChannels.length
          globalSkippedNoEpgCount += skippedNoEpgCount

          if (
            totalSiteChannels === 0 &&
            addedChannels.length === 0 &&
            removedChannels.length === 0 &&
            skippedNoEpgCount === 0
          ) {
            if (!allowedLangs) {
              report.push({
                site,
                status: 'warning',
                reason: 'Geçerli kanal bulunamadı (dosyalar korundu)'
              })
            }
            return
          }

          report.push({
            site,
            status: 'ok',
            totalChannels: totalSiteChannels,
            addedCount: addedChannels.length,
            removedCount: removedChannels.length,
            skippedNoEpgCount,
            addedChannels,
            removedChannels
          })

          emitProgress(
            `[Site ${sitePosition} ✓] [${site}] Tamamlandı (${totalSiteChannels} kanal | +${addedChannels.length} eklendi | -${removedChannels.length} silindi | ${skippedNoEpgCount} elendi)`,
            site
          )
        } catch (err: unknown) {
          completedSites++
          const message = err instanceof Error ? err.message : String(err)
          report.push({
            site,
            status: 'error',
            error: message
          })
          emitProgress(`[Site ${sitePosition} ✕] [${site}] Hata: ${message}`, site)
        }
      })
    )
  )

  invalidateSitesCache()

  const finalPhase = signal?.aborted ? 'cancelled' : 'completed'
  const sec = ((Date.now() - startTime) / 1000).toFixed(1)
  emitProgress(
    signal?.aborted
      ? `Doğrulama durduruldu (${completedSites}/${totalSites} site işlendi, ${sec}s).`
      : `Doğrulama tamamlandı: ${completedSites}/${totalSites} site, ${globalCheckedChannels} kanal kontrol edildi (${sec}s).`,
    '-',
    finalPhase
  )

  return report
}
