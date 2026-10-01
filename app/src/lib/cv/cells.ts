/**
 * TypeScript port of model/common.py `cell_to_tensor` - the canonical cell
 * normalisation shared between training data generation and inference.
 * Any change here MUST match common.py; parity is enforced by golden tests.
 */

import { labelComponents } from './components'
import type { GrayImage } from './image'
import { otsuThreshold } from './threshold'

export const TENSOR_SIZE = 32
const GLYPH_SIZE = 24
export const EMPTY_INK_RATIO = 0.008
const MIN_COMPONENT_FRACTION = 0.08
const MIN_COMPONENT_PIXELS = 4
const BORDER_BAND_FRACTION = 0.06
const FLATFIELD_KERNEL_FRACTION = 0.2
/** Second-look kernel for glyphs blurred into solid blobs (see cellToTensor). */
const BLOB_KERNEL_FRACTION = 0.45
/** Below this ink ratio the first pass found at most slivers of a glyph. */
const BLOB_RETRY_INK = 0.03
// Otsu on a noise-only (empty) cell splits the noise in half; after
// flat-fielding, real ink is far darker than noise, so floor the threshold.
const MIN_INK_LEVEL = 24
// Intensity gate around the kept ink, as a fraction of the cell side.
const GATE_RADIUS_FRACTION = 0.035
// Percentile of in-gate intensities mapped to full brightness.
const CONTRAST_PERCENTILE = 0.95
// Halftone guard: this many kept blobs with the largest under this fraction
// of the kept ink reads as a screened fill, not a glyph.
const TEXTURE_MIN_COMPONENTS = 12
const TEXTURE_MAX_LARGEST_FRACTION = 0.2
// A printed given spans well over a third of its cell; ink smaller than
// this fraction of the cell side is a pencilled candidate, a speck or a
// stray mark, never a digit to read.
const MIN_GLYPH_FRACTION = 0.3

// Polarity: a cell whose bright tail sits this much further from its median
// than its dark tail (and by at least POLARITY_MIN_SPREAD grey levels) has
// light ink on a dark ground - a dark-mode screen, a selected or highlighted
// cell - and is read as its negative.
const POLARITY_RATIO = 1.5
const POLARITY_MIN_SPREAD = 40
// ...and the bright part is a thin tail (strokes), not a region: the 75th
// percentile stays near the median. A cell half in shadow has a bright
// region, and must not be flipped.
const POLARITY_TAIL = 0.35
// Candidates: several marks none of which reaches CANDIDATE_MAX_FRACTION of
// the cell side, either spread over the cell (centres over CANDIDATE_SPREAD
// of the side apart) or all away from its middle (an app lays them out in a
// 3x3 of slots) - candidate digits, pencilled notes - are notes, not a digit.
// A blurred printed digit also breaks into small pieces, but they sit close
// together around the middle (measured on the newspaper dataset: 2 of 661
// multi-piece digits caught, against 83% of pencil cells in app screenshots).
const CANDIDATE_MAX_FRACTION = 0.3
const CANDIDATE_SPREAD = 0.5
const CANDIDATE_OFF_CENTRE = 0.25

/** Cell crop margin relative to cell size (matches the training distribution). */
export const CELL_MARGIN = 0.12

export interface CellTensor {
  /** 32x32 float32 in [-1, 1]; background is -1. */
  tensor: Float32Array
  inkRatio: number
  isEmpty: boolean
}

const roundHalfUp = (x: number): number => Math.floor(x + 0.5)

/**
 * Separable sliding max/min with replicate borders (axis 0 then 1). A
 * replicate border never adds a value that is not already inside the
 * clamped window, so this equals a plain windowed extremum over valid
 * indices - computed here in O(n) per line with a monotonic deque instead
 * of k passes (common.py keeps the k-pass form; the results are identical).
 */
