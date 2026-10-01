import type { GridSize } from '../solver/board'
import { extractCells, type CellTensor } from './cells'
import { labelComponents, traceBoundary } from './components'
import { boxBlur3, centralMedian, cropGray, downscale, invertGray, type GrayImage, type Point } from './image'
import { GRID_MAX_ASPECT, isPlausibleQuad, orderCorners, polygonArea, quadAspect, reduceToQuad, simplifyClosed } from './quad'
import { fitSidesToPrior, refineCorners } from './refine'
import { adaptiveThreshold } from './threshold'
import {
  detectGridSize,
  edgeProfiles,
  gridLineStrength,
  localLines,
  MAX_LINE_IRREGULARITY,
  relocaliseLines,
  spacingIrregularity,
  uniform,
} from './gridSize'

export { MAX_LINE_IRREGULARITY, spacingIrregularity }
import { applyHomography, homography, warpToSquare } from './warp'

export const DETECT_MAX_DIM = 800
export const WARP_SIZE = 1024

export interface DetectedQuad {
  /** Corners tl, tr, br, bl in the coordinates of the image given. */
  corners: Point[]
  /** Fraction of the frame covered by the quad, 0..1. */
  coverage: number
  /** The whole frame, offered for a screenshot cropped to its grid. */
  frame?: boolean
}

/**
 * Find grid-like quads in a (detect-scale) grayscale frame, best first.
 * Pure detection - no warping or classification. Tries a sensitive threshold
 * first; if nothing plausible emerges (e.g. a shadow edge merged with the
 * grid), retries with a stronger offset that drops soft shadow gradients.
 */
export function detectQuads(gray: GrayImage, maxCandidates = 3, minAreaFraction = 0.12): DetectedQuad[] {
  const blurred = boxBlur3(gray)
  // 8 suits print; 16 cuts through texture and noise; 4 is the last resort
  // for faint grids (pale rules on a screen) that neither of the others
  // closes into one contour.
  for (const offset of [8, 16, 4]) {
    const quads = detectQuadsAtOffset(gray, blurred, offset, maxCandidates, minAreaFraction)
    if (quads.length > 0) return quads
  }
  return []
}

function detectQuadsAtOffset(
  gray: GrayImage,
  blurred: GrayImage,
  offset: number,
  maxCandidates: number,
  minAreaFraction: number,
): DetectedQuad[] {
  const window = Math.max(15, Math.round(Math.max(gray.width, gray.height) / 20)) | 1
  const mask = adaptiveThreshold(blurred, window, offset)
  const { labels, components } = labelComponents(mask)

  const frameArea = gray.width * gray.height
  const candidates = components
    .map((c) => ({ c, bboxArea: (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1) }))
    .filter(({ bboxArea }) => bboxArea >= minAreaFraction * frameArea)
    .sort((a, b) => b.bboxArea - a.bboxArea)
    .slice(0, Math.max(6, maxCandidates))

  const quads: DetectedQuad[] = []
  for (const { c } of candidates) {
    const contour = traceBoundary(labels, gray.width, gray.height, c)
    if (contour.length < 40) continue
    let perimeter = 0
    for (let i = 0; i < contour.length; i++) {
      const j = (i + 1) % contour.length
      perimeter += Math.hypot(contour[j].x - contour[i].x, contour[j].y - contour[i].y)
    }
    const poly = simplifyClosed(contour, perimeter * 0.02)
    if (poly.length < 4) continue
    const quad = orderCorners(reduceToQuad(poly))
    if (!isPlausibleQuad(quad)) continue
    const bboxArea = (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)
    if (polygonArea(quad) < 0.5 * bboxArea) continue
    const refined = refineCorners(contour, quad)
    const final = isPlausibleQuad(refined) ? refined : quad
    quads.push({ corners: final, coverage: polygonArea(final) / frameArea })
    if (quads.length >= maxCandidates) break
  }
  return quads
}

/** One verified grid: geometry, its warp and everything needed to read it. */
export interface VerifiedGrid {
  size: GridSize
  /** Corners in full-resolution image coordinates (tl, tr, br, bl). */
  corners: Point[]
  warped: GrayImage
  /** Extracted cell tensors; present for the chosen grid, lazy for
   * alternatives (see gridCells). */
  cells: CellTensor[] | undefined
  /** Relocalised grid-line positions in warped-image pixels (length size+1). */
  rowLines: number[]
  colLines: number[]
  sizeConfidence: number
  /** Verified only by the faint-rule fallback (weaker evidence). */
  faint?: boolean
  /** How well the outline fits the rules (see verifyAndPick; higher is
   * better): even spacing, no shear, inked. */
  geometry?: number
}

export interface ScanSuccess extends VerifiedGrid {
  ok: true
  /** Read from the negative: a dark-mode screen (light ink on dark). The
   * warp and cells are then dark-on-light like any other grid. */
  inverted?: boolean
  cells: CellTensor[]
  /** Other distinct puzzles verified on the same page, best first (a
   * newspaper puzzles page). Never includes the chosen grid. */
  alternatives: VerifiedGrid[]
}

export interface ScanFailure {
  ok: false
  reason: 'no-grid' | 'ambiguous-size'
  /** Present for ambiguous-size so the caller can ask the user and continue. */
  corners?: Point[]
  warped?: GrayImage
  inverted?: boolean
}

export type ScanResult = ScanSuccess | ScanFailure

/** A frame whose centre is darker than this is most likely a dark-mode
 * screen (light digits on a dark board): read its negative first. */
const DARK_FIRST_MEDIAN = 90
/** Up to this, a failed read is retried on the negative (dim photos of
 * light pages sit below it too, so it is only a fallback). */
