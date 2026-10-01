import type { BinaryImage, GrayImage } from './image'

/** Summed-area tables per image (images are never mutated once made). */
const integrals = new WeakMap<GrayImage, Int32Array>()
/** Masks per image and (window, offset): the same warp is thresholded by
 * size detection, local lines, line strength and the solution check. */
const masks = new WeakMap<GrayImage, Map<number, BinaryImage>>()

function integralOf(img: GrayImage): Int32Array {
  const hit = integrals.get(img)
  if (hit) return hit
  const { width: w, height: h, data } = img
  // Int32 is exact here: 1600 * 1600 * 255 < 2^31.
  const iw = w + 1
  const integral = new Int32Array(iw * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowSum = 0
    const src = y * w
    const dst = (y + 1) * iw
    const prev = y * iw
    for (let x = 0; x < w; x++) {
      rowSum += data[src + x]
      integral[dst + x + 1] = integral[prev + x + 1] + rowSum
    }
  }
  integrals.set(img, integral)
  return integral
}

/**
 * Mean-window adaptive threshold via integral image, inverted so ink = 1.
 * A pixel is ink when gray < localMean - offset. Results are cached per
 * image; callers must treat the mask as read-only.
 */
export function adaptiveThreshold(img: GrayImage, window: number, offset: number): BinaryImage {
  let perImage = masks.get(img)
  if (!perImage) {
    perImage = new Map()
    masks.set(img, perImage)
  }
  const key = window * 1024 + offset
  const cached = perImage.get(key)
  if (cached) return cached

  const { width: w, height: h, data } = img
  const half = Math.max(1, window >> 1)
  const integral = integralOf(img)
  const iw = w + 1
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half)
    const y1 = Math.min(h - 1, y + half)
    const rowA = y0 * iw
    const rowB = (y1 + 1) * iw
    const rows = y1 - y0 + 1
    const src = y * w
    for (let x = 0; x < w; x++) {
      const x0 = x - half < 0 ? 0 : x - half
      const x1 = x + half > w - 1 ? w - 1 : x + half
      const area = rows * (x1 - x0 + 1)
      const sum = integral[rowB + x1 + 1] - integral[rowB + x0] - integral[rowA + x1 + 1] + integral[rowA + x0]
      // gray < sum / area - offset, in integers.
      out[src + x] = (data[src + x] + offset) * area < sum ? 1 : 0
    }
  }
  const mask = { data: out, width: w, height: h }
  perImage.set(key, mask)
  return mask
}

/** Otsu threshold over a uint8 image; ink is values ABOVE the threshold
 * (callers pass inverted images). Mirrors model/common.py exactly. */
export function otsuThreshold(data: Uint8Array | Uint8ClampedArray): number {
  const hist = new Float64Array(256)
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  const total = data.length
  let sumAll = 0
  for (let t = 0; t < 256; t++) sumAll += t * hist[t]
  let sumBg = 0
  let weightBg = 0
  let bestT = 0
  let bestVar = -1
  for (let t = 0; t < 256; t++) {
    weightBg += hist[t]
    if (weightBg === 0) continue
    const weightFg = total - weightBg
    if (weightFg === 0) break
    sumBg += t * hist[t]
    const meanBg = sumBg / weightBg
    const meanFg = (sumAll - sumBg) / weightFg
    const v = weightBg * weightFg * (meanBg - meanFg) * (meanBg - meanFg)
    if (v > bestVar) {
      bestVar = v
      bestT = t
    }
  }
  return bestT
}
