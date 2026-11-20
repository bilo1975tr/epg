import { Logger, Timer, Collection, Template } from '@freearhey/core'
import epgGrabber, { EPGGrabber, EPGGrabberMock } from 'epg-grabber'
import { CurlBody } from 'curl-generator/dist/bodies/body'
import { Channel, Guide, Program } from '../../models'
import { SocksProxyAgent } from 'socks-proxy-agent'
import defaultConfig from '../../default.config'
import pLimit from 'p-limit'
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
    if (error.response?.status === 405) {
      return Promise.reject(error)
    }
    console.error(`[Axios Error Caught & Skipped] URL: ${error.config?.url || 'unknown'} | Status: ${error.response?.status || 'N/A'} | Message: ${error.message}`)
    return Promise.resolve({ status: error.response?.status || 500, data: '' })
  }
)
import { Storage } from '@freearhey/storage-js'
import { CurlGenerator } from 'curl-generator'
import { QueueItem } from '../../types/queue'
import { Option, program } from 'commander'
import { SITES_DIR } from '../../constants'
import { data, loadData } from '../../api'
import dayjs, { Dayjs } from 'dayjs'
import merge from 'lodash.merge'
import fs from 'fs'
import path from 'path'
import {
  parseBooleanOrString,
  parseBoolean,
  parseNumber,
  parseProxy,
  parseList,
  loadJs
} from '../../core'

program
  .addOption(
    new Option('-s, --sites <names>', 'A comma-separated list of the sites to parse').argParser(
      parseList
    )
  )
  .addOption(
    new Option(
      '-c, --channels <path>',
      'Path to *.channels.xml file (required if the "--sites" attribute is not specified)'
    )
  )
  .addOption(new Option('-o, --output <path>', 'Path to output file'))
  .addOption(new Option('-l, --lang <codes>', 'Filter channels by languages (ISO 639-1 codes)'))
  .addOption(
    new Option('-t, --timeout <milliseconds>', 'Override the default timeout for each request')
      .env('TIMEOUT')
      .argParser(parseNumber)
  )
  .addOption(
    new Option('-d, --delay <milliseconds>', 'Override the default delay between request')
      .env('DELAY')
      .argParser(parseNumber)
  )
  .addOption(new Option('-x, --proxy <url>', 'Use the specified proxy').env('PROXY'))
  .addOption(
    new Option(
      '--days <days>',
      'Override the number of days for which the program will be loaded (defaults to the value from the site config)'
    )
      .argParser(parseNumber)
      .env('DAYS')
  )
  .addOption(
    new Option('--maxConnections <number>', 'Limit on the number of concurrent requests')
      .argParser(parseNumber)
      .env('MAX_CONNECTIONS')
  )
  .addOption(
    new Option('--gzip [path]', 'Create a compressed version of the guide as well')
      .argParser(parseBooleanOrString)
      .env('GZIP')
  )
  .addOption(
    new Option('--json [path]', 'Create a JSON version of the guide as well')
      .argParser(parseBooleanOrString)
      .env('JSON')
  )
  .addOption(
    new Option('--curl', 'Display each request as CURL').argParser(parseBoolean).env('CURL')
  )
  .addOption(new Option('--debug', 'Enable debug mode').argParser(parseBoolean).env('DEBUG'))
  .addOption(
    new Option('--skip-empty', 'Exclude channels that return 0 programs')
      .argParser(parseBoolean)
      .env('SKIP_EMPTY')
  )
  .addOption(
    new Option('--report <path>', 'Optional JSON path to write per-channel grab counts and errors')
  )
  .parse()

interface GrabOptions {
  sites?: string[]
  channels?: string
  output?: string
  gzip?: boolean | string
  json?: boolean | string
  curl?: boolean
  debug?: boolean
  maxConnections?: number
  timeout?: number
  delay?: number
  lang?: string
  days?: number
  proxy?: string
  skipEmpty?: boolean
  report?: string
}

const options: GrabOptions = program.opts()