const DARK_RETRY_MEDIAN = 150
/** Background brightness gap that settles which polarity is paper. */
const POLARITY_MARGIN = 30
/** Outline overlap (bounding-box IoU) above which two reads are one grid. */
const SAME_GRID_OVERLAP = 0.8

/**
 * Locate and verify the grid in either polarity. Paper and light-mode
 * screens are dark ink on light; dark-mode screens (common on laptops and
 * phones) are the opposite and verify as nothing until inverted. `propose`
 * runs the detector CNN on whichever image is being tried.
 */
export async function locateGrid(
  gray: GrayImage,
  propose: (img: GrayImage) => Promise<Proposal[]>,
  opts: ProcessOptions = {},
): Promise<ScanResult> {
  const median = centralMedian(gray)
  const tryImage = async (img: GrayImage, inverted: boolean): Promise<ScanResult> => {
    const r = processImage(img, await propose(img), opts)
    return inverted ? { ...r, inverted: true } : r
  }
  const darkFirst = median < DARK_FIRST_MEDIAN
  const first = await tryImage(darkFirst ? invertGray(gray) : gray, darkFirst)
  if (median >= DARK_RETRY_MEDIAN || (first.ok && darkFirst)) return first
  // In between (a dim photo, or a dark page with a bright surround) either
  // polarity may be right, and the wrong one can still verify something - a
  // box of a dark-mode grid, or a whole newspaper page in negative. Read
  // both and keep the one whose straightened grid looks like ink on paper:
  // the right polarity has the brighter background.
  const second = await tryImage(darkFirst ? gray : invertGray(gray), !darkFirst)
  if (first.ok && second.ok) {
    const a = centralMedian(first.warped)
    const b = centralMedian(second.warped)
    const areaA = polygonArea(first.corners)
    const areaB = polygonArea(second.corners)
    // The negative wins when it looks like paper and is the whole grid (the
    // first read was a fragment of it), not a stray small region elsewhere.
    opts.trace?.(`polarity: paper ${a} vs ${b} (negative), geometry ${first.geometry?.toFixed(1)} vs ${second.geometry?.toFixed(1)}`)
    if (b - a >= POLARITY_MARGIN) return areaB >= 0.6 * areaA ? second : first
    if (a - b >= POLARITY_MARGIN) return first
    // Neither is clearly paper (a mid-grey dark theme). When both found the
    // same grid, the one whose rules verified cleanly has the truer outline:
    // the other polarity can pass on a skewed or faint fit of it.
    if (quadOverlap(first.corners, second.corners) > SAME_GRID_OVERLAP) {
      const d = (second.geometry ?? 0) - (first.geometry ?? 0)
      if (Math.abs(d) >= GEOMETRY_MARGIN) return d > 0 ? second : first
    }
    return areaB > areaA * 1.2 ? second : first
  }
  if (first.ok) return first
  if (second.ok) return second
  // Keep the more useful failure: an ambiguous warp lets the user pick a size.
  return first.reason === 'ambiguous-size' ? first : second
}

/**
 * Full still-image path: detect the grid, warp it, identify the grid size,
 * relocalise lines, and extract normalised cell tensors.
 */
/** A detector proposal: corners in full-res px plus the model's confidence. */
export interface Proposal {
  corners: Point[]
  score: number
}

/** Proposals at or above this score are trusted to have found the puzzle. */
const CONFIDENT_PROPOSAL = 0.75

export interface ProcessOptions {
  /** Look for other puzzles when the chosen one is small in the frame (a
   * puzzles page). Off for camera captures: the user framed one puzzle. */
  pageSearch?: boolean
  /** The outline the live camera locked onto: the user's choice among the
   * puzzles in view. When it verifies it wins, whatever else scores. */
  prefer?: Point[]
  /** Where the user aimed (the centre of a camera capture taken without a
   * lock): among several puzzles in view, the one under it is favoured. */
  aim?: Point
  /** Debugging: told how each candidate outline fared. */
  trace?: (message: string) => void
}

/** Attach the chosen grid's cells (cut once, at the very end). */
function withCells(r: ScanResult): ScanResult {
  if (r.ok && r.cells.length === 0) r.cells = cutCells(r.warped, r.rowLines, r.colLines, r.faint)
  return r
}

export function processImage(fullGray: GrayImage, proposals: Proposal[] = [], opts: ProcessOptions = {}): ScanResult {
  return withCells(locateAndVerify(fullGray, proposals, opts.pageSearch ?? true, opts.prefer ?? null, opts.aim ?? null, opts.trace))
}

