// Screenshots of key states (phone and desktop, light and dark) for a quick
// visual review. Usage: node scripts/review/snap.mjs <out-dir> [url]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const out = process.argv[2]
const url = process.argv[3] ?? 'http://localhost:5199/'
mkdirSync(out, { recursive: true })
const PUZZLE = '8..........36......7..9.2...5...7.......457.....1...3...1....68..85...1..9....4..'
const b = await chromium.launch()
for (const [dev, view] of [['phone', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }], ['desktop', { width: 1280, height: 820 }]]) {
  for (const theme of ['light', 'dark']) {
    const { width, height, ...rest } = view
    const ctx = await b.newContext({ viewport: { width, height }, ...rest })
    const p = await ctx.newPage()
    await p.addInitScript((t) => (t === 'dark' ? localStorage.setItem('sudoku-theme', 'dark') : localStorage.removeItem('sudoku-theme')), theme)
    await p.goto(url, { waitUntil: 'networkidle' })
    await p.waitForTimeout(700)
    await p.screenshot({ path: join(out, `${dev}-${theme}-1-empty.png`) })
    await p.goto(`${url}#p=9:${PUZZLE}`)
    await p.waitForTimeout(700)
    await p.locator('.grid .cell').nth(10).click()
    await p.waitForTimeout(300)
    await p.screenshot({ path: join(out, `${dev}-${theme}-2-editing.png`) })
    await p.getByRole('button', { name: /^Solve/ }).click()
    await p.waitForFunction(() => document.querySelector('.grid')?.classList.contains('solved'), null, { timeout: 15000 })
    await p.waitForTimeout(1500)
    await p.screenshot({ path: join(out, `${dev}-${theme}-3-solved.png`) })
    await ctx.close()
  }
}
await b.close()
