import fs from 'fs'
import path from 'path'
import pako from 'pako'
import pLimit from 'p-limit'
import dayjs, { Dayjs } from 'dayjs'
import utc from 'dayjs/plugin/utc'
import merge from 'lodash.merge'
import { Option, program } from 'commander'
import { Collection, Logger } from '@freearhey/core'
import epgGrabber, { EPGGrabber } from 'epg-grabber'
import { SITES_DIR, GUIDES_DIR } from '../../constants'
import defaultConfig from '../../default.config'
import { loadData, data } from '../../api'
import { Channel, Guide, Program } from '../../models'
import { loadJs, parseList, parseNumber } from '../../core'
import { getAvailableLanguages, normalizeChannelName } from '../../site-channels'

dayjs.extend(utc)

const GITHUB_MAX_UNCOMPRESSED_BYTES = 95 * 1024 * 1024

program
  .addOption(
    new Option('-l, --langs <codes>', 'Comma-separated language codes (defaults to all)').argParser(
      parseList
    )
  )
  .addOption(
    new Option('--days <days>', 'Number of days to grab').argParser(parseNumber).default(1)
  )
  .addOption(
    new Option('--maxConnections <number>', 'Concurrent HTTP connections')
      .argParser(parseNumber)
      .default(5)
  )
  .addOption(
    new Option('--timeout <ms>', 'Request timeout in milliseconds')
      .argParser(parseNumber)
      .default(15000)
  )
  .addOption(
    new Option('--maxChannelsPerLang <number>', 'Optional limit per language (0 = unlimited)')
      .argParser(parseNumber)
      .default(0)
  )
  .parse()

interface GrabLangsOptions {
  langs?: string[]
  days: number
  maxConnections: number
  timeout: number
  maxChannelsPerLang: number
}

const options: GrabLangsOptions = program.opts()

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

function getLogoForChannel(channel: Channel): string | null {
  const feedData = data.feedsKeyByStreamId.get(channel.xmltv_id)
  if (feedData) {
    const firstLogo = feedData.getLogos().first()
    if (firstLogo) return firstLogo.url
  }

  const [channelId] = channel.xmltv_id.split('@')
  const channelData = data.channelsKeyById.get(channelId)
  if (channelData) {
    const firstLogo = channelData.getLogos().first()
    if (firstLogo) return firstLogo.url
  }

  return null
}