function locateAndVerify(
  fullGray: GrayImage,
  proposals: Proposal[],
  pageSearch: boolean,
  prefer: Point[] | null,
  aim: Point | null,
  trace?: (message: string) => void,
): ScanResult {
  const detectImg = downscale(fullGray, DETECT_MAX_DIM)
  const scale = fullGray.width / detectImg.width
  let classical: DetectedQuad[] = detectQuads(detectImg).map((q) => ({
    ...q,
    corners: q.corners.map((p) => ({ x: p.x * scale, y: p.y * scale })),
  }))
  // Model proposals (full-res corners from the detector CNN): snap each to
  // the actual grid border on a full-resolution crop - the model localises
  // robustly, classical refinement gets the corners pixel-accurate.
  const frameArea = fullGray.width * fullGray.height
  // A proposal must be a plausible square-ish quad, refined or not: the
  // model occasionally boxes two stacked puzzles as one tall region, and a
  // warp of that verifies as nonsense (a 4x4 of two squashed 9x9s).
  const proposed: DetectedQuad[] = []
  const addFitted = (corners: Point[]): void => {
    const fitted = fitOutlineToBorder(fullGray, corners)
    if (fitted && !proposed.some((q) => sameOutline(q.corners, fitted.corners))) proposed.push(fitted)
  }
  for (const p of proposals) {
    const refined = refineQuadOnCrop(fullGray, p.corners)
    if (refined) proposed.push(refined)
    else if (isPlausibleQuad(p.corners)) {
      proposed.push({ corners: p.corners, coverage: polygonArea(p.corners) / frameArea })
    }
    if (isPlausibleQuad(p.corners)) addFitted(p.corners)
  }
  // The locked outline is also fitted side by side (its snap can be pulled
  // by a neighbouring puzzle's rules or a label). The raw outline itself is
  // not a candidate: it is loose, and scores well on size confidence alone.
  if (prefer && isPlausibleQuad(prefer)) addFitted(prefer)
  // On a faint or blurred grid the classical pass often returns a fragment
  // of the puzzle (a few boxes whose lines happen to look like a 4x4). When
  // the detector is confident about the whole puzzle, such sub-regions of
  // it are noise, not rivals - drop them. Separate grids elsewhere on the
  // page are untouched.
  const confident = proposals.filter((p) => p.score >= CONFIDENT_PROPOSAL && isPlausibleQuad(p.corners))
  if (confident.length > 0) {
    classical = classical.filter((q) => !confident.some((p) => isSubRegion(q.corners, p.corners)))
  }

  // Classical outlines get the same side fit: their corners come from the
  // traced polygon, which a label or text touching the grid can drag.
  for (const q of classical.slice(0, 3)) addFitted(q.corners)
  // A screenshot cropped to the grid has no outer border inside the frame
  // to find: the frame itself is a candidate (a tall phone screen fails the
  // grid-shape check, so this only ever wins for a grid-shaped image).
  const W = fullGray.width - 1
  const H = fullGray.height - 1
  proposed.push({ corners: [{ x: 1, y: 1 }, { x: W - 1, y: 1 }, { x: W - 1, y: H - 1 }, { x: 1, y: H - 1 }], coverage: 1, frame: true })

  const picked = verifyAndPick([...proposed, ...classical], fullGray, prefer, aim, trace)
  if (picked.best !== null) {
    // A small grid in a big frame is usually one puzzle on a puzzles page:
    // look for its neighbours too, so the user can switch without a new
    // photo. Only the wide classical net finds grids under the size floor.
    let best = picked.best
    const coverage = polygonArea(best.corners) / frameArea
    if (pageSearch && coverage < PAGE_COVERAGE) {
      const wide = detectQuads(detectImg, 10, 0.015).map((q) => {
        const full = q.corners.map((p) => ({ x: p.x * scale, y: p.y * scale }))
        return refineQuadOnCrop(fullGray, full) ?? { ...q, corners: full }
      })
      const others = verifyAndPick(wide, fullGray).best
      // A winner verified only on faint evidence yields to a grid the wide
      // net verified on ink (it is usually a skewed outline of a puzzle
      // whose true outline only the wide net found).
      if (best.faint && others && !others.faint) best = { ...others, alternatives: [] }
      const found = others ? [others, ...others.alternatives] : []
      for (const g of found) {
        if (best.alternatives.length >= MAX_ALTERNATIVES) break
        const dup = quadOverlap(g.corners, best.corners) > 0.5 || best.alternatives.some((a) => quadOverlap(a.corners, g.corners) > 0.5)
        if (!dup) best.alternatives.push(g)
      }
    }
    return best
  }
  // Nothing verified: cast a wider net for small grids on a busy page.
  const fallback = smallGridFallback(fullGray, detectImg, scale)
  if (fallback.ok || picked.firstWarp === null) return fallback
  // A quad was found but its size is ambiguous - let the user pick.
  return { ok: false, reason: 'ambiguous-size', ...picked.firstWarp }
}

/**
 * Warp-verify every candidate quad and keep the best-scoring real grid
 * (line-spacing regularity + size confidence + coverage), never the first
 * that squeaks past: on a busy page a junk region can "verify" as a
 * low-confidence 4x4 while the actual sudoku scores far higher.
 */
