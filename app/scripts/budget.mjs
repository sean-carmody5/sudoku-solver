// Fails when the initial JS payload exceeds the budget. Run after a build.
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const BUDGET_KB = 60

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets')
const entry = readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f))
let total = 0
for (const f of entry) total += gzipSync(readFileSync(join(assets, f))).length
const kb = total / 1024
console.log(`initial JS: ${kb.toFixed(1)} KB gzipped (budget ${BUDGET_KB} KB)`)
if (kb > BUDGET_KB) {
  console.error('BUDGET EXCEEDED')
  process.exit(1)
}
