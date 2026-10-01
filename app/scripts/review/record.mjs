// Record what a phone user sees, frame by frame, to review motion and
// smoothness: CDP screencast frames (with their compositor timestamps), the
// page's own frame timing (rAF deltas, long animation frames) and per-frame
// geometry/opacity of the elements that animate. Writes <out>/run.json and
// <out>/frames/*.jpg; `sheet.py` and `plot.py` turn them into contact sheets
// and motion plots.
//
// Usage: node scripts/review/record.mjs <flow> [--out dir] [--url http://localhost:5199/]
//          [--cpu 4] [--dpr 3] [--dark] [--no-gpu] [--track] [--profile] [--trace]
//          [--shot <shots-dir>/<name>] [--shake 18,4] [--desktop] [--photo <image>]
// --track records element geometry per frame (forces a layout each frame, so
// frame times are then pessimistic); --profile adds per-phase JS self time.
// Flows: scan    live camera on a simulated shot (default shots3/s5040-0), auto-capture, landing, solve
//        sample  the scanner's Sample photo
//        drop    a photo (--photo, default the Sample) dropped on the page
// --desktop records a 1280x800 window with a mouse instead of a phone.
//        manual  example, solve, clear, size tabs, theme toggle
//        page    first load only (entrance)
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { shakyY4m, stillY4m } from '../lib/fake-camera.mjs'

const args = process.argv.slice(2)
const flow = args[0] ?? 'scan'
const opt = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : d
}
const URL_BASE = opt('--url', 'http://localhost:5199/')
const CPU = Number(opt('--cpu', '4'))
const DPR = Number(opt('--dpr', '3'))
const OUT = opt('--out', join(tmpdir(), 'sudoku-review', `${flow}-${Date.now()}`))
const DARK = args.includes('--dark')
const SHOT = opt('--shot', null)
const SHAKE = opt('--shake', null)
const DESKTOP = args.includes('--desktop')
const VIEW = DESKTOP ? { width: 1280, height: 800 } : { width: 390, height: 844 }
const PHOTO = opt('--photo', 'public/samples/newspaper.jpg')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'frames'), { recursive: true })