function slidingExtremum(src: Float32Array, w: number, h: number, k: number, useMax: boolean): Float32Array {
  const half = k >> 1
  const deque = new Int32Array(Math.max(w, h))
  // Axis 0: down each column, then axis 1: along each row. The max and min
  // loops are written out separately - this runs per cell, and the closures
  // of a shared version cost more than the arithmetic.
  const pass1 = new Float32Array(w * h)
  for (let x = 0; x < w; x++) {
    if (useMax) runMax(src, pass1, h, x, w, half, deque)
    else runMin(src, pass1, h, x, w, half, deque)
  }
  const pass2 = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    if (useMax) runMax(pass1, pass2, w, y * w, 1, half, deque)
    else runMin(pass1, pass2, w, y * w, 1, half, deque)
  }
  return pass2
}

/** Windowed max over one line (monotonic deque, replicate borders). */
function runMax(input: Float32Array, out: Float32Array, n: number, base: number, stride: number, half: number, deque: Int32Array): void {
  let head = 0
  let tail = 0
  for (let i = 0; i < n; i++) {
    const v = input[base + i * stride]
    // Drop candidates the new value dominates from the back.
    while (tail > head && v >= input[base + deque[tail - 1] * stride]) tail--
    deque[tail++] = i
    // Once i (the right edge of the window centred at c) is in, emit c.
    const c = i - half
    if (c >= 0) {
      while (deque[head] < c - half) head++
      out[base + c * stride] = input[base + deque[head] * stride]
    }
  }
  // Windows whose right edge is clamped at n-1.
  for (let c = Math.max(0, n - half); c < n; c++) {
    while (deque[head] < c - half) head++
    out[base + c * stride] = input[base + deque[head] * stride]
  }
}

/** Windowed min over one line (mirror of runMax). */
function runMin(input: Float32Array, out: Float32Array, n: number, base: number, stride: number, half: number, deque: Int32Array): void {
  let head = 0
  let tail = 0
  for (let i = 0; i < n; i++) {
    const v = input[base + i * stride]
    while (tail > head && v <= input[base + deque[tail - 1] * stride]) tail--
    deque[tail++] = i
    const c = i - half
    if (c >= 0) {
      while (deque[head] < c - half) head++
      out[base + c * stride] = input[base + deque[head] * stride]
    }
  }
  for (let c = Math.max(0, n - half); c < n; c++) {
    while (deque[head] < c - half) head++
    out[base + c * stride] = input[base + deque[head] * stride]
  }
}

/**
 * Illumination correction by division with a grayscale-closing background.
 * `size` sets the closing kernel (defaults to the image's short side).
 */
function flatfield(
  gray: GrayImage,
  size = Math.min(gray.width, gray.height),
  fraction = FLATFIELD_KERNEL_FRACTION,
): Uint8Array {
  const { data, width: w, height: h } = gray
  const k = Math.max(3, roundHalfUp(size * fraction)) | 1
  const f = Float32Array.from(data)
  const dilated = slidingExtremum(f, w, h, k, true)
  const bg = slidingExtremum(dilated, w, h, k, false)
  const out = new Uint8Array(w * h)
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.floor(Math.min(data[i] / Math.max(bg[i], 1), 1) * 255)
  }
  return out
}

/** Bilinear resize with pixel-centre alignment; mirrors common.py. */
function resizeBilinear(src: Float32Array, inW: number, inH: number, outW: number, outH: number): Float32Array {
  const out = new Float32Array(outW * outH)
  for (let oy = 0; oy < outH; oy++) {
    let sy = (oy + 0.5) * (inH / outH) - 0.5
    sy = Math.min(inH - 1, Math.max(0, sy))
    const y0 = Math.floor(sy)
    const y1 = Math.min(y0 + 1, inH - 1)
    const wy = sy - y0
    for (let ox = 0; ox < outW; ox++) {
      let sx = (ox + 0.5) * (inW / outW) - 0.5
      sx = Math.min(inW - 1, Math.max(0, sx))
      const x0 = Math.floor(sx)
      const x1 = Math.min(x0 + 1, inW - 1)
      const wx = sx - x0
      const top = src[y0 * inW + x0] * (1 - wx) + src[y0 * inW + x1] * wx
      const bot = src[y1 * inW + x0] * (1 - wx) + src[y1 * inW + x1] * wx
      out[oy * outW + ox] = top * (1 - wy) + bot * wy
    }
  }
  return out
}

