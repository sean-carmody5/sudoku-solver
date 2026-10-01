/**
 * Geometry helpers for the scan -> board transition: straighten the colour
 * photo of the grid, place an element exactly over any quad on screen (a
 * CSS matrix3d from the homography), and map photo pixels to screen pixels
 * for an image shown with object-fit.
 */
import type { Point } from '../cv/image'
import { applyHomography, homography } from '../cv/warp'

/** Side of the straightened photo that lands on the board and backs the
 * compare view. */
export const STRAIGHT_DIM = 480

/** Straighten the quad of an RGBA image into an `out` x `out` canvas
 * (bilinear). The scan worker normally does this (straightenPixels); this is
 * the fallback where workers have no OffscreenCanvas. */
export function straighten(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  corners: Point[],
  out: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = out
  canvas.height = out
  canvas.getContext('2d')!.putImageData(new ImageData(straightenPixels(rgba, width, height, corners, out), out, out), 0, 0)
  return canvas
}

/** The quad of an RGBA image resampled (bilinear) into `out` x `out` RGBA. */
export function straightenPixels(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  corners: Point[],
  out: number,
): Uint8ClampedArray<ArrayBuffer> {
  const dst = new Uint8ClampedArray(out * out * 4)
  const h = homography(
    [
      { x: 0, y: 0 },
      { x: out, y: 0 },
      { x: out, y: out },
      { x: 0, y: out },
    ],
    corners,
  )
  for (let y = 0; y < out; y++) {
    for (let x = 0; x < out; x++) {
      const dx = x + 0.5
      const dy = y + 0.5
      const w = h[6] * dx + h[7] * dy + h[8]
      const sx = Math.min(width - 1.001, Math.max(0, (h[0] * dx + h[1] * dy + h[2]) / w - 0.5))
      const sy = Math.min(height - 1.001, Math.max(0, (h[3] * dx + h[4] * dy + h[5]) / w - 0.5))
      const x0 = Math.floor(sx)
      const y0 = Math.floor(sy)
      const fx = sx - x0
      const fy = sy - y0
      const i00 = (y0 * width + x0) * 4
      const i01 = i00 + 4
      const i10 = i00 + width * 4
      const i11 = i10 + 4
      const o = (y * out + x) * 4
      for (let c = 0; c < 3; c++) {
        dst[o + c] =
          rgba[i00 + c] * (1 - fx) * (1 - fy) +
          rgba[i01 + c] * fx * (1 - fy) +
          rgba[i10 + c] * (1 - fx) * fy +
          rgba[i11 + c] * fx * fy
      }
      dst[o + 3] = 255
    }
  }
  return dst
}

/**
 * CSS transform that maps an element's box (0,0)-(w,h) onto `quad` (tl,
 * tr, br, bl) in its containing block's coordinates. Needs
 * `transform-origin: 0 0` on the element.
 */
export function matrix3dFor(w: number, h: number, quad: Point[]): string {
  const m = homography(
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    quad,
  )
  const v = [m[0], m[3], 0, m[6], m[1], m[4], 0, m[7], 0, 0, 1, 0, m[2], m[5], 0, m[8]]
  return `matrix3d(${v.map((n) => (Math.abs(n) < 1e-12 ? 0 : n).toFixed(10)).join(',')})`
}

/**
 * The grid's actual border in the photo: the outer relocalised lines (as
 * fractions of the straightened square) mapped back through the outline's
 * homography.
 */
export function gridOutline(corners: Point[], rowLines: number[], colLines: number[]): Point[] {
  const h = homography(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    corners,
  )
  const r0 = rowLines[0]
  const r1 = rowLines[rowLines.length - 1]
  const c0 = colLines[0]
  const c1 = colLines[colLines.length - 1]
  return [
    applyHomography(h, { x: c0, y: r0 }),
    applyHomography(h, { x: c1, y: r0 }),
    applyHomography(h, { x: c1, y: r1 }),
    applyHomography(h, { x: c0, y: r1 }),
  ]
}

/** Photo px -> box px for an image drawn with object-fit cover/contain.
 * `view`: the region of the photo the fit applies to (the rest spills out). */
export function fitMapping(
  imgW: number,
  imgH: number,
  boxW: number,
  boxH: number,
  fit: 'cover' | 'contain',
  view: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: imgW, h: imgH },
): { scale: number; ox: number; oy: number } {
  const { x, y, w, h } = view
  const scale = fit === 'cover' ? Math.max(boxW / w, boxH / h) : Math.min(boxW / w, boxH / h)
  return { scale, ox: (boxW - w * scale) / 2 - x * scale, oy: (boxH - h * scale) / 2 - y * scale }
}

/**
 * A damped spring's progress (0..1) as a function of normalised time over
 * its settle time - the same curves as the CSS --spring-* tokens (Apple's
 * response / damping-fraction parametrisation).
 */
export function spring(response: number, damping: number): { ease: (t: number) => number; ms: number } {
  const w = (2 * Math.PI) / response
  const at = (t: number): number => {
    if (damping >= 1) return 1 - Math.exp(-w * t) * (1 + w * t)
    const wd = w * Math.sqrt(1 - damping * damping)
    return 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t))
  }
  let settle = 0
  for (let t = 0; t < 4; t += 0.002) if (Math.abs(at(t) - 1) > 0.001) settle = t
  return { ease: (t) => (t >= 1 ? 1 : at(t * settle)), ms: Math.round(settle * 1000) }
}

/** Critically damped-ish ease used for every scan transition. */
export const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

export function lerpQuad(a: Point[], b: Point[], t: number): Point[] {
  return a.map((p, i) => ({ x: p.x + (b[i].x - p.x) * t, y: p.y + (b[i].y - p.y) * t }))
}