function verifyAndPick(
  candidates: DetectedQuad[],
  fullGray: GrayImage,
  prefer: Point[] | null = null,
  aim: Point | null = null,
  trace?: (message: string) => void,
): { best: ScanSuccess | null; firstWarp: { corners: Point[]; warped: GrayImage } | null } {
  let firstWarp: { corners: Point[]; warped: GrayImage } | null = null
  interface Verified {
    score: number
    /** Outline quality alone: even rules, no shear, inked (not faint). */
    geometry: number
    corners: Point[]
    warped: GrayImage
    sized: NonNullable<ReturnType<typeof detectGridSize>>
    cells?: CellTensor[]
    filled?: number
  }
  const verified: Verified[] = []
  for (const quad of candidates) {
    const say = trace && ((m: string) => trace(`${quad.corners.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ')}${quad.frame ? ' (frame)' : ''}: ${m}`))
    if (!isGridShaped(quad.corners, fullGray)) {
      say?.('not grid-shaped')
      continue
    }
    const warped = warpToSquare(fullGray, quad.corners, WARP_SIZE)
    const sized = detectGridSize(warped)
    if (sized === null) {
      say?.('no grid size')
      firstWarp ??= { corners: quad.corners, warped }
      continue
    }
    // The whole frame only counts when the grid really fills it: its outer
    // rules sit at the frame's edges (a page photo's grid sits well inside).
    if (quad.frame && !fillsWarp(sized.rowLines, sized.colLines, warped.width)) continue
    const irregularity = Math.max(
      spacingIrregularity(sized.rowLines),
      spacingIrregularity(sized.colLines),
    )
    // A frame-filling grid is a flat screenshot crop: its rules are almost
    // exactly even (measured: 0.05-0.08, against 0.10-0.19 for close-up page
    // photos, whose own outline must win).
    if (quad.frame && irregularity > FRAME_MAX_IRREGULARITY) continue
    if (irregularity > MAX_LINE_IRREGULARITY) {
      say?.(`${sized.size}x${sized.size} too irregular (${irregularity.toFixed(3)})`)
      firstWarp ??= { corners: quad.corners, warped }
      continue
    }
    // A sheared outline (one corner pulled along an edge) warps the grid into
    // evenly spaced but slanted lines, which the spacing test cannot see.
    // The true outline gives square-on lines (a crumpled or curled page bends
    // them a little); a strong shear means the wrong outline.
    const slant = lineSlant(warped, sized)
    if (slant > MAX_LINE_SLANT) {
      say?.(`${sized.size}x${sized.size} too slanted (${slant.toFixed(2)})`)
      firstWarp ??= { corners: quad.corners, warped }
      continue
    }
    const geometry =
      (MAX_LINE_IRREGULARITY - irregularity) * 100 -
      (sized.faint ? FAINT_PENALTY : 0) -
      SLANT_PENALTY * Math.max(0, slant - SLANT_FREE)
    const score =
      geometry +
      Math.min(sized.confidence, 40) +
      quad.coverage * 10 +
      (prefer && quadOverlap(quad.corners, prefer) > 0.6 ? PREFER_BONUS : 0) +
      (aim && insideQuad(aim, quad.corners) ? AIM_BONUS : 0) +
      (quad.frame ? FRAME_BONUS : 0)
    say?.(
      `${sized.size}x${sized.size} score ${score.toFixed(1)} (geometry ${geometry.toFixed(1)}: irregularity ${irregularity.toFixed(3)}, slant ${slant.toFixed(2)}${sized.faint ? ', faint' : ''}; size confidence ${Math.min(sized.confidence, 40).toFixed(1)})`,
    )
    verified.push({ score, geometry, corners: quad.corners, warped, sized })
  }
  if (verified.length === 0) return { best: null, firstWarp }
  // Several real grids on one page (a puzzle beside yesterday's printed
  // solution): a grid with nearly every cell filled is a solution, not a
  // puzzle, so it only wins when nothing else verifies.
  if (verified.length > 1) {
    for (const v of verified) {
      v.filled = inkedCellFraction(v.warped, v.sized.rowLines, v.sized.colLines)
      if (v.filled > SOLUTION_FILL_FRACTION) v.score -= 60
    }
  }
  verified.sort((a, b) => b.score - a.score)
  // The same grid usually verifies twice (model proposal + classical quad):
  // keep the best-scoring copy of each distinct region.
  // The same grid outlined twice keeps its rank, but the outline read is
  // the one with the most even, least sheared rules: the size-confidence
  // and coverage terms say nothing about which of two outlines fits.
  const distinct: Verified[] = []
  for (const v of verified) {
    const i = distinct.findIndex((d) => quadOverlap(d.corners, v.corners) > 0.5)
    if (i < 0) distinct.push(v)
    else if (
      v.sized.size === distinct[i].sized.size &&
      quadOverlap(distinct[i].corners, v.corners) > SAME_GRID_OVERLAP &&
      v.geometry > distinct[i].geometry + GEOMETRY_MARGIN
    ) {
      distinct[i] = { ...v, score: distinct[i].score }
    }
  }
  const toGrid = (v: Verified, withCells: boolean): VerifiedGrid => ({
    size: v.sized.size,
    corners: v.corners,
    warped: v.warped,
    cells: withCells ? (v.cells ?? cutCells(v.warped, v.sized.rowLines, v.sized.colLines, v.sized.faint)) : v.cells,
    rowLines: v.sized.rowLines,
    colLines: v.sized.colLines,
    sizeConfidence: v.sized.confidence,
    faint: v.sized.faint,
    geometry: v.geometry,
  })
  const [best, ...rest] = distinct
  // The winner gets a second look at its geometry before its cells are cut.
  for (let pass = 0; pass < 3; pass++) {
    const better = refineWarpByLines(fullGray, best.corners, best.warped, best.sized, trace && ((m) => trace(`refine: ${m}`)))
    if (!better) break
    best.corners = better.corners
    best.warped = better.warped
    best.sized = better.sized
    best.cells = undefined
  }
  // Alternatives are other puzzles worth offering: not printed solutions.
  // Their cells are extracted only if the user switches to them.
  const alternatives = rest
    .filter((v) => (v.filled ?? 0) <= SOLUTION_FILL_FRACTION)
    .slice(0, MAX_ALTERNATIVES)
    .map((v) => toGrid(v, false))
  const chosen = toGrid(best, false)
  // Cells are cut only for the grid finally returned (see withCells): the
  // page search verifies other grids that may never be read.
  return { best: { ok: true, ...chosen, cells: [], alternatives }, firstWarp }
}

/** Line shear (in cells, across the warp) above which an outline is
 * rejected; between SLANT_FREE and it, each cell of shear costs
 * SLANT_PENALTY ranking points (measured: true grids 0-0.05, curled or
 * crumpled pages 0.25-0.6, wrong outlines 0.7 and up). */
const MAX_LINE_SLANT = 1.2
const SLANT_FREE = 0.15
const SLANT_PENALTY = 60