async function main() {
  const logger = new Logger({ level: 3 })
  const guidesDir = path.resolve(GUIDES_DIR)
  fs.mkdirSync(guidesDir, { recursive: true })

  await loadData()

  const availableLanguages = getAvailableLanguages()
  const targetLangs =
    options.langs && options.langs.length > 0
      ? options.langs.map(l => l.trim().toLowerCase()).filter(Boolean)
      : availableLanguages.map(l => l.code)

  const targetLangSet = new Set(targetLangs)
  const channelsByLang = new Map<string, Map<string, Channel>>()

  const siteDirs = fs.readdirSync(SITES_DIR)
  for (const site of siteDirs) {
    const sitePath = path.join(SITES_DIR, site)
    if (!fs.statSync(sitePath).isDirectory()) continue

    const xmlFiles = listXmlFilesRecursive(sitePath)
    for (const xmlPath of xmlFiles) {
      const xml = fs.readFileSync(xmlPath, 'utf8')
      const parsed = EPGGrabber.parseChannelsXML(xml)
      for (const ch of parsed) {
        const lang = (ch.lang || '').toLowerCase()
        if (!lang || !targetLangSet.has(lang)) continue

        const rawName = ch.name || ''
        const normKey = normalizeChannelName(rawName) || ch.site_id
        if (!ch.site_id || normKey.includes('test') || normKey.includes('dummy')) continue

        let langMap = channelsByLang.get(lang)
        if (!langMap) {
          langMap = new Map<string, Channel>()
          channelsByLang.set(lang, langMap)
        }

        if (!langMap.has(normKey)) {
          langMap.set(
            normKey,
            new Channel({
              xmltv_id: ch.xmltv_id || ch.site_id,
              name: rawName,
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
      }
    }
  }

  const grabber = new EPGGrabber({
    request: {
      ...defaultConfig.request,
      timeout: options.timeout,
      cache: { ttl: 10 * 60 * 1000 }
    }
  })

  const configCache = new Map<string, epgGrabber.Types.SiteConfig>()
  const limit = pLimit(options.maxConnections)
  const currDate = dayjs.utc(process.env.CURR_DATE || new Date().toISOString())
  const dates: Dayjs[] = Array.from({ length: options.days }, (_, d) => currDate.add(d, 'd'))

  const manifestLanguages: {
    code: string
    name: string
    channels: number
    programs: number
    xmlFile: string | null
    gzFile: string
  }[] = []

  const langInfoMap = new Map(availableLanguages.map(l => [l.code, l.name]))

  for (const lang of targetLangs) {
    const langMap = channelsByLang.get(lang)
    if (!langMap || langMap.size === 0) continue

    let langChannels = Array.from(langMap.values())
    if (options.maxChannelsPerLang > 0 && langChannels.length > options.maxChannelsPerLang) {
      langChannels = langChannels.slice(0, options.maxChannelsPerLang)
    }

    logger.info(`[${lang}] ${langChannels.length} kanal için EPG çekiliyor...`)

    const validChannels = new Collection<Channel>()
    const programs = new Collection<Program>()

    // Grab per channel so we only include channels with > 0 programs
    const perChannelTasks = langChannels.map(channel =>
      limit(async () => {
        const configPath = channel.getConfigPath()
        let siteConfig = configCache.get(configPath)
        if (!siteConfig) {
          try {
            const loaded = merge({}, defaultConfig, await loadJs(configPath))
            siteConfig = loaded
            configCache.set(configPath, loaded)
          } catch {
            return
          }
        }
        if (!siteConfig) return
        const resolvedConfig: epgGrabber.Types.SiteConfig = siteConfig

        if (!channel.xmltv_id) channel.xmltv_id = channel.site_id
        if (!channel.logo) {
          channel.logo = getLogoForChannel(channel)
        }

        let countForChannel = 0
        for (const date of dates) {
          try {
            const res = await grabber.grab(channel, date, resolvedConfig)
            if (Array.isArray(res) && res.length > 0) {
              countForChannel += res.length
              res.forEach(p => programs.add(new Program(p.toObject())))
            }
          } catch {
            // Skip failed channel/day cleanly
          }
        }

        if (countForChannel > 0) {
          validChannels.add(channel)
        }
      })
    )

    await Promise.all(perChannelTasks)

    if (validChannels.count() === 0) {
      logger.info(`[${lang}] Program içeren kanal bulunamadı, atlandı.`)
      continue
    }

    const sortedPrograms = programs.sortBy([
      (p: Program) => p.channel,
      (p: Program) => p.start
    ])

    const xmlOutPath = path.join(guidesDir, `${lang}.xml`)
    const gzOutPath = path.join(guidesDir, `${lang}.xml.gz`)

    const guide = new Guide({
      filepath: xmlOutPath,
      gzip: false,
      json: false,
      channels: validChannels,
      programs: sortedPrograms
    })

    const xmlString = guide.toString()
    const compressed = pako.gzip(xmlString)
    fs.writeFileSync(gzOutPath, compressed)

    const xmlByteSize = Buffer.byteLength(xmlString, 'utf8')
    let savedXmlFile: string | null = null
    if (xmlByteSize <= GITHUB_MAX_UNCOMPRESSED_BYTES) {
      fs.writeFileSync(xmlOutPath, xmlString, 'utf8')
      savedXmlFile = `guides/${lang}.xml`
    } else if (fs.existsSync(xmlOutPath)) {
      fs.unlinkSync(xmlOutPath)
    }

    manifestLanguages.push({
      code: lang,
      name: langInfoMap.get(lang) || lang.toUpperCase(),
      channels: validChannels.count(),
      programs: sortedPrograms.count(),
      xmlFile: savedXmlFile,
      gzFile: `guides/${lang}.xml.gz`
    })

    logger.info(
      `[${lang}] Kaydedildi: ${validChannels.count()} kanal, ${sortedPrograms.count()} program`
    )
  }

  const indexData = {
    updatedAt: new Date().toISOString(),
    languages: manifestLanguages
  }
  fs.writeFileSync(path.join(guidesDir, 'index.json'), JSON.stringify(indexData, null, 2), 'utf8')
  logger.success(`Tamamlandı: ${manifestLanguages.length} dil için rehber oluşturuldu.`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
