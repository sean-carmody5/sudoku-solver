// Clips for Chrome's fake camera (--use-file-for-fake-video-capture): a still
// repeated, or a hand-held clip (shake_y4m.py). Shared by the live E2E and
// the review recorder.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PNG } from 'pngjs'

const APP = join(import.meta.dirname, '..', '..')
const PY = join(APP, '..', 'model', '.venv', 'Scripts', 'python')

/**
 * Chrome's fake camera crops a portrait file to satisfy the app's landscape
 * request, so a portrait frame is placed (scaled to 1080 tall) in the middle
 * of a 1920x1080 landscape frame: the phone's fullscreen view then shows
 * exactly the portrait frame. Returns RGBA.
 */
export function landscape(png) {
  const W = 1920
  const H = 1080
  const k = H / png.height
  const cw = Math.round(png.width * k)
  const x0 = (W - cw) >> 1
  const out = Buffer.alloc(W * H * 4)
  const sample = (sx, sy, c) => {
    const x = Math.min(png.width - 1, Math.max(0, sx))
    const y = Math.min(png.height - 1, Math.max(0, sy))
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const fx = x - xi
    const fy = y - yi
    const at = (xx, yy) => png.data[(Math.min(png.height - 1, yy) * png.width + Math.min(png.width - 1, xx)) * 4 + c]
    return at(xi, yi) * (1 - fx) * (1 - fy) + at(xi + 1, yi) * fx * (1 - fy) + at(xi, yi + 1) * (1 - fx) * fy + at(xi + 1, yi + 1) * fx * fy
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inside = x >= x0 && x < x0 + cw
      const sx = inside ? (x - x0 + 0.5) / k - 0.5 : x < x0 ? 0 : png.width - 1
      for (let c = 0; c < 3; c++) out[(y * W + x) * 4 + c] = inside ? sample(sx, (y + 0.5) / k - 0.5, c) : 40
      out[(y * W + x) * 4 + 3] = 255
    }
  }
  return { width: W, height: H, data: out }
}

/** Colour y4m (4:2:0, limited range) of one still (PNG path), repeated. */
export function stillY4m(pngPath, frames = 30) {
  const src = PNG.sync.read(readFileSync(pngPath))
  const png = src.height > src.width ? landscape(src) : src
  const { width: W, height: H, data } = png
  const y = Buffer.alloc(W * H)
  const u = Buffer.alloc((W >> 1) * (H >> 1))
  const v = Buffer.alloc((W >> 1) * (H >> 1))
  for (let i = 0; i < W * H; i++) {
    y[i] = Math.round(16 + 0.257 * data[i * 4] + 0.504 * data[i * 4 + 1] + 0.098 * data[i * 4 + 2])
  }
  for (let yy = 0; yy < H >> 1; yy++) {
    for (let xx = 0; xx < W >> 1; xx++) {
      let r = 0
      let g = 0
      let b = 0
      for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        const i = ((yy * 2 + dy) * W + xx * 2 + dx) * 4
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
      }
      r /= 4
      g /= 4
      b /= 4
      const k = yy * (W >> 1) + xx
      u[k] = Math.round(128 - 0.148 * r - 0.291 * g + 0.439 * b)
      v[k] = Math.round(128 + 0.439 * r - 0.368 * g - 0.071 * b)
    }
  }
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F15:1 Ip A1:1 C420jpeg\n`)]
  for (let f = 0; f < frames; f++) parts.push(Buffer.from('FRAME\n'), y, u, v)
  const path = join(tmpdir(), `sudoku-live-${process.pid}-${Date.now()}.y4m`)
  writeFileSync(path, Buffer.concat(parts))
  return path
}

/** Hand-held clip of one stream frame; `shake` is "drift,tremor" in px. */
export function shakyY4m(pngPath, name, shake) {
  const [drift, tremor] = shake.split(',')
  const path = join(tmpdir(), `sudoku-shake-${name}-${shake.replace(',', '_')}.y4m`)
  execFileSync(PY, [join(APP, 'scripts', 'screen', 'shake_y4m.py'), pngPath, path, '--drift', drift, '--tremor', tremor])
  return path
}