/**
 * Accumulated shear of the grid's lines across the warp, in cells: the
 * line profile of each of 12 strips is matched to the next strip's (a small
 * shift, found by correlation) and the shifts are summed. Comparing only
 * the two edge bands aliases - a shear of exactly one box width lines every
 * rule up with another rule - but strip-to-strip steps are too small to.
 */
function lineSlant(warped: GrayImage, sized: NonNullable<ReturnType<typeof detectGridSize>>): number {
  const dim = warped.width
  const cell = dim / sized.size
  return Math.max(shearAlong(warped, cell, true), shearAlong(warped, cell, false)) / cell
}

function shearAlong(img: GrayImage, cell: number, columns: boolean): number {
  const { data, width: dim } = img
  const strips = 12
  const len = Math.floor(dim / strips)
  const profiles: Float64Array[] = []
  for (let s = 0; s < strips; s++) {
    const p = new Float64Array(dim)
    for (let t = s * len; t < (s + 1) * len; t++) {
      for (let i = 0; i < dim; i++) p[i] += 255 - data[columns ? t * dim + i : i * dim + t]
    }
    // Remove the mean so correlation tracks the rules, not overall ink.
    let mean = 0
    for (let i = 0; i < dim; i++) mean += p[i]
    mean /= dim
    for (let i = 0; i < dim; i++) p[i] -= mean
    profiles.push(p)
  }
  const maxShift = Math.max(2, Math.round(cell * 0.4))
  const shifts: number[] = []
  for (let s = 1; s < strips; s++) {
    const a = profiles[s - 1]
    const b = profiles[s]
    let best = 0
    let bestScore = -Infinity
    for (let d = -maxShift; d <= maxShift; d++) {
      let sum = 0
      for (let i = Math.max(0, -d); i < Math.min(dim, dim - d); i++) sum += a[i] * b[i + d]
      if (sum > bestScore) {
        bestScore = sum
        best = d
      }
    }
    // A best match at the edge of the search is no match (digits, not
    // rules, dominated the strip); one such jump used to cancel or fake a
    // whole grid's worth of shear.
    if (Math.abs(best) < maxShift) shifts.push(best)
  }
  if (shifts.length === 0) return 0
  shifts.sort((x, y) => x - y)
  return Math.abs(shifts[shifts.length >> 1]) * (strips - 1)
}

/** Shortest side a readable grid can have (full-res px): ~10 px cells. */
const MIN_GRID_SIDE = 90
/** How far outside the photo a corner may sit (fraction of its size). */
const FRAME_TOLERANCE = 0.02

/**
 * Could this quad be a whole, readable grid? Beyond the shape check: big
 * enough to read, and inside the photo. A grid running off the edge is
 * missing a row or column, and bending one corner inward to "fit" it read
 * a shifted grid (dozens of wrong cells) instead of failing honestly.
 */
function isGridShaped(corners: Point[], img: GrayImage): boolean {
  if (!isPlausibleQuad(corners) || quadAspect(corners) > GRID_MAX_ASPECT) return false
  for (let i = 0; i < 4; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % 4]
    if (Math.hypot(b.x - a.x, b.y - a.y) < MIN_GRID_SIDE) return false
  }
  const tx = img.width * FRAME_TOLERANCE
  const ty = img.height * FRAME_TOLERANCE
  return corners.every((p) => p.x >= -tx && p.y >= -ty && p.x <= img.width + tx && p.y <= img.height + ty)
}

/** Cells of a grid, extracted on demand for alternatives. */
export function gridCells(grid: VerifiedGrid): CellTensor[] {
  grid.cells ??= cutCells(grid.warped, grid.rowLines, grid.colLines, grid.faint)
  return grid.cells
}

/** Cell extraction along locally measured lines (page curl tolerant). A
 * grid whose rules are too faint to show in the ink (`faint`) is cut on its
 * global lines: per-band measurement would lock onto digit strokes there
 * and slice through the digits. */
function cutCells(warped: GrayImage, rowLines: number[], colLines: number[], faint = false): CellTensor[] {
  if (faint) return extractCells(warped, rowLines, colLines)
  return extractCells(warped, rowLines, colLines, localLines(warped, rowLines, colLines))
}

/** Ranking lift for a grid on the live camera's locked outline. */
const PREFER_BONUS = 80
/** How much better an alternative outline of the same grid must fit (in
 * ranking points, ~0.01 of irregularity each) to replace the top-ranked. */
const GEOMETRY_MARGIN = 10
/** Ranking bonus for the grid under the point the camera was aimed at:
 * decides between comparable puzzles, not over a clearly better read. */
const AIM_BONUS = 40

/** Ranking cost of a grid verified only by the faint-rule fallback: it
 * wins when nothing verifies on ink, never over a grid that does. */
const FAINT_PENALTY = 40

/** Most other grids kept alongside the chosen one. */
const MAX_ALTERNATIVES = 3
/** Below this share of the frame the chosen grid is treated as one puzzle
 * on a page, and the page is searched for the others. */
const PAGE_COVERAGE = 0.25

/** Bounding-box intersection over union of two quads. */
/** Every corner within 1.5% of the outline's size: the same candidate.
 * (Bounding boxes can match while one corner is far off.) */
function sameOutline(a: Point[], b: Point[]): boolean {
  const size = Math.hypot(a[2].x - a[0].x, a[2].y - a[0].y)
  return a.every((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y) < 0.015 * size)
}

/** Outer grid lines within FRAME_EDGE of the warp's edges. */
function fillsWarp(rows: number[], cols: number[], dim: number): boolean {
  const edge = FRAME_EDGE * dim
  return rows[0] < edge && cols[0] < edge && rows[rows.length - 1] > dim - edge && cols[cols.length - 1] > dim - edge
}