async function main() {
  if (!Array.isArray(options.sites) && typeof options.channels !== 'string')
    throw new Error('One of the arguments must be presented: `--sites` or `--channels`')

  const LOG_LEVELS = { info: 3, debug: 4 }
  const logger = new Logger({ level: options.debug ? LOG_LEVELS['debug'] : LOG_LEVELS['info'] })

  logger.info('starting...')
  const globalConfig: epgGrabber.Types.SiteConfig = {}

  if (typeof options.timeout === 'number')
    merge(globalConfig, { request: { timeout: options.timeout } })
  if (options.proxy !== undefined) {
    const proxy = parseProxy(options.proxy)
    if (
      proxy.protocol &&
      ['socks', 'socks5', 'socks5h', 'socks4', 'socks4a'].includes(String(proxy.protocol))
    ) {
      const socksProxyAgent = new SocksProxyAgent(options.proxy)
      merge(globalConfig, {
        request: { httpAgent: socksProxyAgent, httpsAgent: socksProxyAgent }
      })
    } else {
      merge(globalConfig, { request: { proxy } })
    }
  }

  if (typeof options.output === 'string') globalConfig.output = options.output
  if (typeof options.days === 'number') globalConfig.days = options.days
  if (typeof options.delay === 'number') globalConfig.delay = options.delay
  if (typeof options.maxConnections === 'number')
    globalConfig.maxConnections = options.maxConnections
  if (typeof options.curl === 'boolean') globalConfig.curl = options.curl
  if (typeof options.gzip === 'boolean') globalConfig.gzip = options.gzip
  if (typeof options.debug === 'boolean') globalConfig.debug = options.debug

  logger.debug(`config: ${JSON.stringify(globalConfig, getCircularReplacer(), 2)}`)

  const grabber =
    process.env.NODE_ENV === 'test'
      ? new EPGGrabberMock(globalConfig)
      : new EPGGrabber(globalConfig)

  grabber.client.instance.interceptors.request.use(
    request => {
      logger.debug(`request: ${JSON.stringify(request, getCircularReplacer(), 2)}`)

      const curl = globalConfig.curl || defaultConfig.curl
      if (curl) {
        type AllowedMethods =
          | 'GET'
          | 'get'
          | 'POST'
          | 'post'
          | 'PUT'
          | 'put'
          | 'PATCH'
          | 'patch'
          | 'DELETE'
          | 'delete'

        const url = request.url || ''
        const method = request.method ? (request.method as AllowedMethods) : 'GET'
        const headers = request.headers
          ? (request.headers.toJSON() as Record<string, string>)
          : undefined
        const body = request.data ? (request.data as CurlBody) : undefined

        const curl = CurlGenerator({ url, method, headers, body })

        console.log(curl)
      }

      return request
    },
    error => Promise.reject(error)
  )

  if (process.env.NODE_ENV !== 'test') {
    grabber.client.instance.interceptors.response.use(
      response => response,
      async error => {
        const status = error?.response?.status
        const config = error?.config
        if (status === 429 && config) {
          const retryCount = Number(config._retry429Count || 0)
          if (retryCount < 2) {
            config._retry429Count = retryCount + 1
            const retryAfterRaw = error.response?.headers?.['retry-after']
            const retryAfterSec = retryAfterRaw ? Number(retryAfterRaw) : NaN
            const waitMs =
              Number.isFinite(retryAfterSec) && retryAfterSec > 0
                ? Math.min(retryAfterSec * 1000, 8000)
                : 1500 * (retryCount + 1)
            await new Promise(resolve => setTimeout(resolve, waitMs))
            return grabber.client.instance.request(config)
          }
        }
        return Promise.reject(error)
      }
    )
  }

  logger.info('loading channels...')
  const storage = new Storage()

  let files: string[] = []
  if (Array.isArray(options.sites)) {
    for (const site of options.sites) {
      let pattern = path.join(SITES_DIR, site, '*.channels.xml')
      pattern = pattern.replace(/\\/g, '/')
      const foundFiles = await storage.list(pattern)
      foundFiles.forEach((filepath: string) => {
        files.push(filepath)
      })
    }
  } else if (typeof options.channels === 'string') {
    files = await storage.list(options.channels)
  }

  let channelsFromXML = new Collection<Channel>()
  for (const filepath of files) {
    const xml = await storage.load(filepath)
    const parsedChannels = EPGGrabber.parseChannelsXML(xml)
    const _channelsFromXML = new Collection(parsedChannels).map(
      (channel: epgGrabber.Channel) => new Channel(channel.toObject())
    )

    channelsFromXML.concat(_channelsFromXML)
  }

  if (typeof options.lang === 'string') {
    channelsFromXML = channelsFromXML.filter((channel: Channel) => {
      if (!options.lang) return true

      return channel.lang ? options.lang.includes(channel.lang) : false
    })
  }

  logger.info(`found ${channelsFromXML.count()} channel(s)`)

  logger.info('loading api data...')
  await loadData()

  logger.info('creating queue...')
  const queue = new Collection<QueueItem>()
  const maxConnections = globalConfig.maxConnections || defaultConfig.maxConnections
  const siteLimiters = new Map<string, ReturnType<typeof pLimit>>()

  let index = 0
  for (const channel of channelsFromXML.all()) {
    channel.index = index++
    if (!channel.site || !channel.site_id || !channel.name) continue

    const rawSiteConfig = await loadJs(channel.getConfigPath())
    const config = merge({}, defaultConfig, rawSiteConfig)

    if (!siteLimiters.has(channel.site)) {
      const explicitSiteMax =
        typeof rawSiteConfig.maxConnections === 'number' ? rawSiteConfig.maxConnections : 2
      const siteConcurrency = Math.max(1, Math.min(maxConnections, explicitSiteMax))
      siteLimiters.set(channel.site, pLimit(siteConcurrency))
    }

    if (!channel.xmltv_id) channel.xmltv_id = channel.site_id

    const days = globalConfig.days || config.days
    const currDate = dayjs.utc(process.env.CURR_DATE || new Date().toISOString())
    const dates = Array.from({ length: days }, (_, day) => currDate.add(day, 'd'))

    dates.forEach((date: Dayjs) => {
      queue.add({
        channel,
        date,
        config: { ...config },
        error: null
      })
    })
  }

  const limit = pLimit(maxConnections)

  const channels = new Collection<Channel>()
  const programs = new Collection<Program>()
  const reportMap = new Map<
    string,
    {
      site: string
      site_id: string
      xmltv_id: string
      name: string
      lang: string
      programCount: number
      error: string | null
    }
  >()

  let i = 1
  const total = queue.count()

  logger.info('run:')
  const timer = new Timer()
  timer.start()

  const runTask = async (queueItem: QueueItem) => {
    const { channel, config, date } = queueItem

    if (!channel.logo) {
      if (config.logo) {
        channel.logo = await grabber.loadLogo(channel, date)
      } else {
        channel.logo = getLogoForChannel(channel)
      }
    }

    let callbackErrMsg: string | null = null
    const channelPrograms = await grabber.grab(
      channel,
      date,
      config,
      (context: epgGrabber.Types.GrabCallbackContext, error: Error | null) => {
        logger.info(
          `  [${i}/${total}] ${context.channel.site} (${context.channel.lang}) - ${context.channel.xmltv_id
          } - ${context.date.format('MMM D, YYYY')} (${context.programs.length} programs)`
        )
        if (i < total) i++

        if (error) {
          callbackErrMsg = error.message
          logger.info(`    ERR: ${error.message}`)
        }
      }
    )

    if (options.report) {
      const key = `${channel.site}|${channel.lang || ''}|${channel.site_id}`
      const existing = reportMap.get(key)
      if (existing) {
        existing.programCount += channelPrograms.length
        if (callbackErrMsg && !existing.error) {
          existing.error = callbackErrMsg
        }
      } else {
        reportMap.set(key, {
          site: channel.site,
          site_id: channel.site_id,
          xmltv_id: channel.xmltv_id,
          name: channel.name,
          lang: channel.lang || '',
          programCount: channelPrograms.length,
          error: callbackErrMsg
        })
      }
    }

    if (!options.skipEmpty || channelPrograms.length > 0) {
      channels.add(channel)
    }

    const _programs = new Collection<epgGrabber.Program>(channelPrograms).map<Program>(
      program => new Program(program.toObject())
    )

    programs.concat(_programs)
  }

  const requests = queue.all().map((queueItem: QueueItem) => {
    const siteLimiter = process.env.NODE_ENV === 'test' ? null : siteLimiters.get(queueItem.channel.site)
    if (siteLimiter) {
      return siteLimiter(() => limit(() => runTask(queueItem)))
    }
    return limit(() => runTask(queueItem))
  })

  await Promise.all(requests)

  const output = globalConfig.output || defaultConfig.output

  const pathTemplate = new Template(output)

  const channelsGroupedByKey = channels
    .uniqBy((channel: Channel) => `${channel.xmltv_id}:${channel.site}:${channel.lang}`)
    .groupBy((channel: Channel) => {
      return pathTemplate.format({ lang: channel.lang || 'en', site: channel.site || '' })
    })

  const programsGroupedByKey = programs
    .sortBy([(program: Program) => program.channel, (program: Program) => program.start])
    .groupBy((program: Program) => {
      const lang =
        program.titles && program.titles.length && program.titles[0].lang
          ? program.titles[0].lang
          : 'en'

      return pathTemplate.format({ lang, site: program.site || '' })
    })

  const gzip =
    typeof options.gzip === 'boolean' || typeof options.gzip === 'string'
      ? options.gzip
      : globalConfig.gzip || defaultConfig.gzip
  const json =
    typeof options.json === 'boolean' || typeof options.json === 'string'
      ? options.json
      : defaultConfig.json

  for (const groupKey of channelsGroupedByKey.keys()) {
    const groupChannels = new Collection(channelsGroupedByKey.get(groupKey))
    const groupPrograms = new Collection(programsGroupedByKey.get(groupKey))
    const guide = new Guide({
      filepath: groupKey,
      gzip,
      json,
      channels: groupChannels,
      programs: groupPrograms
    })

    await guide.save({ logger })
  }

  if (options.report) {
    fs.writeFileSync(
      options.report,
      JSON.stringify({ channels: Array.from(reportMap.values()) }),
      'utf8'
    )
  }

  logger.success(`  done in ${timer.format('HH[h] mm[m] ss[s]')}`)
}

main()

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

function getCircularReplacer() {
  const seen = new WeakSet()
  return (key: string, value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]'
      }
      seen.add(value)
    }
    return value
  }
}
