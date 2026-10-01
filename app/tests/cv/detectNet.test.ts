import { describe, expect, it } from 'vitest'
import {
  DET_CHANNELS,
  DET_GRID,
  DET_IN,
  DET_STRIDE,
  decodeDetections,
  letterbox,
} from '../../src/lib/cv/detectNet'
import type { GrayImage } from '../../src/lib/cv/image'

const PAD = 128 / 255

function flatImage(width: number, height: number, value: number): GrayImage {
  return { data: new Uint8Array(width * height).fill(value), width, height }
}

describe('letterbox', () => {
  it('pads a landscape image with bars top and bottom', () => {
    const box = letterbox(flatImage(400, 300, 255))
    expect(box.scale).toBeCloseTo(400 / DET_IN)
    expect(box.dx).toBe(0)
    expect(box.dy).toBe((DET_IN - Math.round(300 / box.scale)) >> 1)
    // Bar pixel above the content is pad gray; content pixel is white.
    expect(box.input[0]).toBeCloseTo(PAD)
    expect(box.input[(box.dy + 1) * DET_IN + 5]).toBeCloseTo(1, 2)
  })

  it('is identity-shaped for a square image', () => {
    const box = letterbox(flatImage(384, 384, 0))
    expect(box.dx).toBe(0)
    expect(box.dy).toBe(0)
    expect(box.input[0]).toBeCloseTo(0)
  })
})

describe('decodeDetections', () => {
  const plane = DET_GRID * DET_GRID

  function emptyMap(): Float32Array {
    // Large negative logits -> sigmoid ~ 0 everywhere.
    return new Float32Array(DET_CHANNELS * plane).fill(-10)
  }

  function setPeak(map: Float32Array, cx: number, cy: number, logit: number, corners: number[]): void {
    const idx = cy * DET_GRID + cx
    map[idx] = logit
    const cellX = (cx + 0.5) * DET_STRIDE
    const cellY = (cy + 0.5) * DET_STRIDE
    for (let c = 0; c < 4; c++) {
      map[(1 + c * 2) * plane + idx] = (corners[c * 2] - cellX) / DET_IN
      map[(2 + c * 2) * plane + idx] = (corners[c * 2 + 1] - cellY) / DET_IN
    }
  }

  it('recovers corners through the letterbox mapping', () => {
    const map = emptyMap()
    // A quad in input px, centred near cell (12, 10).
    const quad = [60, 44, 140, 46, 138, 122, 58, 120]
    setPeak(map, 12, 10, 4, quad)
    const box = { scale: 2.5, dx: 0, dy: 24 }
    const dets = decodeDetections(map, box, 3, 0.35)
    expect(dets).toHaveLength(1)
    expect(dets[0].score).toBeGreaterThan(0.9)
    expect(dets[0].corners[0].x).toBeCloseTo((60 - 0) * 2.5, 4)
    expect(dets[0].corners[0].y).toBeCloseTo((44 - 24) * 2.5, 4)
    expect(dets[0].corners[2].x).toBeCloseTo(138 * 2.5, 4)
  })

  it('suppresses non-maximum neighbours and honours the threshold', () => {
    const map = emptyMap()
    setPeak(map, 10, 10, 4, [70, 70, 120, 70, 120, 120, 70, 120])
    map[10 * DET_GRID + 11] = 3 // weaker neighbour: NMS should drop it
    setPeak(map, 20, 4, -2, [150, 20, 180, 20, 180, 50, 150, 50]) // below thresh
    const dets = decodeDetections(map, { scale: 1, dx: 0, dy: 0 }, 3, 0.35)
    expect(dets).toHaveLength(1)
  })

  it('returns multiple grids best-first', () => {
    const map = emptyMap()
    setPeak(map, 6, 6, 2, [30, 30, 70, 30, 70, 70, 30, 70])
    setPeak(map, 18, 18, 5, [130, 130, 170, 130, 170, 170, 130, 170])
    const dets = decodeDetections(map, { scale: 1, dx: 0, dy: 0 }, 3, 0.35)
    expect(dets).toHaveLength(2)
    expect(dets[0].corners[0].x).toBeCloseTo(130, 4)
    expect(dets[1].corners[0].x).toBeCloseTo(30, 4)
  })
})