/** How close to the frame edges a frame-filling grid's outer rules are. */
const FRAME_EDGE = 0.05
const FRAME_MAX_IRREGULARITY = 0.09
/** A verified frame-filling grid is the grid (a region of it can verify too). */
const FRAME_BONUS = 60

function quadOverlap(a: Point[], b: Point[]): number {
  const bbox = (q: Point[]) => {
    const xs = q.map((p) => p.x)
    const ys = q.map((p) => p.y)
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
  }
  const p = bbox(a)
  const q = bbox(b)
  const ix = Math.max(0, Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0))
  const iy = Math.max(0, Math.min(p.y1, q.y1) - Math.max(p.y0, q.y0))
  const inter = ix * iy
  const union = (p.x1 - p.x0) * (p.y1 - p.y0) + (q.x1 - q.x0) * (q.y1 - q.y0) - inter
  return union > 0 ? inter / union : 0
}

/** A verified grid with more than this fraction of cells inked is a printed
 * solution rather than a puzzle. */
const SOLUTION_FILL_FRACTION = 0.85

/** Line disagreement between opposite edge bands (as a fraction of a cell)
 * above which the warp is re-fitted. */
const WARP_TILT_TOLERANCE = 0.06

/**
 * Second look at a verified warp. The grid lines are measured separately
 * in the left/right bands (rows) and top/bottom bands (columns). On a
 * true-to-square warp they agree; when a corner was placed a few pixels off
 * (a far, dark corner of a hand-held photo) or the page curls, the lines
 * tilt across the warp and the outer rows or columns land off their cells.
 * The measured border lines are intersected for corrected corners, mapped
 * back through the warp's homography and re-warped. Kept only if the lines
 * come out straighter.
 */
export function refineWarpByLines(
  fullGray: GrayImage,
  corners: Point[],
  warped: GrayImage,
  sized: NonNullable<ReturnType<typeof detectGridSize>>,
  trace?: (message: string) => void,
): { corners: Point[]; warped: GrayImage; sized: NonNullable<ReturnType<typeof detectGridSize>> } | null {
  const dim = warped.width
  const n = sized.size
  const cell = dim / n
  // Borders are extrapolated from the interior lines (least squares over
  // k = 1..n-1): the interior is where the lines are, whereas a border can
  // sit outside the warp altogether when a corner was placed short.
  const fitBorders = (lines: number[]): [number, number] => {
    let sk = 0
    let sv = 0
    let skk = 0
    let skv = 0
    const m = n - 1
    for (let k = 1; k < n; k++) {
      sk += k
      sv += lines[k]
      skk += k * k
      skv += k * lines[k]
    }
    const b = (m * skv - sk * sv) / (m * skk - sk * sk)
    const a = (sv - b * sk) / m
    return [a, a + b * n]
  }
  const measure = (img: GrayImage) => {
    const band = Math.round(dim * 0.3)
    const e = edgeProfiles(img, band)
    const L = relocaliseLines(e.rowsLeft, n, dim)
    const R = relocaliseLines(e.rowsRight, n, dim)
    const T = relocaliseLines(e.colsTop, n, dim)
    const B = relocaliseLines(e.colsBottom, n, dim)
    let tilt = 0
    for (let k = 1; k < n; k++) tilt = Math.max(tilt, Math.abs(R[k] - L[k]), Math.abs(B[k] - T[k]))
    const borders = { L: fitBorders(L), R: fitBorders(R), T: fitBorders(T), B: fitBorders(B) }
    // How far the fitted borders sit from the warp edges (a short corner).
    let overhang = 0
    for (const [b0, bN] of Object.values(borders)) overhang = Math.max(overhang, Math.abs(b0), Math.abs(bN - dim))
    return { L, R, T, B, band, tilt, borders, overhang }
  }
  const m = measure(warped)
  trace?.(`tilt ${m.tilt.toFixed(1)} overhang ${m.overhang.toFixed(1)} (tolerance ${(WARP_TILT_TOLERANCE * cell).toFixed(1)})`)
  if (m.tilt < WARP_TILT_TOLERANCE * cell && m.overhang < WARP_TILT_TOLERANCE * cell) return null

  // Border lines through the band centres, then their intersections.
  const xl = m.band / 2
  const xr = dim - m.band / 2
  const yt = m.band / 2
  const yb = dim - m.band / 2
  type Line = [Point, Point]
  const top: Line = [{ x: xl, y: m.borders.L[0] }, { x: xr, y: m.borders.R[0] }]
  const bottom: Line = [{ x: xl, y: m.borders.L[1] }, { x: xr, y: m.borders.R[1] }]
  const left: Line = [{ x: m.borders.T[0], y: yt }, { x: m.borders.B[0], y: yb }]
  const right: Line = [{ x: m.borders.T[1], y: yt }, { x: m.borders.B[1], y: yb }]
  const cross = (a: Line, b: Line): Point | null => {
    const d = (a[0].x - a[1].x) * (b[0].y - b[1].y) - (a[0].y - a[1].y) * (b[0].x - b[1].x)
    if (Math.abs(d) < 1e-9) return null
    const t = ((a[0].x - b[0].x) * (b[0].y - b[1].y) - (a[0].y - b[0].y) * (b[0].x - b[1].x)) / d
    return { x: a[0].x + t * (a[1].x - a[0].x), y: a[0].y + t * (a[1].y - a[0].y) }
  }
  const warpCorners = [cross(top, left), cross(top, right), cross(bottom, right), cross(bottom, left)]
  if (warpCorners.some((p) => p === null)) return null
  trace?.(`warp corners ${warpCorners.map((p) => `${p!.x.toFixed(0)},${p!.y.toFixed(0)}`).join(' ')}`)
  // Refuse wild corrections: each corner may move at most one cell.
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: dim, y: 0 },
    { x: dim, y: dim },
    { x: 0, y: dim },
  ]
  if (warpCorners.some((p, i) => Math.hypot(p!.x - square[i].x, p!.y - square[i].y) > 1.5 * cell)) {
    trace?.('rejected: a corner would move more than 1.5 cells')
    return null
  }

  const toSource = homography(square, corners)
  const newCorners = warpCorners.map((p) => applyHomography(toSource, p!))
  if (!isGridShaped(newCorners, fullGray)) {
    trace?.('rejected: implausible quad')
    return null
  }
  const newWarped = warpToSquare(fullGray, newCorners, dim)
  const newSized = detectGridSize(newWarped)
  if (newSized === null || newSized.size !== n) {
    trace?.(`rejected: re-warp sized ${newSized ? newSized.size : 'null'}`)
    return null
  }
  const after = measure(newWarped)
  const irregular = (s: NonNullable<ReturnType<typeof detectGridSize>>) =>
    Math.max(spacingIrregularity(s.rowLines), spacingIrregularity(s.colLines))
  // Keep it only if the geometry got clearly better: borders closer to the
  // warp edges and lines less tilted, spacing no more irregular, and the
  // grid lines registering at least as strongly as before (a bad re-warp
  // smears them).
  const before = Math.max(m.tilt, m.overhang)
  const now = Math.max(after.tilt, after.overhang)
  const strengthBefore = gridLineStrength(warped, sized.rowLines, sized.colLines)
  const strengthAfter = gridLineStrength(newWarped, newSized.rowLines, newSized.colLines)
  trace?.(
    `geometry ${before.toFixed(1)} -> ${now.toFixed(1)}, irregularity ${irregular(sized).toFixed(3)} -> ${irregular(newSized).toFixed(3)}, strength ${strengthBefore.toFixed(3)} -> ${strengthAfter.toFixed(3)}`,
  )
  // Lines registering markedly stronger is the surest sign of a truer warp
  // (one pass rarely removes all the tilt of a badly short corner; the
  // caller iterates). Otherwise demand a clear geometric gain with the
  // lines at least as strong.
  const strongerLines = strengthAfter >= strengthBefore * 1.15 && now <= before * 1.05
  const betterGeometry = now <= before * 0.7 && strengthAfter >= strengthBefore * 0.97
  if (
    !(strongerLines || betterGeometry) ||
    irregular(newSized) > Math.max(irregular(sized) + 0.02, MAX_LINE_IRREGULARITY)
  ) {
    trace?.('rejected: not clearly better')
    return null
  }
  return { corners: newCorners, warped: newWarped, sized: newSized }
}

