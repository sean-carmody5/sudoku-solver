// Functional audit: drives every feature of the app the way a person would
// (phone and desktop), checks the outcome and saves a screenshot per step.
// Prints PASS/FAIL per step; exits non-zero on any failure.
//
// Usage: node scripts/review/audit.mjs [--url http://localhost:5199/] [--out dir] [--browser chromium|webkit]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, webkit } from 'playwright'

const args = process.argv.slice(2)
const opt = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : d
}
const URL_BASE = opt('--url', 'http://localhost:5199/')
const OUT = opt('--out', join(tmpdir(), 'sudoku-audit'))
const ENGINE = opt('--browser', 'chromium')
mkdirSync(OUT, { recursive: true })

const EXAMPLE_9 = '53..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79'
const UNSOLVABLE_9 = '55..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79'
const results = []
let shot = 0

async function step(page, name, fn) {
  const file = `${String(++shot).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`
  try {
    const note = await fn()
    results.push({ name, ok: true, note })
    console.log(`PASS  ${name}${note ? `  (${note})` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, note: err.message.split('\n')[0] })
    console.log(`FAIL  ${name}  ${err.message.split('\n')[0]}`)
  }
  await page.screenshot({ path: join(OUT, file) }).catch(() => {})
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const cellText = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.grid .cell')].map((c) => c.querySelector('.value')?.textContent?.trim() || '.').join(''))
const status = (page) => page.evaluate(() => document.querySelector('.grid')?.className ?? '')
const toastText = (page) => page.locator('.toast').last().textContent({ timeout: 3000 }).catch(() => '')

async function run(label, contextOpts) {
  const engine = ENGINE === 'webkit' ? webkit : chromium
  const browser = await engine.launch()
  const context = await browser.newContext({ ...contextOpts, permissions: ENGINE === 'chromium' ? ['clipboard-read', 'clipboard-write'] : [] })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(URL_BASE, { waitUntil: 'networkidle' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'networkidle' })
  const phone = contextOpts.isMobile
  console.log(`\n== ${label} (${ENGINE}) ==`)

  await step(page, `${label} first load`, async () => {
    expect(await page.locator('.grid .cell').count() === 81, 'expected 81 cells')
    expect(await page.locator('.hint').isVisible(), 'empty-board hint not shown')
  })

  await step(page, `${label} select a cell and type a digit`, async () => {
    await page.locator('.grid .cell').nth(0).click()
    await page.keyboard.type('5')
    const cells = await cellText(page)
    expect(cells[0] === '5', `cell 1 shows '${cells[0]}'`)
    return phone ? 'typed via hardware keyboard events' : ''
  })

  await step(page, `${label} on-screen number pad and erase`, async () => {
    await page.locator('.grid .cell').nth(4).click()
    await page.getByRole('button', { name: 'Enter 7' }).click()
    let cells = await cellText(page)
    expect(cells[4] === '7', `pad put '${cells[4]}' in cell 5`)
    await page.getByRole('button', { name: 'Erase' }).click()
    cells = await cellText(page)
    expect(cells[4] === '.', 'erase did not clear cell 5')
    // Back to cell 2 for the keyboard steps.
    await page.locator('.grid .cell').nth(1).click()
  })

  await step(page, `${label} arrows, backspace, conflict`, async () => {
    // Typing moves the selection on, so the next digit lands in cell 2.
    await page.keyboard.type('5')
    let cells = await cellText(page)
    expect(cells[1] === '5', `cell 2 shows '${cells[1]}'`)
    const conflicts = await page.locator('.cell.conflict').count()
    expect(conflicts >= 2, `conflict not highlighted (${conflicts})`)
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Backspace')
    cells = await cellText(page)
    expect(cells[1] === '.', 'backspace did not clear cell 2')
  })

  await step(page, `${label} undo`, async () => {
    await page.keyboard.press('Control+z')
    const cells = await cellText(page)
    expect(cells[1] === '5', `undo did not restore the cleared 5 (got '${cells[1]}')`)
    // Then back through: typed 5, pad erase, pad 7, first 5.
    for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z')
    const after = await cellText(page)
    expect(after.replace(/\./g, '') === '', `undo did not return to empty (${after.replace(/\./g, '').length} left)`)
  })

  await step(page, `${label} example`, async () => {
    await page.getByRole('button', { name: /example/i }).first().click()
    await page.waitForTimeout(600)
    const cells = await cellText(page)
    expect(cells.replace(/\./g, '').length >= 17, 'example did not load')
  })

  await step(page, `${label} solve`, async () => {
    await page.getByRole('button', { name: /^Solve/ }).click()
    await page.waitForFunction(() => document.querySelector('.grid')?.classList.contains('solved'), null, { timeout: 15000 })
    const cells = await cellText(page)
    expect(!cells.includes('.'), 'solved grid still has blanks')
  })

  await step(page, `${label} replay and scrub`, async () => {
    await page.getByRole('button', { name: /replay/i }).click()
    await page.waitForTimeout(300)
    await page.waitForFunction(() => document.querySelector('.grid')?.classList.contains('solved'), null, { timeout: 8000 })
    const scrub = page.locator('input.scrub')
    await scrub.fill('5')
    await page.waitForTimeout(200)
    const cells = await cellText(page)
    const blanks = [...cells].filter((c) => c === '.').length
    expect(blanks > 0, 'scrubbing back did not hide placements')
    await scrub.fill(await scrub.getAttribute('max'))
  })

  await step(page, `${label} share`, async () => {
    await page.getByRole('button', { name: /^share$/i }).first().click()
    const t = await toastText(page)
    expect(/copied|link/i.test(t), `no share feedback (toast '${t}')`)
    return t
  })

  await step(page, `${label} edit puzzle`, async () => {
    await page.getByRole('button', { name: /edit puzzle/i }).click()
    await page.waitForTimeout(300)
    const s = await status(page)
    expect(!s.includes('solved'), 'still solved after Edit puzzle')
    const cells = await cellText(page)
    expect(cells.includes('.'), 'edit did not return to the givens')
  })

  await step(page, `${label} share link loads`, async () => {
    await page.goto(`${URL_BASE}#p=9:${EXAMPLE_9}`)
    await page.waitForTimeout(800)
    const cells = await cellText(page)
    expect(cells === EXAMPLE_9, 'shared puzzle not loaded')
  })

  await step(page, `${label} unsolvable puzzle`, async () => {
    await page.goto(`${URL_BASE}#p=9:${UNSOLVABLE_9}`)
    await page.waitForTimeout(800)
    const conflicts = await page.locator('.cell.conflict').count()
    const solveEnabled = await page.getByRole('button', { name: /^Solve/ }).isEnabled()
    expect(conflicts > 0 || !solveEnabled, 'clashing puzzle not flagged')
  })

  await step(page, `${label} new puzzle / clear`, async () => {
    await page.goto(`${URL_BASE}#p=9:${EXAMPLE_9}`)
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: /^Clear/ }).click()
    await page.waitForTimeout(300)
    const cells = await cellText(page)
    expect(cells.replace(/\./g, '') === '', 'clear left digits')
  })

  await step(page, `${label} 4x4 tab`, async () => {
    await page.getByRole('tab', { name: '4×4' }).click()
    await page.waitForTimeout(400)
    expect((await page.locator('.grid .cell').count()) === 16, 'not a 4x4 grid')
    await page.locator('.grid .cell').nth(0).click()
    await page.keyboard.type('3')
    const cells = await cellText(page)
    expect(cells[0] === '3', `typed 3 shows '${cells[0]}'`)
  })

  await step(page, `${label} 16x16 tab and letters`, async () => {
    await page.getByRole('tab', { name: '16×16' }).click()
    await page.waitForTimeout(500)
    expect((await page.locator('.grid .cell').count()) === 256, 'not a 16x16 grid')
    await page.locator('.grid .cell').nth(0).click()
    await page.keyboard.type('B')
    const cells = await cellText(page)
    expect(cells[0] !== '.', 'letter not entered in 16x16')
    return `cell shows '${cells[0]}'`
  })

  await step(page, `${label} 16x16 example solves`, async () => {
    await page.getByRole('button', { name: /example/i }).first().click()
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: /^Solve/ }).click()
    await page.waitForFunction(() => document.querySelector('.grid')?.classList.contains('solved'), null, { timeout: 20000 })
  })

  await step(page, `${label} back to 9x9`, async () => {
    await page.getByRole('tab', { name: '9×9' }).click()
    await page.waitForTimeout(400)
    expect((await page.locator('.grid .cell').count()) === 81, 'not 9x9')
  })

  await step(page, `${label} theme toggle`, async () => {
    const before = await page.evaluate(() => document.documentElement.dataset.theme)
    await page.getByRole('button', { name: /theme/i }).click()
    await page.waitForTimeout(500)
    const after = await page.evaluate(() => document.documentElement.dataset.theme)
    expect(before !== after, `theme stayed ${after}`)
    await page.getByRole('button', { name: /theme/i }).click()
    await page.waitForTimeout(400)
  })

  await step(page, `${label} help panel`, async () => {
    await page.getByRole('button', { name: /^help$/i }).click()
    await page.waitForTimeout(300)
    expect(await page.locator('.help').isVisible(), 'help panel not shown')
    return ''
  })

  await step(page, `${label} restore after reload`, async () => {
    await page.goto(`${URL_BASE}#p=9:${EXAMPLE_9}`)
    await page.waitForTimeout(600)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
    const cells = await cellText(page)
    expect(cells === EXAMPLE_9, 'puzzle not restored after reload')
  })

  await step(page, `${label} scan: sample photo`, async () => {
    const opener = page.locator('button.scan-cta')
    await opener.click()
    await page.waitForTimeout(1500)
    const sample = page.getByRole('button', { name: /sample/i })
    await sample.first().click()
    await page.waitForFunction(() => !document.querySelector('.scan-overlay'), null, { timeout: 45000 })
    await page.waitForTimeout(1500)
    const cells = await cellText(page)
    expect(cells.replace(/\./g, '').length >= 17, 'sample did not land digits')
    return `${cells.replace(/\./g, '').length} digits`
  })

  await step(page, `${label} hold to compare`, async () => {
    const chip = page.getByRole('button', { name: /hold to compare/i })
    const box = await chip.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(300)
    const on = await page.locator('.compare.on').count()
    await page.mouse.up()
    expect(on === 1, 'photo not shown while held')
  })

  await step(page, `${label} scan: upload a photo`, async () => {
    const opener = page.locator('button.scan-cta')
    await opener.click()
    await page.waitForTimeout(1200)
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }),
      page.getByRole('button', { name: /choose a photo/i }).first().click(),
    ])
    await chooser.setFiles(join(process.cwd(), 'public', 'samples', 'newspaper.jpg'))
    await page.waitForFunction(() => !document.querySelector('.scan-overlay'), null, { timeout: 45000 })
    await page.waitForTimeout(1200)
    const cells = await cellText(page)
    expect(cells.replace(/\./g, '').length >= 17, 'upload did not land digits')
  })

  await step(page, `${label} scan: close button`, async () => {
    const opener = page.locator('button.scan-cta')
    await opener.click()
    await page.waitForTimeout(1000)
    await page.getByRole('button', { name: 'Close' }).first().click()
    await page.waitForTimeout(700)
    expect((await page.locator('.scan-overlay').count()) === 0, 'overlay still open')
  })

  await step(page, `${label} escape closes scanner`, async () => {
    const opener = page.locator('button.scan-cta')
    await opener.click()
    await page.waitForTimeout(800)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(700)
    expect((await page.locator('.scan-overlay').count()) === 0, 'Escape did not close')
  })

  expect(true)
  if (errors.length) {
    results.push({ name: `${label} page errors`, ok: false, note: errors.slice(0, 3).join(' | ') })
    console.log(`FAIL  ${label} page errors: ${errors.slice(0, 3).join(' | ')}`)
  }
  await browser.close()
}

await run('phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: ENGINE === 'chromium', hasTouch: true })
await run('desktop', { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed; screenshots in ${OUT}`)
process.exit(failed.length ? 1 : 0)
