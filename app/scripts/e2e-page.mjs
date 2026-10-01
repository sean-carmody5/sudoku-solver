// Browser end-to-end for a high-resolution page photo: upload it, confirm the
// full-resolution second pass runs, and check the reviewed grid against an
// expected cell string. Usage:
//   node scripts/e2e-page.mjs <image> <expected-cells> [base-url]
import { chromium } from 'playwright'

const [image, expected, base = 'http://localhost:5199'] = process.argv.slice(2)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 950 } })
const logs = []
page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
await page.goto(base, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Scan', exact: true }).click()
const t0 = Date.now()
await page.locator('input[type=file]').setInputFiles(image)
await page.locator('.review').waitFor({ timeout: 120000 })
console.log(`review in ${Date.now() - t0}ms`)
const got = await page.evaluate(() =>
  [...document.querySelectorAll('.review .cell')].map((c) => c.textContent.trim() || '.').join(''),
)
const refined = logs.some((l) => l.includes('full-res pass'))
let wrong = 0
for (let i = 0; i < expected.length; i++) if (got[i] !== expected[i]) wrong++
console.log(`full-res pass ran: ${refined}`)
console.log(`cells wrong: ${wrong} / ${expected.length}`)
for (const l of logs.filter((l) => /error|full-res/.test(l))) console.log('  ', l)
await browser.close()
process.exit(wrong === 0 && refined ? 0 : 1)
