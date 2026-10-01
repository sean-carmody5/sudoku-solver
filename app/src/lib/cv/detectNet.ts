/**
 * Grid-detector model glue: letterbox a grayscale frame into the network's
 * square input, and decode the output map (centre heatmap + per-cell corner
 * offsets, CenterNet-style) into grid-corner quads. DOM-free and
 * runtime-free - the ONNX session itself lives with the caller.
 */

import type { GrayImage, Point } from './image'

export const DET_IN = 192
export const DET_STRIDE = 8
export const DET_GRID = DET_IN / DET_STRIDE // 24
/** Output channels: 1 heatmap + 8 corner offsets. */
export const DET_CHANNELS = 9
/** Uniform gray used for letterbox padding - must match training (128/255). */
const PAD = 128 / 255

export interface Letterbox {
  /** Model input, [1,1,192,192] row-major. */
  input: Float32Array
  /** source px per input px. */
  scale: number
  /** Content offset inside the square input, px. */
  dx: number
  dy: number
}

/** Scale-to-fit into the square input with uniform-gray pad bars, exactly the
 * geometry the training data bakes in. Area-averaged like image.downscale. */
export function letterbox(img: GrayImage): Letterbox {
  const input = new Float32Array(DET_IN * DET_IN).fill(PAD)
  const scale = Math.max(img.width, img.height) / DET_IN
  const cw = Math.round(img.width / scale)
  const ch = Math.round(img.height / scale)
  const dx = (DET_IN - cw) >> 1
  const dy = (DET_IN - ch) >> 1
  for (let y = 0; y < ch; y++) {
    const sy0 = Math.floor(y * scale)
    const sy1 = Math.min(img.height, Math.max(sy0 + 1, Math.floor((y + 1) * scale)))
    for (let x = 0; x < cw; x++) {
      const sx0 = Math.floor(x * scale)
      const sx1 = Math.min(img.width, Math.max(sx0 + 1, Math.floor((x + 1) * scale)))
      let sum = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) sum += img.data[sy * img.width + sx]
      }
      input[(dy + y) * DET_IN + dx + x] = sum / ((sy1 - sy0) * (sx1 - sx0) * 255)
    }
  }
  return { input, scale, dx, dy }
}

export interface NetDetection {
  /** Corners tl, tr, br, bl in SOURCE-image pixels. */
  corners: Point[]
  /** Peak heatmap score, 0..1. */
  score: number
}

const sigmoid = (v: number): number => 1 / (1 + Math.exp(-v))

/**
 * Decode the raw output map [9,24,24] into detections: sigmoid the heatmap,
 * 3x3 non-max suppression, take peaks above `thresh`, read the 8 offset
 * values at each peak, then map back through the letterbox into source px.
 */
export function decodeDetections(
  map: Float32Array,
  box: Pick<Letterbox, 'scale' | 'dx' | 'dy'>,
  maxDets = 3,
  thresh = 0.35,
): NetDetection[] {
  const G = DET_GRID
  const plane = G * G
  if (map.length !== DET_CHANNELS * plane) throw new Error('unexpected detector output shape')
  const heat = new Float32Array(plane)
  for (let i = 0; i < plane; i++) heat[i] = sigmoid(map[i])

  const peaks: { score: number; idx: number }[] = []
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const v = heat[y * G + x]
      if (v < thresh) continue
      let isMax = true
      for (let ny = Math.max(0, y - 1); isMax && ny <= Math.min(G - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(G - 1, x + 1); nx++) {
          if (heat[ny * G + nx] > v) {
            isMax = false
            break
          }
        }
      }
      if (isMax) peaks.push({ score: v, idx: y * G + x })
    }
  }
  peaks.sort((a, b) => b.score - a.score)

  const dets: NetDetection[] = []
  for (const { score, idx } of peaks.slice(0, maxDets)) {
    const cy = Math.floor(idx / G)
    const cx = idx % G
    const cellPx = { x: (cx + 0.5) * DET_STRIDE, y: (cy + 0.5) * DET_STRIDE }
    const corners: Point[] = []
    for (let c = 0; c < 4; c++) {
      const ox = map[(1 + c * 2) * plane + idx] * DET_IN
      const oy = map[(2 + c * 2) * plane + idx] * DET_IN
      corners.push({
        x: (cellPx.x + ox - box.dx) * box.scale,
        y: (cellPx.y + oy - box.dy) * box.scale,
      })
    }
    dets.push({ corners, score })
  }
  return dets
}