/**
 * Cheap estimate of how many cells hold ink: the share of cells whose inner
 * region has more than a sliver of pixels under the warp's Otsu threshold.
 * Far cheaper than full cell extraction, and all the solution-grid check
 * needs (a solution inks every cell, a puzzle a third to a half).
 */
function inkedCellFraction(warped: GrayImage, rowLines: number[], colLines: number[]): number {
  // Local threshold, like the grid-size detector: paper tone and shading
  // must not count as ink.
  const mask = adaptiveThreshold(warped, Math.max(15, Math.round(warped.width / 24)) | 1, 8)
  const n = rowLines.length - 1
  let inked = 0
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const y0 = Math.round(rowLines[r] + (rowLines[r + 1] - rowLines[r]) * 0.25)
      const y1 = Math.round(rowLines[r + 1] - (rowLines[r + 1] - rowLines[r]) * 0.25)
      const x0 = Math.round(colLines[c] + (colLines[c + 1] - colLines[c]) * 0.25)
      const x1 = Math.round(colLines[c + 1] - (colLines[c + 1] - colLines[c]) * 0.25)
      let dark = 0
      let total = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          total++
          if (mask.data[y * warped.width + x]) dark++
        }
      }
      if (total > 0 && dark / total > 0.03) inked++
    }
  }
  return inked / (n * n)
}

/** True when quad `inner` lies mostly inside `outer` and is clearly smaller
 * (bounding boxes: enough for the sub-fragment case this guards). */
function isSubRegion(inner: Point[], outer: Point[]): boolean {
  const bbox = (q: Point[]) => {
    const xs = q.map((p) => p.x)
    const ys = q.map((p) => p.y)
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
  }
  const a = bbox(inner)
  const b = bbox(outer)
  const areaA = (a.x1 - a.x0) * (a.y1 - a.y0)
  const areaB = (b.x1 - b.x0) * (b.y1 - b.y0)
  if (areaA <= 0 || areaB <= 0) return false
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
  const inter = ix * iy
  return inter / areaA > 0.7 && areaA < 0.75 * areaB
}



/**
 * Second chance for photos where the grid is a small part of the frame (a
 * whole puzzles page, a natural phone distance): nothing clears the normal
 * 12% size floor, so cast a far wider net, re-detect each candidate's corners
 * on a full-resolution crop (corners found on a whole-page downscale are half
 * a cell off for a grid that small, which skews the warp), and keep the
 * best-verified grid. Runs ONLY when the normal pass found nothing, so it can
 * add reads but never change one - and grid verification still decides what's
 * real, so a gridless image still fails.
 */
