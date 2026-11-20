import fs from 'fs'
import path from 'path'
import langs from 'langs'
import { SITES_DIR } from './constants'
import { EPGGrabber } from 'epg-grabber'

export interface SiteChannelInfo {
  site_id: string
  name: string
  xmltv_id: string
  lang: string
}

export interface SiteSummary {
  site: string
  totalLocal: number
  langs: string[]
  status: 'ok' | 'empty'
}

export interface LanguageSummary {
  code: string
  name: string
  englishName: string
  channelCount: number
  siteCount: number
}

const TR_LANGUAGE_NAMES: Record<string, string> = {
  af: 'Afrikaanca',
  am: 'Amharca',
  ar: 'Arapça',
  az: 'Azerbaycanca',
  be: 'Belarusça',
  bg: 'Bulgarca',
  bn: 'Bengalce',
  bs: 'Boşnakça',
  ca: 'Katalanca',
  cs: 'Çekçe',
  cy: 'Galce',
  da: 'Danca',
  de: 'Almanca',
  el: 'Yunanca',
  en: 'İngilizce',
  es: 'İspanyolca',
  et: 'Estonca',
  eu: 'Baskça',
  fa: 'Farsça',
  fi: 'Fince',
  fil: 'Filipince',
  fr: 'Fransızca',
  ga: 'İrlandaca',
  gl: 'Galiçyaca',
  gu: 'Güceratça',
  he: 'İbranice',
  hi: 'Hintçe',
  hr: 'Hırvatça',
  hu: 'Macarca',
  hy: 'Ermenice',
  id: 'Endonezce',
  is: 'İzlandaca',
  it: 'İtalyanca',
  ja: 'Japonca',
  ka: 'Gürcüce',
  kk: 'Kazakça',
  km: 'Kmerce',
  kn: 'Kannada',
  ko: 'Korece',
  ku: 'Kürtçe',
  ky: 'Kırgızca',
  lb: 'Lüksemburgca',
  lt: 'Litvanca',
  lv: 'Letonca',
  mk: 'Makedonca',
  ml: 'Malayalam',
  mn: 'Moğolca',
  mr: 'Marathi',
  ms: 'Malayca',
  mt: 'Maltaca',
  my: 'Burmaca',
  nb: 'Norveççe (Bokmål)',
  ne: 'Nepalce',
  nl: 'Felemenkçe',
  nn: 'Norveççe (Nynorsk)',
  no: 'Norveççe',
  pa: 'Pencapça',
  pl: 'Lehçe',
  pt: 'Portekizce',
  ro: 'Rumence',
  ru: 'Rusça',
  si: 'Seylanca',
  sk: 'Slovakça',
  sl: 'Slovence',
  sq: 'Arnavutça',
  sr: 'Sırpça',
  sv: 'İsveççe',
  sw: 'Svahili',
  ta: 'Tamilce',
  te: 'Telugu',
  th: 'Tayca',
  tl: 'Tagalogca',
  tr: 'Türkçe',
  uk: 'Ukraynaca',
  ur: 'Urduca',
  uz: 'Özbekçe',
  vi: 'Vietnamca',
  zh: 'Çince'
}

interface SitesIndexCache {
  sites: SiteSummary[]
  languages: LanguageSummary[]
  totalChannels: number
}

let cachedIndex: SitesIndexCache | null = null

export function invalidateSitesCache(): void {
  cachedIndex = null
}

export function getLanguageDisplayName(code: string): { name: string; englishName: string } {
  const normalized = (code || '').toLowerCase()
  const info = langs.where('1', normalized) || langs.where('2', normalized) || langs.where('3', normalized)
  const englishName = info && typeof info.name === 'string' ? info.name : normalized.toUpperCase()
  const trName = TR_LANGUAGE_NAMES[normalized] || englishName
  return { name: trName, englishName }
}

export function normalizeChannelName(name: string): string {
  if (!name) return ''
  return name
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/[ğ]/g, 'g')
    .replace(/[ü]/g, 'u')
    .replace(/[ş]/g, 's')
    .replace(/[ö]/g, 'o')
    .replace(/[ç]/g, 'c')
    .replace(/[ä]/g, 'a')
    .replace(/ß/g, 'ss')
    .replace(/\+/g, 'plus')
    .replace(/\b(hd|sd|fhd|uhd|hevc)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim()
}

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