/** Binary dilation with a (2r+1)^2 square element; mirrors cv2.dilate. A
 * square element is separable, so two 1-D passes replace the (2r+1)^2 scan. */
function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let v = 0
      const lo = Math.max(0, x - r)
      const hi = Math.min(w - 1, x + r)
      for (let sx = lo; sx <= hi; sx++) {
        if (mask[row + sx]) {
          v = 1
          break
        }
      }
      tmp[row + x] = v
    }
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const lo = Math.max(0, y - r)
    const hi = Math.min(h - 1, y + r)
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let sy = lo; sy <= hi; sy++) {
        if (tmp[sy * w + x]) {
          v = 1
          break
        }
      }
      out[y * w + x] = v
    }
  }
  return out
}

/**
 * Exact shortcut for blank cells (most of any grid). The flat field divides
 * each pixel by a background that never exceeds the crop's brightest pixel,
 * and a pixel only becomes ink when its flat-fielded value falls below
 * 231 (inverted: above MIN_INK_LEVEL = 24). If even the darkest pixel of the
 * region clears that against the brightest of the whole crop, the mask is
 * empty and the full path would return emptyResult(0) too.
 */
function surelyBlank(cell: GrayImage, r: { x0: number; y0: number; x1: number; y1: number }): boolean {
  const { data, width } = cell
  let max = 1
  for (let i = 0; i < data.length; i++) if (data[i] > max) max = data[i]
  let min = 255
  for (let y = r.y0; y < r.y1; y++) {
    const row = y * width
    for (let x = r.x0; x < r.x1; x++) if (data[row + x] < min) min = data[row + x]
  }
  // One grey level of slack keeps float rounding in the division on the safe side.
  return min * 255 >= (256 - MIN_INK_LEVEL) * max
}

/**
 * The blob rescue's acceptance test: one component carrying nearly all the
 * ink, solid (a filled blob, not a stroke or a speck), glyph-sized, centred
 * and clear of the cell edges.
 */
function isGlyphBlob(
  c: { size: number; x0: number; y0: number; x1: number; y1: number },
  kept: number,
  w: number,
  h: number,
  band: number,
): boolean {
  const bw = c.x1 - c.x0 + 1
  const bh = c.y1 - c.y0 + 1
  const cx = (c.x0 + c.x1) / 2
  const cy = (c.y0 + c.y1) / 2
  return (
    c.size >= 0.85 * kept &&
    c.size >= 0.35 * bw * bh &&
    bh >= 0.35 * h &&
    bh <= 0.85 * h &&
    bw >= 0.18 * w &&
    bw <= 0.75 * w &&
    Math.abs(cx - w / 2) <= 0.2 * w &&
    Math.abs(cy - h / 2) <= 0.2 * h &&
    c.x0 > band + 1 &&
    c.y0 > band + 1 &&
    c.x1 < w - band - 2 &&
    c.y1 < h - band - 2
  )
}

function emptyResult(inkRatio: number): CellTensor {
  return { tensor: new Float32Array(TENSOR_SIZE * TENSOR_SIZE).fill(-1), inkRatio, isEmpty: true }
}

/** Canonical normalisation: grayscale cell crop -> 32x32 tensor in [-1,1]. */
/** A sub-rectangle of a crop (x1/y1 exclusive). */
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Normalise one cell crop. With `inner`, the flat field is estimated over
 * the whole crop but everything else works on that region: a glyph that
 * reaches the region's edge then still has paper beyond it, so the closing
 * does not mistake its edge-touching stroke for background (which hollowed
 * out tall printed digits cut by the cell margin). The closing kernel is
 * sized from the region, so an interior glyph normalises exactly as a bare
 * crop of the region would.
 */
