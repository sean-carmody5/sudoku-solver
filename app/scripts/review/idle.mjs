// The page at rest must do no work: lists running animations and counts style
// recalcs, animation frames and timers over a second of idling (an endlessly
// animated filter once restyled the logo 60 times a second).
// Usage: node scripts/review/idle.mjs [url]
import { chromium } from 'playwright'
const b = await chromium.launch({ args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
const page = await ctx.newPage()
await page.goto(process.argv[2] ?? 'http://localhost:5199/', { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
const anims = await page.evaluate(() => document.getAnimations().map((a) => ({ name: a.animationName ?? a.constructor.name, el: (a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? '') + '', state: a.playState, iter: a.effect?.getTiming().iterations })))
console.log('running animations at rest:', JSON.stringify(anims))
await b.startTracing(page, { categories: ['devtools.timeline'] })
await page.waitForTimeout(1000)
const ev = JSON.parse((await b.stopTracing()).toString()).traceEvents
console.log('idle style recalcs/s:', ev.filter((e) => e.name === 'UpdateLayoutTree').length, 'rAF fired:', ev.filter((e) => e.name === 'FireAnimationFrame').length, 'timers:', ev.filter((e) => e.name === 'TimerFire').length)
await b.close()
