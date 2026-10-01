// Screenshot helper: loads the app, optionally interacts, saves PNGs.
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? 'shots'
const BASE = 'http://localhost:5199'

const browser = await chromium.launch()

async function shot(name, { theme = 'dark', mobile = false, actions } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    colorScheme: theme,
    deviceScaleFactor: mobile ? 2 : 1,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(BASE)
  await page.waitForTimeout(400)
  if (actions) await actions(page)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  if (errors.length) console.log(`[${name}] page errors:`, errors.join(' | '))
  await ctx.close()
}

const EASY_9 =
  '53..7....6..195....98....6.8...6...34..8.3..17...2...6.6....28....419..5....8..79'

async function typePuzzle(page, s) {
  const cells = page.locator('.cell')
  await cells.nth(0).click()
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '.') {
      await cells.nth(i).click()
      await page.keyboard.press(s[i])
    }
  }
}

await shot('desktop-dark-empty', {})
await shot('desktop-light-empty', {
  actions: async (page) => {
    await page.click('[aria-label*="Switch to light"]')
    await page.waitForTimeout(300)
  },
})
await shot('mobile-dark-empty', { mobile: true })
await shot('desktop-dark-filled', {
  actions: async (page) => {
    await typePuzzle(page, EASY_9)
    await page.waitForTimeout(200)
  },
})
await shot('desktop-dark-solved', {
  actions: async (page) => {
    await typePuzzle(page, EASY_9)
    await page.getByRole('button', { name: 'Solve', exact: true }).click()
    await page.waitForTimeout(2500)
  },
})
await shot('mobile-dark-16', {
  mobile: true,
  actions: async (page) => {
    await page.click('text=16×16')
    await page.waitForTimeout(300)
  },
})

await browser.close()
console.log('screenshots done')
