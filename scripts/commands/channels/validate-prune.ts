import { program } from 'commander'
import { validateAndPrune, ValidationMode } from '../../validate-and-prune'
import { parseBoolean, parseList, parseNumber } from '../../core'

program
  .option('-s, --sites <names>', 'Comma-separated list of sites to validate', parseList)
  .option('-l, --langs <codes>', 'Comma-separated list of language codes', parseList)
  .option('--mode <type>', 'Verification mode: fast or full', 'fast')
  .option('--no-verify', 'Skip live EPG schedule verification')
  .option('--concurrency <number>', 'Concurrent EPG channel checks', parseNumber)
  .option('--site-concurrency <number>', 'Concurrent sites to process in parallel', parseNumber)
  .option('--max-verify <number>', 'Maximum existing channels to verify per site', parseNumber)
  .option('--verify-epg <boolean>', 'Verify live EPG schedules', parseBoolean)
  .parse()

interface CliOptions {
  sites?: string[]
  langs?: string[]
  mode?: string
  verify?: boolean
  verifyEpg?: boolean
  concurrency?: number
  siteConcurrency?: number
  maxVerify?: number
}

const opts: CliOptions = program.opts()

async function main() {
  const verifyEpg = opts.verifyEpg !== undefined ? opts.verifyEpg : opts.verify !== false
  const mode: ValidationMode = opts.mode === 'full' ? 'full' : 'fast'

  console.log(
    `Kanal doğrulama başlatıldı (Mod: ${mode === 'full' ? 'Tam' : 'Hızlı'} | Canlı EPG: ${verifyEpg ? 'AÇIK' : 'KAPALI'})...`
  )

  const report = await validateAndPrune({
    sites: opts.sites,
    langs: opts.langs,
    mode,
    verifyEpg,
    concurrency: opts.concurrency || 12,
    siteConcurrency: opts.siteConcurrency || 4,
    maxVerifyPerSite: opts.maxVerify || 0,
    onProgress: msg => console.log(msg)
  })

  const totalAdded = report.reduce((sum, r) => sum + (r.addedCount || 0), 0)
  const totalRemoved = report.reduce((sum, r) => sum + (r.removedCount || 0), 0)
  const totalSkipped = report.reduce((sum, r) => sum + (r.skippedNoEpgCount || 0), 0)
  const warnings = report.filter(r => r.status !== 'ok').length

  console.log(
    `Tamamlandı: ${report.length} site işlendi | +${totalAdded} eklendi | -${totalRemoved} silindi | ${totalSkipped} yayın akışı olmayan kanal elendi | ${warnings} uyarı`
  )
}

main().catch(err => {
  console.error('Doğrulama hatası:', err)
  process.exit(1)
})
