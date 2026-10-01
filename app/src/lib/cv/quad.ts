import type { Point } from './image'

/** Perpendicular distance from p to segment ab. */
function perpDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len
}

function rdpOpen(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: Array<[number, number]> = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!
    let maxDist = 0
    let maxIdx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(points[i], points[lo], points[hi])
      if (d > maxDist) {
        maxDist = d
        maxIdx = i
      }
    }
    if (maxDist > epsilon) {
      keep[maxIdx] = 1
      stack.push([lo, maxIdx], [maxIdx, hi])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

/** RDP for a closed contour: split at the two mutually farthest kept points. */
export function simplifyClosed(contour: Point[], epsilon: number): Point[] {
  if (contour.length < 4) return contour.slice()
  // Anchor at the two farthest-apart points (approx: farthest from point 0,
  // then farthest from that).
  let a = 0
  let best = -1
  for (let i = 0; i < contour.length; i++) {
    const d = Math.hypot(contour[i].x - contour[0].x, contour[i].y - contour[0].y)
    if (d > best) {
      best = d
      a = i
    }
  }
  let b = 0
  best = -1
  for (let i = 0; i < contour.length; i++) {
    const d = Math.hypot(contour[i].x - contour[a].x, contour[i].y - contour[a].y)
    if (d > best) {
      best = d
      b = i
    }
  }
  const [lo, hi] = a < b ? [a, b] : [b, a]
  const chain1 = contour.slice(lo, hi + 1)
  const chain2 = contour.slice(hi).concat(contour.slice(0, lo + 1))
  const s1 = rdpOpen(chain1, epsilon)
  const s2 = rdpOpen(chain2, epsilon)
  return s1.slice(0, -1).concat(s2.slice(0, -1))
}

function polygonArea(pts: Point[]): number {
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    area += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return Math.abs(area) / 2
}

/** Reduce a polygon to exactly 4 vertices by repeatedly removing the vertex
 * whose removal changes the polygon area least. */
export function reduceToQuad(poly: Point[]): Point[] {
  const pts = poly.slice()
  while (pts.length > 4) {
    let bestIdx = -1
    let bestLoss = Infinity
    const area = polygonArea(pts)
    for (let i = 0; i < pts.length; i++) {
      const without = pts.slice(0, i).concat(pts.slice(i + 1))
      const loss = Math.abs(area - polygonArea(without))
      if (loss < bestLoss) {
        bestLoss = loss
        bestIdx = i
      }
    }
    pts.splice(bestIdx, 1)
  }
  return pts
}

export interface QuadCheckOptions {
  minAngle: number
  maxAngle: number
  maxSideRatio: number
  /** Width vs height (mean of opposite sides): a square seen at a usable
   * angle stays well inside 2:1, a strip of bezel or a button does not. */
  maxAspect: number
}

const DEFAULT_CHECK: QuadCheckOptions = { minAngle: 50, maxAngle: 130, maxSideRatio: 1.7, maxAspect: 2.2 }

/** Order corners tl, tr, br, bl. */
export function orderCorners(quad: Point[]): Point[] {
  const bySum = [...quad].sort((p, q) => p.x + p.y - (q.x + q.y))
  const tl = bySum[0]
  const br = bySum[3]
  const byDiff = [...quad].sort((p, q) => p.x - p.y - (q.x - q.y))
  const bl = byDiff[0]
  const tr = byDiff[3]
  return [tl, tr, br, bl]
}

/** True if the quad is convex with sane angles and side ratios. */
/** Width vs height a verified grid may show: a square tilted ~55 degrees
 * away. Two stacked puzzles boxed as one (about 2:1) can otherwise verify
 * as a squashed 9x9. */
export const GRID_MAX_ASPECT = 1.7

/** Mean width over mean height of a quad (tl, tr, br, bl), at least 1. */
export function quadAspect(q: Point[]): number {
  const side = (i: number): number => Math.hypot(q[(i + 1) % 4].x - q[i].x, q[(i + 1) % 4].y - q[i].y)
  const a = (side(0) + side(2)) / (side(1) + side(3))
  return a >= 1 ? a : 1 / a
}

export function isPlausibleQuad(quad: Point[], opts: QuadCheckOptions = DEFAULT_CHECK): boolean {
  if (quad.length !== 4) return false
  const sides: number[] = []
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const p0 = quad[i]
    const p1 = quad[(i + 1) % 4]
    const p2 = quad[(i + 2) % 4]
    const v1x = p1.x - p0.x
    const v1y = p1.y - p0.y
    const v2x = p2.x - p1.x
    const v2y = p2.y - p1.y
    const cross = v1x * v2y - v1y * v2x
    if (cross !== 0) {
      if (sign === 0) sign = Math.sign(cross)
      else if (Math.sign(cross) !== sign) return false // not convex
    }
    sides.push(Math.hypot(v1x, v1y))
  }
  // Interior angles via vectors from each vertex to its neighbours.
  for (let i = 0; i < 4; i++) {
    const prev = quad[(i + 3) % 4]
    const cur = quad[i]
    const next = quad[(i + 1) % 4]
    const v1x = prev.x - cur.x
    const v1y = prev.y - cur.y
    const v2x = next.x - cur.x
    const v2y = next.y - cur.y
    const dot = v1x * v2x + v1y * v2y
    const mag = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)
    if (mag === 0) return false
    const angle = (Math.acos(Math.min(1, Math.max(-1, dot / mag))) * 180) / Math.PI
    if (angle < opts.minAngle || angle > opts.maxAngle) return false
  }
  const [s0, s1, s2, s3] = sides
  if (Math.min(...sides) === 0) return false
  if (Math.max(s0, s2) / Math.min(s0, s2) > opts.maxSideRatio) return false
  if (Math.max(s1, s3) / Math.min(s1, s3) > opts.maxSideRatio) return false
  const aspect = (s0 + s2) / (s1 + s3)
  if (aspect > opts.maxAspect || aspect < 1 / opts.maxAspect) return false
  return true
}

export { polygonArea }