function smallGridFallback(fullGray: GrayImage, detectImg: GrayImage, scale: number): ScanResult {
  const candidates = detectQuads(detectImg, 10, 0.015).map((q) => {
    const fullResCorners = q.corners.map((p) => ({ x: p.x * scale, y: p.y * scale }))
    return refineQuadOnCrop(fullGray, fullResCorners) ?? { ...q, corners: fullResCorners }
  })
  if (candidates.length === 0) return { ok: false, reason: 'no-grid' }
  const { best, firstWarp } = verifyAndPick(candidates, fullGray)
  if (best !== null) return best
  if (firstWarp !== null) return { ok: false, reason: 'ambiguous-size', ...firstWarp }
  return { ok: false, reason: 'no-grid' }
}

/**
 * A rough outline (model proposal or live lock) snapped to the grid's
 * traced border side by side: the grid's component in a crop around it is
 * traced, and each side of the outline is fitted to the straight run of
 * that border near it (see fitSidesToPrior). Complements refineQuadOnCrop,
 * whose corners come from the traced polygon and can be dragged off by
 * text or a label touching the grid.
 */
export function fitOutlineToBorder(fullGray: GrayImage, corners: Point[], margin = 0.18): DetectedQuad | null {
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const w = Math.max(...xs) - Math.min(...xs)
  const h = Math.max(...ys) - Math.min(...ys)
  if (w < 16 || h < 16) return null
  const x0 = Math.min(...xs) - w * margin
  const y0 = Math.min(...ys) - h * margin
  const crop = cropGray(fullGray, x0, y0, w * (1 + 2 * margin), h * (1 + 2 * margin))
  if (crop.width < 32 || crop.height < 32) return null
  const cx0 = Math.max(0, Math.round(x0))
  const cy0 = Math.max(0, Math.round(y0))
  const small = downscale(crop, DETECT_MAX_DIM)
  const k = crop.width / small.width
  const prior = corners.map((p) => ({ x: (p.x - cx0) / k, y: (p.y - cy0) / k }))
  const priorArea = polygonArea(prior)
  const blurred = boxBlur3(small)
  const window = Math.max(15, Math.round(Math.max(small.width, small.height) / 20)) | 1
  for (const offset of [8, 16]) {
    const mask = adaptiveThreshold(blurred, window, offset)
    const { labels, components } = labelComponents(mask)
    // The grid: the biggest component centred inside the outline.
    let grid = null
    for (const c of components) {
      const area = (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)
      if (area < 0.4 * priorArea || !insideQuad({ x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2 }, prior)) continue
      if (!grid || area > (grid.x1 - grid.x0 + 1) * (grid.y1 - grid.y0 + 1)) grid = c
    }
    if (!grid) continue
    const fitted = fitSidesToPrior(traceBoundary(labels, small.width, small.height, grid), prior, 0.25, mask)
    if (!fitted || !isPlausibleQuad(fitted)) continue
    const full = fitted.map((p) => ({ x: p.x * k + cx0, y: p.y * k + cy0 }))
    return { corners: full, coverage: polygonArea(full) / (fullGray.width * fullGray.height) }
  }
  return null
}

function insideQuad(p: Point, q: Point[]): boolean {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = q[i]
    const b = q[(i + 1) % 4]
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (cross === 0) continue
    if (sign === 0) sign = Math.sign(cross)
    else if (Math.sign(cross) !== sign) return false
  }
  return true
}

/**
 * Coarse-to-fine corner refinement: crop the full-res image around a rough
 * quad (with margin) and re-run detection there, where the grid has several
 * times the pixel density it had in the whole-frame downscale. Returns the
 * refined quad in full-res coords, or null if the crop yields nothing.
 */
export function refineQuadOnCrop(fullGray: GrayImage, corners: Point[], margin = 0.18): DetectedQuad | null {
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const w = Math.max(...xs) - Math.min(...xs)
  const h = Math.max(...ys) - Math.min(...ys)
  if (w < 8 || h < 8) return null
  const x0 = Math.min(...xs) - w * margin
  const y0 = Math.min(...ys) - h * margin
  const crop = cropGray(fullGray, x0, y0, w * (1 + 2 * margin), h * (1 + 2 * margin))
  if (crop.width < 32 || crop.height < 32) return null
  const cx0 = Math.max(0, Math.round(x0))
  const cy0 = Math.max(0, Math.round(y0))

  const detectCrop = downscale(crop, DETECT_MAX_DIM)
  const cropScale = crop.width / detectCrop.width
  const quads = detectQuads(detectCrop, 2)
  if (quads.length === 0) return null
  // The candidate whose centre is nearest the crop centre is our grid.
  const cx = detectCrop.width / 2
  const cy = detectCrop.height / 2
  let bestQuad = quads[0]
  let bestDist = Infinity
  for (const q of quads) {
    const qx = q.corners.reduce((a, p) => a + p.x, 0) / 4
    const qy = q.corners.reduce((a, p) => a + p.y, 0) / 4
    const d = Math.hypot(qx - cx, qy - cy)
    if (d < bestDist) {
      bestDist = d
      bestQuad = q
    }
  }
  return {
    coverage: bestQuad.coverage * ((crop.width * crop.height) / (fullGray.width * fullGray.height)),
    corners: bestQuad.corners.map((p) => ({
      x: p.x * cropScale + cx0,
      y: p.y * cropScale + cy0,
    })),
  }
}

/** Continue an ambiguous-size scan once the user has chosen the size. */
export function processWithKnownSize(
  warped: GrayImage,
  size: GridSize,
): { cells: CellTensor[]; lines: number[] } {
  const lines = uniform(size, warped.width)
  return { cells: extractCells(warped, lines, lines), lines }
}