export function cellToTensor(cell: GrayImage, inner?: Rect): CellTensor {
  const region = inner ?? { x0: 0, y0: 0, x1: cell.width, y1: cell.height }
  if (lightOnDark(cell)) cell = negative(cell)
  if (surelyBlank(cell, region)) return emptyResult(0)
  const first = normalise(cell, region, FLATFIELD_KERNEL_FRACTION, false)
  if (!first.isEmpty && first.inkRatio >= BLOB_RETRY_INK) return first
  // Blob rescue: a blurred glyph whose strokes have merged (an 8 or a 0 with
  // its loops filled in, on a soft low-resolution photo) is wider than the
  // flat-field kernel, so the background estimate swallows it and the cell
  // reads empty. Look again with a wider kernel, accepting only one solid,
  // centred, glyph-sized blob clear of the edges - never a shadow edge or
  // texture, which the normal pass exists to flatten.
  const second = normalise(cell, region, BLOB_KERNEL_FRACTION, true)
  return second.isEmpty || second.inkRatio <= first.inkRatio ? first : second
}

/** The k-th smallest grey level at fraction p (index floor(p * (n - 1))). */
function quantile(hist: Uint32Array, n: number, p: number): number {
  const k = Math.floor(p * (n - 1))
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc > k) return v
  }
  return 255
}

/** Light ink on a dark ground: the bright tail is much further from the
 * median than the dark tail, and is only a tail. */
function lightOnDark(cell: GrayImage): boolean {
  const hist = new Uint32Array(256)
  const { data } = cell
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  const lo = quantile(hist, data.length, 0.02)
  const mid = quantile(hist, data.length, 0.5)
  const upper = quantile(hist, data.length, 0.75)
  const hi = quantile(hist, data.length, 0.98)
  return (
    hi - mid >= POLARITY_MIN_SPREAD && hi - mid > POLARITY_RATIO * (mid - lo) && upper - mid < POLARITY_TAIL * (hi - mid)
  )
}

/** Several small marks, spread over the cell or all off its middle:
 * candidate notes. Coordinates are in the w x h region. */
function isCandidates(comps: { x0: number; y0: number; x1: number; y1: number }[], w: number, h: number): boolean {
  const side = Math.min(w, h)
  let tallest = 0
  for (const c of comps) tallest = Math.max(tallest, c.x1 - c.x0 + 1, c.y1 - c.y0 + 1)
  if (tallest >= CANDIDATE_MAX_FRACTION * side) return false
  let nearest = Infinity
  for (const c of comps) nearest = Math.min(nearest, Math.hypot((c.x0 + c.x1 - w) / 2, (c.y0 + c.y1 - h) / 2))
  if (nearest > CANDIDATE_OFF_CENTRE * side) return true
  let spread = 0
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      const dx = (comps[i].x0 + comps[i].x1 - comps[j].x0 - comps[j].x1) / 2
      const dy = (comps[i].y0 + comps[i].y1 - comps[j].y0 - comps[j].y1) / 2
      spread = Math.max(spread, Math.hypot(dx, dy))
    }
  }
  return spread > CANDIDATE_SPREAD * side
}

function negative(cell: GrayImage): GrayImage {
  const out = new Uint8Array(cell.data.length)
  for (let i = 0; i < out.length; i++) out[i] = 255 - cell.data[i]
  return { data: out, width: cell.width, height: cell.height }
}