let camArgs = []
if (flow === 'scan') {
  if (!SHOT) throw new Error('--shot <shots-dir>/<name> is required for the scan flow')
  const png = `${SHOT}.png`
  const y4m = SHAKE ? shakyY4m(png, SHOT.split(/[\\/]/).pop(), SHAKE) : stillY4m(png)
  camArgs = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`]
}
// A phone composites and rasterises on its GPU; headless Chromium defaults to
// software rendering, which misstates canvas, filter and compositing costs.
const GPU = args.includes('--no-gpu') ? [] : ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
const browser = await chromium.launch({ args: [...camArgs, ...GPU] })
const context = await browser.newContext({
  viewport: VIEW,
  deviceScaleFactor: DPR,
  hasTouch: !DESKTOP,
  isMobile: !DESKTOP,
  permissions: flow === 'scan' ? ['camera'] : [],
  colorScheme: DARK ? 'dark' : 'light',
})
const page = await context.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => (m.type() === 'error' ? errors.push(m.text()) : m.text().startsWith('DBG') && console.log(m.text())))

// In-page probe: frame timing, long animation frames, phase changes and the
// geometry of every animating element, once per rendered frame.
// Element geometry costs a forced layout per frame, which distorts timing:
// only with --track (for motion curves), never for frame-time numbers.
const TRACKING = args.includes('--track')
await page.addInitScript(([dark, tracking]) => {
  if (dark) localStorage.setItem('sudoku-theme', 'dark')
  else localStorage.removeItem('sudoku-theme')
  const rev = { raf: [], phases: [], loaf: [], tracks: {}, inputs: [], origin: performance.timeOrigin }
  // Real input times (the recorder's own marks include Playwright's overhead).
  for (const type of ['pointerdown', 'click']) {
    addEventListener(type, (e) => rev.inputs.push({ t: performance.now(), type, target: e.target?.className?.toString().slice(0, 40) }), true)
  }
  window.__rev = rev
  window.__camTrace = []
  const TRACK = {
    overlay: '.scan-overlay',
    stage: '.stage',
    frozen: 'canvas.frozen',
    morph: '.morph',
    grid: '.grid',
    cell0: '.grid .cell',
    guide: '.guide',
    pill: '.pill',
    banner: '.banner',
    toast: '.toast',
    fab: '.scan-cta',
    solve: '.solve-controls, .controls',
  }
  const phase = () => {
    const ov = document.querySelector('.scan-overlay')
    if (!ov) return document.querySelector('.grid.solved') ? 'board:solved' : 'board'
    if (document.querySelector('.morph')) return 'landing'
    if (document.querySelector('canvas.frozen')) return document.querySelector('.pill') ? 'processing' : 'frozen'
    const g = document.querySelector('.guide')?.textContent?.trim()
    return g ? `camera:${g}` : 'camera'
  }
  let last = ''
  const loop = (t) => {
    rev.raf.push(t)
    const ph = phase()
    if (ph !== last) {
      rev.phases.push({ t, phase: ph })
      last = ph
    }
    if (tracking) for (const [k, sel] of Object.entries(TRACK)) {
      const el = document.querySelector(sel)
      if (!el) continue
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      ;(rev.tracks[k] ??= []).push([+t.toFixed(1), +r.x.toFixed(1), +r.y.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1), +(+cs.opacity).toFixed(3)])
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        rev.loaf.push({
          t: e.startTime,
          dur: e.duration,
          block: e.blockingDuration,
          scripts: (e.scripts ?? [])
            .slice(0, 3)
            .map((s) => ({ fn: s.sourceFunctionName, src: (s.sourceURL ?? '').split('/').pop(), dur: Math.round(s.duration) })),
        })
      }
    }).observe({ type: 'long-animation-frame', buffered: true })
  } catch {
    /* not supported */
  }
}, [DARK, TRACKING])

const cdp = await context.newCDPSession(page)
const frames = []
let frameNo = 0
cdp.on('Page.screencastFrame', async (f) => {
  const file = `f${String(frameNo++).padStart(5, '0')}.jpg`
  writeFileSync(join(OUT, 'frames', file), Buffer.from(f.data, 'base64'))
  frames.push({ file, ts: f.metadata.timestamp * 1000 })
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
})

const marks = []
const mark = async (label) => marks.push({ t: await page.evaluate(() => performance.now()), label })

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' })
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: VIEW.width * 2, maxHeight: VIEW.height * 2, everyNthFrame: 1 })
await page.reload({ waitUntil: 'networkidle' })
if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
await mark('loaded')
await page.waitForTimeout(1600)

// Optional JS sampling profile, attributed to phases afterwards.
const PROFILE = args.includes('--profile')
let profOffset = 0
if (PROFILE) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  profOffset = await page.evaluate(() => performance.now())
}

// Optional Chrome trace: renderer main-thread work (style, layout, paint,
// compositing...) per phase.
const TRACE = args.includes('--trace')
let traceSync = 0
if (TRACE) {
  await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] })
  traceSync = await page.evaluate(() => {
    const t = performance.now()
    console.timeStamp('REVIEW_SYNC')
    return t
  })
}

// Resolve the target first, let that settle, then tap its coordinates:
// Playwright's role queries and actionability checks run inside the page and
// would otherwise be counted as the app's own frame time.
const tap = async (locator, label) => {
  const box = await locator.first().boundingBox()
  await page.waitForTimeout(300)
  await mark(label)
  if (DESKTOP) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  else await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
}

if (flow === 'scan' || flow === 'sample') {
  await tap(page.locator('button.scan-cta'), 'tap scan')
  if (flow === 'sample') {
    await page.waitForTimeout(1500)
    await tap(page.getByRole('button', { name: /^Try a sample/ }), 'tap sample')
  }
  await page
    .waitForFunction(() => !document.querySelector('.scan-overlay') || document.querySelector('.guide.warn'), null, { timeout: 60000 })
    .catch(() => {})
  await mark('overlay closed')
  await page.waitForTimeout(3500)
} else if (flow === 'drop') {
  // A file dragged over the page, then dropped (the page shows its drop state).
  await page.waitForTimeout(1200)
  const dt = await page.evaluateHandle(
    ({ b64, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], name, { type: 'image/jpeg' }))
      return data
    },
    { b64: readFileSync(PHOTO).toString('base64'), name: PHOTO.split(/[\\/]/).pop() },
  )
  await mark('drag over')
  await page.dispatchEvent('body', 'dragenter', { dataTransfer: dt })
  await page.dispatchEvent('body', 'dragover', { dataTransfer: dt })
  await page.waitForTimeout(900)
  await mark('drop')
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt })
  await page.waitForFunction(() => document.querySelector('.grid')?.classList.contains('solved'), null, { timeout: 60000 }).catch(() => {})
  await mark('solved')
  await page.waitForTimeout(2500)
} else if (flow === 'manual') {
  await tap(page.getByRole('button', { name: 'Try an example' }), 'tap example')
  await page.waitForTimeout(1200)
  await tap(page.getByRole('button', { name: /^Solve/ }), 'tap solve')
  await page.waitForTimeout(3000)
  await tap(page.getByRole('button', { name: /^New puzzle/ }), 'tap new puzzle')
  await page.waitForTimeout(1200)
  for (const size of ['4×4', '16×16', '9×9']) {
    await tap(page.getByRole('tab', { name: size }).or(page.getByRole('button', { name: size })), `tab ${size}`)
    await page.waitForTimeout(900)
  }
  await tap(page.getByRole('button', { name: /theme|dark|light/i }), 'toggle theme')
  await page.waitForTimeout(1200)
} else {
  await page.waitForTimeout(800)
}
await mark('end')

let traceBuf = null
if (TRACE) traceBuf = await browser.stopTracing()
let profile = null
if (PROFILE) {
  const perfAtStop = await page.evaluate(() => performance.now())
  profile = (await cdp.send('Profiler.stop')).profile
  profile.perfAtStop = perfAtStop
  profile.perfAtStart = profOffset
}
await cdp.send('Page.stopScreencast').catch(() => {})
await page.waitForTimeout(300)
const rev = await page.evaluate(() => window.__rev)
await browser.close()

// Frame timestamps relative to the page's time origin (same clock as rAF).
for (const f of frames) f.t = +(f.ts - rev.origin).toFixed(1)

// Frame-time summary per phase: deltas over 1.5 vsyncs are dropped frames.
const summary = []
const bounds = rev.phases.map((p, i) => ({ ...p, phase: `${i}:${p.phase}`, end: rev.phases[i + 1]?.t ?? Infinity }))
for (const b of bounds) {
  const ts = rev.raf.filter((t) => t >= b.t && t < b.end)
  const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, c) => a - c)
  if (d.length === 0) continue
  const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))]
  const loaf = rev.loaf.filter((l) => l.t >= b.t && l.t < b.end)
  summary.push({
    phase: b.phase,
    start: Math.round(b.t),
    ms: Math.round(Math.min(b.end, ts.at(-1)) - b.t),
    frames: d.length,
    p50: +q(0.5).toFixed(1),
    p95: +q(0.95).toFixed(1),
    max: +d.at(-1).toFixed(1),
    dropped: d.filter((x) => x > 25).length,
    longFrames: loaf.length,
    worstBlock: Math.round(Math.max(0, ...loaf.map((l) => l.block))),
  })
}
// Self time per function in each phase (sample timestamps are mapped onto
// the page clock by pinning the profile's end to the stop time).
const hot = {}
if (profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  let ts = profile.endTime
  const times = new Array(profile.samples.length)
  for (let i = profile.samples.length - 1; i >= 0; i--) {
    times[i] = ts
    ts -= profile.timeDeltas[i] ?? 0
  }
  const toPage = (us) => profile.perfAtStop - (profile.endTime - us) / 1000
  for (let i = 0; i < profile.samples.length; i++) {
    const t = toPage(times[i])
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000
    const b = bounds.find((x) => t >= x.t && t < x.end)
    if (!b) continue
    const n = byId.get(profile.samples[i])
    const f = n.callFrame
    const name = f.functionName || (f.url ? '(anon)' : n.callFrame.functionName || '(program)')
    const key = `${name} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber + 1}`
    const ph = (hot[b.phase] ??= {})
    ph[key] = (ph[key] ?? 0) + dt
  }
  for (const [ph, m] of Object.entries(hot)) {
    hot[ph] = Object.entries(m)
      .sort((a, c) => c[1] - a[1])
      .slice(0, 12)
      .map(([k, v]) => `${v.toFixed(0).padStart(5)} ms  ${k}`)
  }
  writeFileSync(join(OUT, 'profile.cpuprofile'), JSON.stringify(profile))
}
// Renderer main-thread time by event name per phase, from the trace.
const work = {}
if (traceBuf) {
  const events = JSON.parse(traceBuf.toString()).traceEvents
  const sync = events.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === 'REVIEW_SYNC')
  const main = new Set(
    events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`),
  )
  if (sync) {
    const offset = sync.ts / 1000 - traceSync
    const NAMES = new Set(['UpdateLayoutTree', 'Layout', 'Paint', 'PrePaint', 'Layerize', 'Commit', 'UpdateLayer', 'CompositeLayers', 'ParseHTML', 'FunctionCall', 'EvaluateScript', 'FireAnimationFrame', 'EventDispatch', 'TimerFire', 'MajorGC', 'MinorGC', 'HitTest', 'ScrollLayer', 'RunMicrotasks', 'v8.run'])
    for (const e of events) {
      if (e.ph !== 'X' || !main.has(`${e.pid}:${e.tid}`) || !NAMES.has(e.name)) continue
      const t = e.ts / 1000 - offset
      const b = bounds.find((x) => t >= x.t && t < x.end)
      if (!b) continue
      const w = (work[b.phase] ??= {})
      w[e.name] = (w[e.name] ?? 0) + (e.dur ?? 0) / 1000
    }
    for (const [ph, w] of Object.entries(work)) {
      work[ph] = Object.fromEntries(Object.entries(w).sort((a, c) => c[1] - a[1]).map(([k, v]) => [k, Math.round(v)]))
    }
  }
  writeFileSync(join(OUT, 'trace.json'), traceBuf)
}
writeFileSync(join(OUT, "run.json"), JSON.stringify({ flow, cpu: CPU, dpr: DPR, dark: DARK, frames, marks, errors, summary, hot, work, traceSync, ...rev }))
console.log(`${frames.length} frames -> ${OUT}`)
console.table(summary)
// Tap to response: the first phase change after each pointerdown.
for (const inp of rev.inputs.filter((x) => x.type === 'pointerdown')) {
  const next = rev.phases.find((p) => p.t > inp.t)
  const click = rev.inputs.find((x) => x.type === 'click' && x.t >= inp.t)
  console.log(`tap ${inp.target}: click +${click ? Math.round(click.t - inp.t) : '-'} ms, next phase ${next ? `${next.phase} +${Math.round(next.t - inp.t)} ms` : '-'}`)
}
if (errors.length) console.log('page errors:', errors.slice(0, 5))
for (const [ph, w] of Object.entries(work)) console.log(`[${ph}] ${JSON.stringify(w)}`)
for (const [ph, lines] of Object.entries(hot)) console.log(['', `[${ph}]`, ...lines].join(String.fromCharCode(10)))