function buildSitesIndex(): SitesIndexCache {
  if (cachedIndex) return cachedIndex

  const baseDir = path.resolve(SITES_DIR)
  const sites: SiteSummary[] = []
  const langStats = new Map<string, { channelCount: number; sites: Set<string> }>()
  let totalChannels = 0

  if (!fs.existsSync(baseDir)) {
    cachedIndex = { sites: [], languages: [], totalChannels: 0 }
    return cachedIndex
  }

  const entries = fs.readdirSync(baseDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const siteName = entry.name
    const sitePath = path.join(baseDir, siteName)
    const xmlFiles = listXmlFilesRecursive(sitePath)
    const siteLangs = new Set<string>()
    const seenSiteKeys = new Set<string>()

    for (const xmlPath of xmlFiles) {
      const xmlContent = fs.readFileSync(xmlPath, 'utf8')
      const channelTagRegex = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g
      for (const match of xmlContent.matchAll(channelTagRegex)) {
        const attrs = match[1] || ''
        const langMatch = attrs.match(/\blang="([^"]*)"/)
        const siteIdMatch = attrs.match(/\bsite_id="([^"]*)"/)
        const lang = (langMatch?.[1] || '').trim().toLowerCase()
        const siteId = (siteIdMatch?.[1] || '').trim()
        if (!siteId || !lang) continue

        const dedupeKey = `${lang}:${siteId}`
        if (seenSiteKeys.has(dedupeKey)) continue
        seenSiteKeys.add(dedupeKey)

        siteLangs.add(lang.toUpperCase())

        const existingLang = langStats.get(lang)
        if (existingLang) {
          existingLang.channelCount++
          existingLang.sites.add(siteName)
        } else {
          langStats.set(lang, { channelCount: 1, sites: new Set([siteName]) })
        }
      }
    }

    const totalLocal = seenSiteKeys.size
    totalChannels += totalLocal
    sites.push({
      site: siteName,
      totalLocal,
      langs: Array.from(siteLangs).sort(),
      status: totalLocal > 0 ? 'ok' : 'empty'
    })
  }

  sites.sort((a, b) => a.site.localeCompare(b.site))

  const languages: LanguageSummary[] = Array.from(langStats.entries())
    .map(([code, stat]) => {
      const display = getLanguageDisplayName(code)
      return {
        code,
        name: display.name,
        englishName: display.englishName,
        channelCount: stat.channelCount,
        siteCount: stat.sites.size
      }
    })
    .sort((a, b) => b.channelCount - a.channelCount)

  cachedIndex = { sites, languages, totalChannels }
  return cachedIndex
}

export function getAllSitesSummary(langFilter?: string[]): {
  sites: SiteSummary[]
  totalChannels: number
  languageCount: number
} {
  const index = buildSitesIndex()
  if (!langFilter || langFilter.length === 0) {
    return {
      sites: index.sites,
      totalChannels: index.totalChannels,
      languageCount: index.languages.length
    }
  }

  const allowedUpper = new Set(langFilter.map(l => l.trim().toUpperCase()).filter(Boolean))
  const filtered = index.sites.filter(s => s.langs.some(l => allowedUpper.has(l)))
  return {
    sites: filtered,
    totalChannels: index.totalChannels,
    languageCount: index.languages.length
  }
}

export function getAvailableLanguages(): LanguageSummary[] {
  return buildSitesIndex().languages
}

export function getSiteChannels(siteName: string, langFilter?: string[]): SiteChannelInfo[] {
  if (!siteName || !/^[a-zA-Z0-9.-]+$/.test(siteName)) return []

  const baseDir = path.resolve(SITES_DIR)
  const sitePath = path.resolve(baseDir, siteName)
  if (!sitePath.startsWith(baseDir + path.sep) || !fs.existsSync(sitePath)) return []
  if (!fs.statSync(sitePath).isDirectory()) return []

  const channelFiles = listXmlFilesRecursive(sitePath)
  if (channelFiles.length === 0) return []

  const allowedLangs =
    langFilter && langFilter.length > 0
      ? new Set(langFilter.map(l => l.trim().toLowerCase()).filter(Boolean))
      : null

  const channelsMap = new Map<string, SiteChannelInfo>()

  for (const xmlPath of channelFiles) {
    const xmlContent = fs.readFileSync(xmlPath, 'utf8')
    const parsed = EPGGrabber.parseChannelsXML(xmlContent)

    parsed.forEach(ch => {
      const lang = (ch.lang || '').toLowerCase()
      if (!lang) return
      if (allowedLangs && !allowedLangs.has(lang)) return

      const rawName = ch.name || ''
      const normKey = normalizeChannelName(rawName) || ch.site_id

      if (normKey.includes('test') || normKey.includes('dummy')) return

      const uniqueKey = `${lang}:${ch.site_id}`
      if (!channelsMap.has(uniqueKey)) {
        channelsMap.set(uniqueKey, {
          site_id: ch.site_id,
          name: rawName,
          xmltv_id: ch.xmltv_id,
          lang
        })
      }
    })
  }

  return Array.from(channelsMap.values())
}