function normalise(cell: GrayImage, region: Rect, kernelFraction: number, blobOnly: boolean): CellTensor {
  const w = region.x1 - region.x0
  const h = region.y1 - region.y0
  const flat = flatfield(cell, Math.min(w, h), kernelFraction)
  const inv = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const src = (y + region.y0) * cell.width + region.x0
    for (let x = 0; x < w; x++) inv[y * w + x] = 255 - flat[src + x]
  }
  const t = Math.max(otsuThreshold(inv), MIN_INK_LEVEL)
  const mask = new Uint8Array(w * h)
  for (let i = 0; i < mask.length; i++) mask[i] = inv[i] > t ? 1 : 0

  const band = Math.max(1, roundHalfUp(Math.min(w, h) * BORDER_BAND_FRACTION))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (y < band || y >= h - band || x < band || x >= w - band) mask[y * w + x] = 0
    }
  }

  const { labels, components } = labelComponents({ data: mask, width: w, height: h })
  if (components.length === 0) return emptyResult(0)

  const isLineLike = (c: (typeof components)[number]): boolean => {
    const bh = c.y1 - c.y0 + 1
    const bw = c.x1 - c.x0 + 1
    const nearEdge = c.y0 <= band + 1 || c.x0 <= band + 1 || c.y1 >= h - band - 2 || c.x1 >= w - band - 2
    const longThin = (bw > 0.8 * w && bh < 0.22 * h) || (bh > 0.8 * h && bw < 0.22 * w)
    return nearEdge && longThin
  }

  const candidates = components.filter((c) => !isLineLike(c))
  if (candidates.length === 0) return emptyResult(0)
  const largest = candidates.reduce((a, b) => (b.size > a.size ? b : a))
  const minSize = Math.max(MIN_COMPONENT_PIXELS, Math.trunc(MIN_COMPONENT_FRACTION * largest.size))
  const keptComponents = candidates.filter((c) => c.size >= minSize)
  const keepLabels = new Set(keptComponents.map((c) => c.label))

  // Screened / halftone fills (a shaded empty cell in newsprint) survive
  // the ink filter as dozens of similar small blobs. A glyph is one to a
  // few blobs with one dominant, so many blobs and no dominant one means
  // texture, not ink: the cell is empty.
  const keptTotal = keptComponents.reduce((a, c) => a + c.size, 0)
  if (
    keptComponents.length >= TEXTURE_MIN_COMPONENTS &&
    largest.size < TEXTURE_MAX_LARGEST_FRACTION * keptTotal
  ) {
    return emptyResult(keptTotal / (w * h))
  }

  const keepMask = new Uint8Array(w * h)
  let kept = 0
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (labels[idx] !== 0 && keepLabels.has(labels[idx])) {
        keepMask[idx] = 1
        kept++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  const inkRatio = kept / (w * h)
  if (inkRatio < EMPTY_INK_RATIO) return emptyResult(inkRatio)
  if (Math.max(x1 - x0 + 1, y1 - y0 + 1) < MIN_GLYPH_FRACTION * Math.min(w, h)) return emptyResult(inkRatio)
  if (keptComponents.length >= 2 && isCandidates(keptComponents, w, h)) return emptyResult(inkRatio)
  if (blobOnly && !isGlyphBlob(largest, kept, w, h, band)) return emptyResult(inkRatio)

  // Gate the intensity image to a neighbourhood of the kept ink. The radius
  // scales with the cell so a blurred stroke keeps its soft halo instead of
  // being clipped to its Otsu core (which fragments low-resolution digits).
  const gateRadius = Math.max(1, roundHalfUp(Math.min(w, h) * GATE_RADIUS_FRACTION))
  const dilated = dilateMask(keepMask, w, h, gateRadius)
  const cw = x1 - x0 + 1
  const ch = y1 - y0 + 1
  const crop = new Float32Array(cw * ch)
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const src = (y + y0) * w + (x + x0)
      crop[y * cw + x] = (inv[src] / 255) * dilated[src]
    }
  }

  const scale = GLYPH_SIZE / Math.max(ch, cw)
  const outH = Math.max(1, roundHalfUp(ch * scale))
  const outW = Math.max(1, roundHalfUp(cw * scale))
  const resized = resizeBilinear(crop, cw, ch, outW, outH)

  // Contrast normalisation: faded newsprint and out-of-focus digits keep
  // their shape but lose intensity; stretch so the glyph's bright end sits
  // at 1.0 regardless of print contrast. A high percentile (not the max)
  // so a single speck cannot dominate.
  const vals = Array.from(resized)
    .filter((v) => v > 0)
    .sort((a, b) => a - b)
  if (vals.length > 0) {
    const peak = vals[Math.floor(CONTRAST_PERCENTILE * (vals.length - 1))]
    if (peak > 0) for (let i = 0; i < resized.length; i++) resized[i] = Math.min(resized[i] / peak, 1)
  }

  let total = 0
  let comY = 0
  let comX = 0
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const v = resized[y * outW + x]
      total += v
      comY += v * y
      comX += v * x
    }
  }
  if (total <= 0) return emptyResult(inkRatio)
  comY /= total
  comX /= total

  const tensor = new Float32Array(TENSOR_SIZE * TENSOR_SIZE).fill(-1)
  let offY = roundHalfUp(TENSOR_SIZE / 2 - 0.5 - comY)
  let offX = roundHalfUp(TENSOR_SIZE / 2 - 0.5 - comX)
  offY = Math.min(Math.max(offY, 0), TENSOR_SIZE - outH)
  offX = Math.min(Math.max(offX, 0), TENSOR_SIZE - outW)
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      tensor[(y + offY) * TENSOR_SIZE + (x + offX)] = resized[y * outW + x] * 2 - 1
    }
  }
  return { tensor, inkRatio, isEmpty: false }
}

