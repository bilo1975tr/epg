import fs from 'fs'
import path from 'path'
import { SITES_DIR } from './constants'
import { EPGGrabber } from 'epg-grabber'
import { generateChannelsXML } from './core'
import { Collection } from '@freearhey/core'
import { Channel } from './models'
import { normalizeChannelName } from './site-channels'

export interface CombinedChannelsOptions {
  langs?: string[]
  sites?: string[]
  extraChannels?: Channel[]
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

export function generateCombinedChannelsXML(
  outputPath: string,
  options: CombinedChannelsOptions = {}
): number {
  const allowedLangs =
    options.langs && options.langs.length > 0
      ? new Set(options.langs.map(l => l.trim().toLowerCase()).filter(Boolean))
      : null

  const allowedSites =
    options.sites && options.sites.length > 0
      ? new Set(options.sites.map(s => s.trim()).filter(Boolean))
      : null

  const sites = fs.readdirSync(SITES_DIR)
  const uniqueChannelsMap = new Map<string, Channel>()

  for (const site of sites) {
    if (allowedSites && !allowedSites.has(site)) continue
    const sitePath = path.join(SITES_DIR, site)
    if (!fs.statSync(sitePath).isDirectory()) continue

    const xmlFiles = listXmlFilesRecursive(sitePath)
    for (const xmlPath of xmlFiles) {
      const xmlContent = fs.readFileSync(xmlPath, 'utf8')
      const parsed = EPGGrabber.parseChannelsXML(xmlContent)

      parsed.forEach(ch => {
        const lang = (ch.lang || '').toLowerCase()
        if (!lang) return
        if (allowedLangs && !allowedLangs.has(lang)) return

        const rawName = ch.name || ''
        const normKey = normalizeChannelName(rawName) || ch.site_id

        if (!ch.site_id || normKey.includes('test') || normKey.includes('dummy')) return

        const dedupeKey = `${lang}:${normKey}`
        if (!uniqueChannelsMap.has(dedupeKey)) {
          uniqueChannelsMap.set(
            dedupeKey,
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
      })
    }
  }

  if (options.extraChannels && options.extraChannels.length > 0) {
    for (const extra of options.extraChannels) {
      const lang = (extra.lang || '').toLowerCase()
      if (!lang) continue
      if (allowedLangs && !allowedLangs.has(lang)) continue
      const normKey = normalizeChannelName(extra.name || '') || extra.site_id
      if (!extra.site_id || normKey.includes('test') || normKey.includes('dummy')) continue

      const dedupeKey = `${lang}:${normKey}`
      if (!uniqueChannelsMap.has(dedupeKey)) {
        uniqueChannelsMap.set(dedupeKey, extra)
      }
    }
  }

  const allChannels = new Collection(Array.from(uniqueChannelsMap.values()))
  const combinedXml = generateChannelsXML(allChannels)
  fs.writeFileSync(outputPath, combinedXml, 'utf8')
  return allChannels.count()
}
