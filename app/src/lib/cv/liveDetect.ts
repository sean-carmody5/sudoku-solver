/**
 * Live-camera grid detection for one frame, independent of the worker so it
 * can be benchmarked in Node with the same code.
 *
 * Model-first: the grid-detector CNN localises sudokus, then the classical
 * warp + grid-size check verifies the hit. When the model's box does not
 * verify (a loose box around a screen's page, say) or it sees nothing,
 * classical quad detection gets its turn - its outlines only count once
 * verified too. Dark-mode screens are tried in negative.
 */
import type { NetDetection } from './detectNet'
import { detectGridSize, MAX_LINE_IRREGULARITY, spacingIrregularity } from './gridSize'
import { centralMedian, cropGray, invertGray, type GrayImage, type Point } from './image'
import { detectQuads, fitOutlineToBorder, refineQuadOnCrop } from './pipeline'
import { GRID_MAX_ASPECT, isPlausibleQuad, quadAspect } from './quad'
import { warpToSquare } from './warp'

export type RunDetector = (img: GrayImage, maxDets: number, thresh: number) => Promise<NetDetection[] | null>

/** The part of a frame that is on screen (frame px); the frame can reach
 * past it so a grid just over the edge of the view is still seen whole. */
export interface View {
  x: number
  y: number
  w: number
  h: number
}

export interface LiveHit {
  corners: Point[] | null
  /** Detector confidence 0..1 (classical outlines report 0.5, 0.7 verified). */
  score: number
  /** Verified grid size (4/9/16), or 0 when the quad didn't verify. */
  size: number
  /** The outline touches the frame edge: part of the grid may be cut off. */
  edge: boolean
}

const VERIFY_WARP = 300
/** Live decode floor: below this the frame is treated as grid-free. */
export const LIVE_THRESH = 0.35
/** Detector boxes considered per frame (several puzzles can be in view). */
const MAX_LIVE_DETS = 3
/** Frames whose centre is this dark are read in negative first. */
const DARK_FIRST = 90
/** Up to this, an unverified frame is also tried in negative. */
const DARK_RETRY = 150
/** Corner within this fraction of the frame of an edge = touching it (a
 * tightly framed grid is fine; one running off the edge is not). */
const EDGE_MARGIN = 0.006

interface Hit {
  corners: Point[]
  score: number
  size: number
  /** Only faint rules confirmed it: weaker evidence than inked ones. */
  faint?: boolean
}

/** How far outside the frame a corner may sit (fraction of its size). */
const FRAME_TOLERANCE = 0.01
/** Faint-rule verification (pale lines) also matches regular textures -
 * fabric prints, tiling - so it only confirms a box the model is fairly
 * sure about. */
const FAINT_MIN_SCORE = 0.5
/** A box the model is this sure of locks with looser line spacing: at live
 * resolution a small board's pale rules are only a few px apart and space
 * unevenly, and the still read verifies properly anyway. */
const SURE_SCORE = 0.85
const SURE_MAX_IRREGULARITY = 0.4
/** Model confidence at which an unverified box under the centre marks the
 * puzzle being aimed at. */
const AIM_SCORE = 0.5
/** Shortest outline side that can be a readable grid, as a share of the
 * frame's short side. */
const MIN_SIDE_FRACTION = 0.15

/** The verified grid size (0: not a grid), and whether only faint rules
 * confirmed it. */
function check(gray: GrayImage, corners: Point[], score: number): { size: number; faint: boolean } {
  const no = { size: 0, faint: false }
  if (!isPlausibleQuad(corners) || quadAspect(corners) > GRID_MAX_ASPECT) return no
  const minSide = MIN_SIDE_FRACTION * Math.min(gray.width, gray.height)
  for (let i = 0; i < 4; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % 4]
    if (Math.hypot(b.x - a.x, b.y - a.y) < minSide) return no
  }
  const tx = gray.width * FRAME_TOLERANCE
  const ty = gray.height * FRAME_TOLERANCE
  if (corners.some((p) => p.x < -tx || p.y < -ty || p.x > gray.width + tx || p.y > gray.height + ty)) return no
  const sized = detectGridSize(warpToSquare(gray, corners, VERIFY_WARP))
  if (sized === null) return no
  if (sized.faint && score < FAINT_MIN_SCORE) return no
  const irregular = Math.max(spacingIrregularity(sized.rowLines), spacingIrregularity(sized.colLines))
  const limit = score >= SURE_SCORE ? SURE_MAX_IRREGULARITY : MAX_LINE_IRREGULARITY
  return irregular <= limit ? { size: sized.size, faint: !!sized.faint } : no
}

export function verify(gray: GrayImage, corners: Point[], score: number): number {
  return check(gray, corners, score).size
}

/** Model corners snapped to the grid border, but only by a fine-tune: a
 * snapped corner far from the model's is the classical sub-corner jump. */
export function snap(gray: GrayImage, corners: Point[]): Point[] {
  const refined = refineQuadOnCrop(gray, corners)
  if (refined === null) return corners
  const side =
    corners.reduce((a, p, i) => a + Math.hypot(corners[(i + 1) % 4].x - p.x, corners[(i + 1) % 4].y - p.y), 0) / 4
  const limit = side * 0.07
  return corners.map((p, i) => {
    const r = refined.corners[i]
    return Math.hypot(r.x - p.x, r.y - p.y) <= limit ? r : p
  })
}

/**
 * One frame. The model is polarity-agnostic but verification is not (it
 * looks for dark rules on light), so every candidate outline is checked on
 * the frame and, when it may be a dark-mode screen, on its negative. The
 * puzzle aimed at is the one under the centre of `view`.
 */
