import type { GrayImage, Point } from './image'

/**
 * Homography H mapping src -> dst (4 point pairs) via DLT: solves the 8x8
 * linear system with partial-pivot Gaussian elimination. Returns row-major
 * [h0..h8] with h8 = 1.
 */
export function homography(src: Point[], dst: Point[]): Float64Array {
  const a = new Float64Array(8 * 9)
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    const r1 = 2 * i * 9
    a[r1 + 0] = x
    a[r1 + 1] = y
    a[r1 + 2] = 1
    a[r1 + 6] = -u * x
    a[r1 + 7] = -u * y
    a[r1 + 8] = u
    const r2 = (2 * i + 1) * 9
    a[r2 + 3] = x
    a[r2 + 4] = y
    a[r2 + 5] = 1
    a[r2 + 6] = -v * x
    a[r2 + 7] = -v * y
    a[r2 + 8] = v
  }

  for (let col = 0; col < 8; col++) {
    let pivot = col
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(a[r * 9 + col]) > Math.abs(a[pivot * 9 + col])) pivot = r
    }
    if (pivot !== col) {
      for (let c = 0; c < 9; c++) {
        const t = a[col * 9 + c]
        a[col * 9 + c] = a[pivot * 9 + c]
        a[pivot * 9 + c] = t
      }
    }
    const div = a[col * 9 + col]
    if (Math.abs(div) < 1e-12) continue
    for (let c = col; c < 9; c++) a[col * 9 + c] /= div
    for (let r = 0; r < 8; r++) {
      if (r === col) continue
      const factor = a[r * 9 + col]
      if (factor === 0) continue
      for (let c = col; c < 9; c++) a[r * 9 + c] -= factor * a[col * 9 + c]
    }
  }

  const h = new Float64Array(9)
  for (let i = 0; i < 8; i++) h[i] = a[i * 9 + 8]
  h[8] = 1
  return h
}

export function applyHomography(h: Float64Array, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  return {
    x: (h[0] * p.x + h[1] * p.y + h[2]) / w,
    y: (h[3] * p.x + h[4] * p.y + h[5]) / w,
  }
}

/**
 * Warp the quad region of `src` to an axis-aligned `outSize` square using
 * inverse mapping with bilinear sampling. `corners` ordered tl, tr, br, bl.
 */
export function warpToSquare(src: GrayImage, corners: Point[], outSize: number): GrayImage {
  const dstCorners: Point[] = [
    { x: 0, y: 0 },
    { x: outSize, y: 0 },
    { x: outSize, y: outSize },
    { x: 0, y: outSize },
  ]
  const hInv = homography(dstCorners, corners)
  const out = new Uint8Array(outSize * outSize)
  const { data, width, height } = src

  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = hInv
  for (let y = 0; y < outSize; y++) {
    const dy = y + 0.5
    // The homography terms are linear in x along a row: step them.
    let nx = h0 * 0.5 + h1 * dy + h2
    let ny = h3 * 0.5 + h4 * dy + h5
    let nw = h6 * 0.5 + h7 * dy + h8
    for (let x = 0; x < outSize; x++, nx += h0, ny += h3, nw += h6) {
      const sx = nx / nw - 0.5
      const sy = ny / nw - 0.5
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      if (x0 < -1 || y0 < -1 || x0 > width - 1 || y0 > height - 1) {
        out[y * outSize + x] = 255
        continue
      }
      const cx0 = Math.max(0, x0)
      const cy0 = Math.max(0, y0)
      const cx1 = Math.min(width - 1, x0 + 1)
      const cy1 = Math.min(height - 1, y0 + 1)
      const fx = sx - x0
      const fy = sy - y0
      const p00 = data[cy0 * width + cx0]
      const p01 = data[cy0 * width + cx1]
      const p10 = data[cy1 * width + cx0]
      const p11 = data[cy1 * width + cx1]
      out[y * outSize + x] =
        p00 * (1 - fx) * (1 - fy) + p01 * fx * (1 - fy) + p10 * (1 - fx) * fy + p11 * fx * fy
    }
  }
  return { data: out, width: outSize, height: outSize }
}
