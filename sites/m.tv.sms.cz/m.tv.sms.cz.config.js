const cheerio = require('cheerio')
const iconv = require('iconv-lite')
const dayjs = require('dayjs')
const utc = require('dayjs/plugin/utc')
const timezone = require('dayjs/plugin/timezone')
const https = require('https')
dayjs.extend(utc)
dayjs.extend(timezone)

const agent = new https.Agent({ ciphers: 'DEFAULT:@SECLEVEL=0', rejectUnauthorized: false })

module.exports = {
  site: 'm.tv.sms.cz',
  days: 2,
  request: {
    httpsAgent: agent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
    }
  },
  url: function ({ date, channel }) {
    return `https://m.tv.sms.cz/index.php?stanice=${channel.site_id}&cas=0&den=${date.format(
      'YYYY-MM-DD'
    )}`
  },
  parser: function ({ buffer, date }) {
    const programs = []
    const items = parseItems(buffer)
    items.forEach(item => {
      const prev = programs[programs.length - 1]
      const $item = cheerio.load(item)
      let start = parseStart($item, date)
      if (prev) {
        if (start < prev.start) {
          start = start.add(1, 'day')
          date = date.add(1, 'day')
        }
        prev.stop = start
      }
      const stop = start.add(1, 'hour')
      programs.push({
        title: parseTitle($item),
        description: parseDescription($item),
        start,
        stop
      })
    })

    return programs
  },
  async channels() {
    const axios = require('axios')
    const data = await axios
      .get('https://m.tv.sms.cz/?zmen_stanice=true', {
        httpsAgent: agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
        }
      })
      .then(r => r.data)
      .catch(console.log)

    let channels = []
    const $ = cheerio.load(data)
    $('.stanice').each((i, el) => {
      const name = $(el).attr('title')
      const site_id = $(el).find('input').attr('value').replace(/\|/g, '')

      if (!name) return

      channels.push({
        lang: 'cs',
        site_id,
        name
      })
    })

    return channels
  }
}

function parseStart($item, date) {
  const timeString = $item('div > span').text().trim()
  const dateString = `${date.format('MM/DD/YYYY')} ${timeString}`

  return dayjs.tz(dateString, 'MM/DD/YYYY HH.mm', 'Europe/Prague').utc()
}

function parseDescription($item) {
  return $item('a.nazev > div.detail').text().trim()
}

function parseTitle($item) {
  return $item('a.nazev > div:nth-child(1)').text().trim()
}

function parseItems(buffer) {
  const string = iconv.decode(buffer, 'win1250')
  const $ = cheerio.load(string)

  return $('#obsah > div > div.porady > div.porad').toArray()
}
