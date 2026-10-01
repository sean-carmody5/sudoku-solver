import type { BinaryImage, Point } from './image'

interface Line {
  /** Line as: nx*x + ny*y = d, with (nx, ny) unit normal. */
  nx: number
  ny: number
  d: number
}

/** Total-least-squares line through points (PCA), robust to any orientation. */
function fitLine(points: Point[]): Line {
  let mx = 0
  let my = 0
  for (const p of points) {
    mx += p.x
    my += p.y
  }
  mx /= points.length
  my /= points.length
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const p of points) {
    const dx = p.x - mx
    const dy = p.y - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  // Direction = principal eigenvector of the covariance matrix.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const dirX = Math.cos(theta)
  const dirY = Math.sin(theta)
  const nx = -dirY
  const ny = dirX
  return { nx, ny, d: nx * mx + ny * my }
}

function lineDistance(l: Line, p: Point): number {
  return Math.abs(l.nx * p.x + l.ny * p.y - l.d)
}

function intersect(a: Line, b: Line): Point {
  const det = a.nx * b.ny - a.ny * b.nx
  if (Math.abs(det) < 1e-12) return { x: 0, y: 0 }
  return {
    x: (a.d * b.ny - a.ny * b.d) / det,
    y: (a.nx * b.d - a.d * b.nx) / det,
  }
}

/**
 * Refine quad corners: assign contour points to their nearest quad edge
 * (excluding a margin near corners), TLS line fit per edge with one round of
 * outlier rejection, then intersect adjacent edge lines for subpixel corners.
 *
 * `quad` must be ordered tl, tr, br, bl.
 */
export function refineCorners(contour: Point[], quad: Point[]): Point[] {
  const edges: Point[][] = [[], [], [], []]
  const cornerMarginSq = new Array(4).fill(0)
  for (let e = 0; e < 4; e++) {
    const a = quad[e]
    const b = quad[(e + 1) % 4]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    cornerMarginSq[e] = (0.1 * len) ** 2
  }

  for (const p of contour) {
    let bestEdge = -1
    let bestDist = Infinity
    for (let e = 0; e < 4; e++) {
      const a = quad[e]
      const b = quad[(e + 1) % 4]
      // Distance to segment; also require the projection to be interior.
      const abx = b.x - a.x
      const aby = b.y - a.y
      const lenSq = abx * abx + aby * aby
      const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq
      if (t < 0.1 || t > 0.9) continue // corner margin
      const projX = a.x + t * abx
      const projY = a.y + t * aby
      const d = (p.x - projX) ** 2 + (p.y - projY) ** 2
      if (d < bestDist) {
        bestDist = d
        bestEdge = e
      }
    }
    // Only accept points reasonably close to their edge (5px at detect scale).
    if (bestEdge !== -1 && bestDist < 25) edges[bestEdge].push(p)
  }

  const lines: Line[] = []
  for (let e = 0; e < 4; e++) {
    let pts = edges[e]
    if (pts.length < 8) {
      // Too few boundary samples: fall back to the raw quad edge.
      const a = quad[e]
      const b = quad[(e + 1) % 4]
      pts = [a, b]
    }
    let line = fitLine(pts)
    if (pts.length > 8) {
      const kept = pts.filter((p) => lineDistance(line, p) <= 2)
      if (kept.length >= 8) line = fitLine(kept)
    }
    lines.push(line)
  }

  // Corner i = intersection of edge (i-1) and edge i.
  return [0, 1, 2, 3].map((i) => intersect(lines[(i + 3) % 4], lines[i]))
}

/**
 * Fit each side of a rough outline (`prior`, tl tr br bl) to the grid's
 * border near it, then intersect the sides. Candidate lines come from pairs
 * of points on the traced outer boundary (`contour`) in a band of `band` x
 * side around the prior side and must follow that boundary for a fifth of
 * the side (an inner rule only touches it at its ends); the winner is the
 * line with ink along most of the side in `mask`. Text or a label touching
 * the grid bends the traced boundary near a corner and can even run
 * straight for a while, but only the border is one continuous rule from
 * corner to corner. Null when a side has no convincing line.
 */
export function fitSidesToPrior(contour: Point[], prior: Point[], band: number, mask: BinaryImage): Point[] | null {
  let seed = 12345
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  const cx = prior.reduce((a, p) => a + p.x, 0) / 4
  const cy = prior.reduce((a, p) => a + p.y, 0) / 4
  const ink = (x: number, y: number): boolean => {
    const xi = Math.round(x)
    const yi = Math.round(y)
    return xi >= 0 && yi >= 0 && xi < mask.width && yi < mask.height && mask.data[yi * mask.width + xi] === 1
  }
  const SAMPLES = 64
  const lines: Line[] = []
  for (let e = 0; e < 4; e++) {
    const a = prior[e]
    const b = prior[(e + 1) % 4]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 16) return null
    const ux = (b.x - a.x) / len
    const uy = (b.y - a.y) / len
    const pts = contour.filter((p) => {
      const t = ((p.x - a.x) * ux + (p.y - a.y) * uy) / len
      const d = Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux)
      return t > 0.03 && t < 0.97 && d <= band * len
    })
    if (pts.length < 0.1 * len) return null
    let best: { nx: number; ny: number; c: number; cover: number } | null = null
    for (let k = 0; k < 400; k++) {
      const p = pts[rand(pts.length)]
      const q = pts[rand(pts.length)]
      const dx = q.x - p.x
      const dy = q.y - p.y
      const span = Math.hypot(dx, dy)
      // A short pair fixes the direction poorly; the side runs roughly
      // along the prior's side (within ~25 degrees: one dragged corner
      // turns a prior side that far).
      if (span < 0.15 * len || Math.abs(dx * ux + dy * uy) < 0.9 * span) continue
      let nx = -dy / span
      let ny = dx / span
      // Normal pointing into the grid.
      if (nx * (cx - p.x) + ny * (cy - p.y) < 0) {
        nx = -nx
        ny = -ny
      }
      const c = nx * p.x + ny * p.y
      let support = 0
      for (const r of pts) if (Math.abs(nx * r.x + ny * r.y - c) <= 2) support++
      if (support < 0.2 * len) continue
      // Ink under the line (from its outer edge a few px inward) along the
      // prior side's span.
      let cover = 0
      for (let i = 0; i < SAMPLES; i++) {
        const t = 0.04 + (0.92 * i) / (SAMPLES - 1)
        const sx = a.x + (b.x - a.x) * t
        const sy = a.y + (b.y - a.y) * t
        // Foot of the perpendicular from the sample onto the line.
        const off = c - (nx * sx + ny * sy)
        const fx = sx + nx * off
        const fy = sy + ny * off
        for (let o = -1; o <= 2; o++) {
          if (ink(fx + nx * o, fy + ny * o)) {
            cover++
            break
          }
        }
      }
      if (!best || cover > best.cover) best = { nx, ny, c, cover }
    }
    if (!best || best.cover < 0.7 * SAMPLES) return null
    const { nx, ny, c } = best
    const inliers = pts.filter((r) => Math.abs(nx * r.x + ny * r.y - c) <= 2)
    lines.push(inliers.length >= 8 ? fitLine(inliers) : { nx, ny, d: c })
  }
  return [0, 1, 2, 3].map((i) => intersect(lines[(i + 3) % 4], lines[i]))
}