export async function detectLive(
  gray: GrayImage,
  run: RunDetector,
  view: View = { x: 0, y: 0, w: gray.width, h: gray.height },
): Promise<LiveHit> {
  const cx = view.x + view.w / 2
  const cy = view.y + view.h / 2
  const centreDistance = (q: Point[]): number => distanceFrom(q, cx, cy)
  const median = centralMedian(gray)
  const inv = median < DARK_RETRY ? invertGray(gray) : null
  const images = inv === null ? [gray] : median < DARK_FIRST ? [inv, gray] : [gray, inv]
  const done = (hit: Hit | null): LiveHit => finish(gray, hit)

  let sighted: Hit | null = null
  /** The model boxed a puzzle under the frame's centre (maybe merged with
   * its neighbour) that did not verify: that is the one being aimed at, so a
   * neighbour that does verify must not take the lock - auto-capture would
   * read the wrong puzzle. Classical outlines do not count: they can be a
   * screen bezel or the page itself. */
  let aimed = false
  const onTarget = (hit: Hit | null): Hit | null => (hit && aimed && centreDistance(hit.corners) > 0 ? null : hit)
  /** Side fits are dearer than a snap: only for the first (most central)
   * outline of each kind per frame. */
  let fits = 0
  const fitted = (img: GrayImage, corners: Point[], score: number): Hit | null => {
    if (fits >= 2) return null
    fits++
    const f = fitOutlineToBorder(img, corners)
    const v = f ? check(img, f.corners, score) : null
    return f && v && v.size > 0 ? { corners: f.corners, score, ...v } : null
  }
  const tryDet = (det: NetDetection): Hit | null => {
    for (const img of images) {
      const corners = snap(img, det.corners)
      const v = check(img, corners, det.score)
      if (v.size > 0) return onTarget({ corners, score: det.score, ...v })
    }
    // Text or a label touching the grid can drag the snap; fit the sides.
    for (const img of images) {
      const hit = fitted(img, det.corners, det.score)
      if (hit) return onTarget(hit)
    }
    if (det.score >= AIM_SCORE && centreDistance(det.corners) === 0) aimed = true
    sighted ??= { corners: det.corners, score: det.score, size: 0 }
    return null
  }
  // With several puzzles in view, the one being aimed at - the one under the
  // centre of the view - is tried first, not the highest-scoring one.
  const byCentre = <T extends { corners: Point[] }>(xs: T[]): T[] =>
    [...xs].sort((a, b) => centreDistance(a.corners) - centreDistance(b.corners))
  /** A box confirmed only by faint rules can be two stacked puzzles boxed
   * as one: it is held back while a cleanly verified box may still come. */
  let faint: Hit | null = null
  const clean = (hit: Hit | null): Hit | null => {
    if (hit?.faint) faint ??= hit
    return hit?.faint ? null : hit
  }
  let dets = (await run(images[0], MAX_LIVE_DETS, LIVE_THRESH)) ?? []
  if (dets.length === 0 && images[1]) dets = (await run(images[1], MAX_LIVE_DETS, LIVE_THRESH)) ?? []
  for (const det of byCentre(dets)) {
    const hit = clean(tryDet(det))
    if (hit) return done(hit)
  }
  // A tall phone frame is letterboxed into the square model input, which
  // leaves a centred puzzle only ~70 px wide there. Look again at the
  // centre square of the view alone, at twice the resolution.
  if (view.h > view.w * 1.3) {
    const side = Math.round(view.w)
    const ox = Math.round(view.x)
    const oy = Math.round(view.y + (view.h - view.w) / 2)
    for (const img of images) {
      const ds = (await run(cropGray(img, ox, oy, side, side), MAX_LIVE_DETS, LIVE_THRESH)) ?? []
      if (ds.length === 0) continue
      const shifted = ds.map((d) => ({ ...d, corners: d.corners.map((p) => ({ x: p.x + ox, y: p.y + oy })) }))
      for (const d of byCentre(shifted)) {
        const h2 = clean(tryDet(d))
        if (h2) return done(h2)
      }
      break
    }
  }
  if (faint) return done(faint)
  // The model's box did not verify (or there was none): classical outlines.
  for (const img of images) {
    for (const q of byCentre(detectQuads(img, 3))) {
      const size = verify(img, q.corners, 0.5)
      const hit = size > 0 ? { corners: q.corners, score: 0.7, size } : fitted(img, q.corners, 0.5)
      if (onTarget(hit)) return done({ ...hit!, score: 0.7 })
      sighted ??= { corners: q.corners, score: 0.5, size: 0 }
    }
  }
  return done(sighted)
}

/** 0 when the outline contains (cx, cy), else how far its middle is from
 * it (frame px). */
function distanceFrom(q: Point[], cx: number, cy: number): number {
  let inside = true
  for (let i = 0; i < 4; i++) {
    const a = q[i]
    const b = q[(i + 1) % 4]
    if ((b.x - a.x) * (cy - a.y) - (b.y - a.y) * (cx - a.x) < 0) inside = false
  }
  if (inside) return 0
  const mx = q.reduce((s, p) => s + p.x, 0) / 4
  const my = q.reduce((s, p) => s + p.y, 0) / 4
  return Math.hypot(mx - cx, my - cy)
}

function finish(gray: GrayImage, hit: Hit | null): LiveHit {
  const { width, height } = gray
  const mx = width * EDGE_MARGIN
  const my = height * EDGE_MARGIN
  const edge =
    hit !== null && hit.corners.some((p) => p.x < mx || p.y < my || p.x > width - mx || p.y > height - my)
  return { corners: hit?.corners ?? null, score: hit?.score ?? 0, size: hit?.size ?? 0, edge }
}