/** Per-cell line positions (see gridSize.localLines). */
export interface CellLines {
  rowsByCol: number[][]
  colsByRow: number[][]
}

/**
 * Crop every cell between (relocalised) grid lines with an inner margin and
 * normalise each. Returns row-major cell tensors. With `local` lines, each
 * cell uses the lines measured around its own column and row, which
 * follow a curled page where the global lines do not.
 */
export function extractCells(
  warped: GrayImage,
  rowLines: number[],
  colLines: number[],
  local?: CellLines,
): CellTensor[] {
  const n = rowLines.length - 1
  const out: CellTensor[] = []
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const rows = local ? local.rowsByCol[c] : rowLines
      const cols = local ? local.colsByRow[r] : colLines
      const cy0 = rows[r]
      const cy1 = rows[r + 1]
      const cx0 = cols[c]
      const cx1 = cols[c + 1]
      const mh = (cy1 - cy0) * CELL_MARGIN
      const mw = (cx1 - cx0) * CELL_MARGIN
      // The whole cell is cropped as flat-field context; the classifier
      // sees the region inside the margin, which excludes the grid lines.
      const Y0 = Math.max(0, Math.round(cy0))
      const Y1 = Math.min(warped.height, Math.round(cy1))
      const X0 = Math.max(0, Math.round(cx0))
      const X1 = Math.min(warped.width, Math.round(cx1))
      const y0 = Math.max(Y0, Math.round(cy0 + mh))
      const y1 = Math.max(y0 + 1, Math.min(Y1, Math.round(cy1 - mh)))
      const x0 = Math.max(X0, Math.round(cx0 + mw))
      const x1 = Math.max(x0 + 1, Math.min(X1, Math.round(cx1 - mw)))
      const w = Math.max(1, X1 - X0)
      const h = Math.max(1, Y1 - Y0)
      const data = new Uint8Array(w * h)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          data[y * w + x] = warped.data[(Y0 + y) * warped.width + (X0 + x)]
        }
      }
      out.push(cellToTensor({ data, width: w, height: h }, { x0: x0 - X0, y0: y0 - Y0, x1: x1 - X0, y1: y1 - Y0 }))
    }
  }
  return out
}
