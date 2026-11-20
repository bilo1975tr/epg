const axios = require('axios')
const dayjs = require('dayjs')

let apiVersion

module.exports = {
  site: 'pickx.be',
  days: 2,
  async url({ channel, date }) {
    if (!apiVersion) {
      await fetchApiVersion()
    }

    return `https://px-epg.azureedge.net/airings/${apiVersion}/${date.format(
      'YYYY-MM-DD'
    )}/channel/${channel.site_id}?timezone=Europe%2FBrussels`
  },
  request: {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      Origin: 'https://www.pickx.be',
      Referer: 'https://www.pickx.be/'
    }
  },
  parser({ channel, content }) {
    const programs = []
    if (content) {
      const items = JSON.parse(content)
      items.forEach(item => {
        programs.push({
          title: item.program.title,
          sub_title: item.program.episodeTitle,
          description: item.program.description,
          category: item.program.translatedCategory?.[channel.lang]
            ? item.program.translatedCategory[channel.lang]
            : item.program.category.split('.')[1],
          image: item.program.posterFileName
            ? `https://experience-cache.cdi.streaming.proximustv.be/posterserver/poster/EPG/${item.program.posterFileName}`
            : null,
          season: item.program.seasonNumber,
          episode: item.program.episodeNumber,
          actors: item.program.actors,
          director: item.program.director ? [item.program.director] : null,
          start: dayjs(item.programScheduleStart),
          stop: dayjs(item.programScheduleEnd)
        })
      })
    }

    return programs
  },
  async channels() {
    let channels = []

    const query = {
      operationName: 'getChannels',
      variables: {
        language: 'fr',
        queryParams: {},
        id: '0',
        params: {
          shouldReadFromCache: true
        }
      },
      query: `query getChannels($language: String!, $queryParams: ChannelQueryParams, $id: String, $params: ChannelParams) {
        channels(language: $language, queryParams: $queryParams, id: $id, params: $params) {
          id
          name
          language
          radio
        }
      }`
    }

    const data = await axios
      .post('https://api.proximusmwc.be/tiams/v3/graphql', query)
      .then(r => r.data)
      .catch(console.error)

    data.data.channels.forEach(channel => {
      let lang = channel.language || 'fr'
      if (channel.language === 'ger') lang = 'de'

      channels.push({
        lang,
        site_id: channel.id,
        name: channel.name
      })
    })

    return channels
  }
}

async function fetchApiVersion() {
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
        const match = res.data.match(/"hashes"\s*:\s*\[\s*"(.*?)"\s*\]/)
        if (match) hash = match[1]
      }
    }

    if (hash) {
      const versionUrl = `https://www.pickx.be/api/s-${hash}`
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
}
