// UI screenshot tour: loads the app in several states and saves PNGs.
// Usage: node scripts/shots.mjs [outdir] [base-url]
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? 'shots'
const BASE = process.argv[3] ?? 'http://localhost:5199'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()

async function shot(name, { theme = 'dark', mobile = false, actions, settle = 500 } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    colorScheme: theme,
    deviceScaleFactor: mobile ? 2 : 1,
    reducedMotion: 'no-preference',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.locator('.grid').waitFor({ timeout: 15000 })
  if (theme === 'light') {
    await page.evaluate(() => {
      localStorage.setItem('sudoku-theme', 'light')
    })
    await page.reload({ waitUntil: 'networkidle' })
    await page.locator('.grid').waitFor()
  }
  await page.waitForTimeout(300)
  if (actions) await actions(page)
  await page.waitForTimeout(settle)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  if (errors.length) console.log(`[${name}] page errors:`, errors.join(' | '))
  await ctx.close()
  console.log(`  ${name}`)
}

const example = async (page) => {
  await page.getByRole('button', { name: 'Try an example' }).click()
  await page.waitForTimeout(200)
}

await shot('desktop-dark-empty')
await shot('desktop-light-empty', { theme: 'light' })
await shot('mobile-dark-empty', { mobile: true })
await shot('desktop-dark-example', { actions: example })
await shot('desktop-dark-selected', {
  actions: async (page) => {
    await example(page)
    await page.locator('.cell').nth(4 * 9 + 4).click()
  },
})
await shot('desktop-light-selected', {
  theme: 'light',
  actions: async (page) => {
    await example(page)
    await page.locator('.cell').nth(4 * 9 + 4).click()
  },
})
await shot('desktop-dark-solving', {
  settle: 350,
  actions: async (page) => {
    await example(page)
    await page.getByRole('button', { name: /^Solve/ }).click()
  },
})
await shot('desktop-dark-solved', {
  settle: 2600,
  actions: async (page) => {
    await example(page)
    await page.getByRole('button', { name: /^Solve/ }).click()
  },
})
await shot('desktop-dark-help', {
  actions: async (page) => {
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
  },
})
await shot('mobile-dark-solved', {
  mobile: true,
  settle: 2600,
  actions: async (page) => {
    await example(page)
    await page.getByRole('button', { name: /^Solve/ }).click()
  },
})
await shot('mobile-dark-16', {
  mobile: true,
  actions: async (page) => {
    await page.click('text=16×16')
    await page.waitForTimeout(200)
    await example(page)
  },
})
await shot('desktop-dark-scan', {
  actions: async (page) => {
    await page.getByRole('button', { name: 'Scan', exact: true }).click()
  },
})

await browser.close()
console.log('screenshots done')
