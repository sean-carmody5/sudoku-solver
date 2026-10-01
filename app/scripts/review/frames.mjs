// Per-frame breakdown of renderer main-thread work in a window of a traced
// run (record.mjs --trace): each rAF-to-rAF frame with its style, layout,
// paint, layerize and script time, to find what costs a dropped frame.
// Usage: node scripts/review/frames.mjs <run-dir> <phase-index> [maxRows]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, idx, max = '40'] = process.argv.slice(2)
const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
const events = JSON.parse(readFileSync(join(dir, 'trace.json'), 'utf8')).traceEvents
const sync = events.find((e) => e.name === 'TimeStamp' && e.args?.data?.message === 'REVIEW_SYNC')
const offset = sync.ts / 1000 - run.traceSync
const main = new Set(events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`))
const i = Number(idx)
const t0 = run.phases[i].t
const t1 = run.phases[i + 1]?.t ?? Infinity
const raf = run.raf.filter((t) => t >= t0 && t < t1)
const KEYS = { UpdateLayoutTree: 'style', Layout: 'layout', Paint: 'paint', PrePaint: 'prepaint', Layerize: 'layerize', Commit: 'commit', FunctionCall: 'js', TimerFire: 'timer', FireAnimationFrame: 'raf' }
const ev = events.filter((e) => e.ph === 'X' && main.has(`${e.pid}:${e.tid}`) && KEYS[e.name]).map((e) => ({ ...e, t: e.ts / 1000 - offset, d: (e.dur ?? 0) / 1000 }))
console.log(`phase ${run.phases[i].phase}: ${raf.length} frames`)
const rows = []
for (let k = 1; k < raf.length; k++) {
  const a = raf[k - 1]
  const b = raf[k]
  const sum = {}
  const styleArgs = []
  for (const e of ev) {
    if (e.t < a || e.t >= b) continue
    sum[KEYS[e.name]] = (sum[KEYS[e.name]] ?? 0) + e.d
    if (e.name === 'UpdateLayoutTree' && e.args?.elementCount) styleArgs.push(e.args.elementCount)
  }
  rows.push({ at: Math.round(a - t0), gap: +(b - a).toFixed(1), ...Object.fromEntries(Object.entries(sum).map(([k2, v]) => [k2, +v.toFixed(1)])), styled: styleArgs.join('+') })
}
console.table(rows.slice(0, Number(max)))
