import type { GridSize } from '../solver/board'
import type { BinaryImage, GrayImage } from './image'
import { labelComponents } from './components'
import { adaptiveThreshold } from './threshold'

export interface GridSizeResult {
  size: GridSize
  /** Winner's score divided by runner-up's; low values mean ambiguity. */
  confidence: number
  rowLines: number[]
  colLines: number[]
  /** Verified only through the faint-rule fallback (see spanProfiles):
   * weaker evidence, ranked below a grid whose ink verified it. */
  faint?: boolean
}

/** Ink projection profiles of a binarised warped grid. */
export function profiles(mask: BinaryImage): { rows: Float64Array; cols: Float64Array } {
  const { width: w, height: h, data } = mask
  const rows = new Float64Array(h)
  const cols = new Float64Array(w)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      if (data[row + x] !== 0) {
        rows[y]++
        cols[x]++
      }
    }
  }
  for (let y = 0; y < h; y++) rows[y] /= w
  for (let x = 0; x < w; x++) cols[x] /= h
  return { rows, cols }
}

/** Below this best binary-profile score the grid is too faint to trust the
 * thresholded profiles; well-printed grids score 0.1-0.5. */
const SOFT_PROFILE_SCORE = 0.05

/**
 * Threshold-free LINE profiles. A grid line is a thin valley: along a line
 * row nearly every pixel is darker than the pixels a few px above and
 * below it, however faint the ink. A digit stroke is a valley too, but
 * only across its own cell. Averaging the (capped) valley depth along each
 * row and column therefore lights up lines and stays low on digits -
 * unlike a plain darkness profile, which digit rows dominate when the
 * print is faint. Normalised so the strongest line reads ~1.
 */
export function softProfiles(img: GrayImage, window: number): { rows: Float64Array; cols: Float64Array } {
  const { width: w, height: h, data } = img
  // Valley half-width: a hair over the thickest line we expect at this
  // scale, so both edges of a thick rule still register.
  const d = Math.max(3, Math.round(window / 9))
  const cap = 20
  const rows = new Float64Array(h)
  const cols = new Float64Array(w)
  for (let y = d; y < h - d; y++) {
    const up = (y - d) * w
    const mid = y * w
    const dn = (y + d) * w
    for (let x = 0; x < w; x++) {
      const depth = Math.min(data[up + x], data[dn + x]) - data[mid + x]
      if (depth > 0) rows[y] += Math.min(depth, cap)
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = d; x < w - d; x++) {
      const depth = Math.min(data[row + x - d], data[row + x + d]) - data[row + x]
      if (depth > 0) cols[x] += Math.min(depth, cap)
    }
  }
  const normalise = (p: Float64Array): void => {
    const sorted = Float64Array.from(p).sort()
    const top = sorted[Math.floor(0.99 * (sorted.length - 1))] || 1
    for (let i = 0; i < p.length; i++) p[i] = Math.min(1, p[i] / top)
  }
  normalise(rows)
  normalise(cols)
  return { rows, cols }
}

function windowMax(profile: Float64Array, centre: number, radius: number): number {
  let best = 0
  const lo = Math.max(0, Math.round(centre - radius))
  const hi = Math.min(profile.length - 1, Math.round(centre + radius))
  for (let i = lo; i <= hi; i++) if (profile[i] > best) best = profile[i]
  return best
}

/** Score how well N internal grid lines explain the profiles. */
/**
 * Score how well N internal grid lines explain the profiles. Lines are
 * expected at uniform spacing across the grid's OUTER SPAN (the border
 * relocalised per hypothesis, see outerSpan), not across the whole warp:
 * a slightly loose quad shrinks the real spacing by a few percent, which
 * shifts the far lines by more than a fine hypothesis tolerates while a
 * coarse one shrugs it off, and that asymmetry alone used to turn a 16x16
 * into a 4x4. Interior lines are still expected exactly where a regular
 * grid puts them, so a wrong hypothesis cannot snap onto real lines.
 */
export function scoreSize(rows: Float64Array, cols: Float64Array, n: number, dim: number): number {
  const cell = dim / n
  const radius = Math.max(3, cell * 0.06)
  const box = Math.round(Math.sqrt(n))
  const [r0, r1] = outerSpan(rows, n, dim)
  const [c0, c1] = outerSpan(cols, n, dim)
  const rowAt = (k: number): number => r0 + (k * (r1 - r0)) / n
  const colAt = (k: number): number => c0 + (k * (c1 - c0)) / n
  let lineScore = 0
  let cellScore = 0
  let boxLines = 0
  let thinLines = 0
  let nBox = 0
  let nThin = 0
  for (let k = 1; k < n; k++) {
    const v = windowMax(rows, rowAt(k), radius) + windowMax(cols, colAt(k), radius)
    lineScore += v
    if (k % box === 0) {
      boxLines += v
      nBox++
    } else {
      thinLines += v
      nThin++
    }
  }
  for (let k = 0; k < n; k++) {
    cellScore += windowMax(rows, rowAt(k + 0.5), radius)
    cellScore += windowMax(cols, colAt(k + 0.5), radius)
  }
  lineScore /= 2 * (n - 1)
  cellScore /= 2 * n
  // Every sudoku prints its box boundaries heavier than its cell rules
  // (halves for a 4x4, thirds for a 9x9, quarters for a 16x16). Under the
  // right hypothesis the box positions are at least as strong as the rest;
  // under a wrong one they tend to land on nothing. Rewarding that margin
  // separates the sizes far more reliably than line presence alone. The
  // bonus is capped by the thin-line strength: a 16x16 hypothesis on a 4x4
  // grid finds its box lines exactly on the 4x4's rules but no thin lines
  // at all, and must not be rewarded for that.
  const boxMean = nBox > 0 ? boxLines / (2 * nBox) : 0
  const thinMean = nThin > 0 ? thinLines / (2 * nThin) : 0
  const boxBonus = nBox > 0 && nThin > 0 ? Math.min(boxMean - thinMean, thinMean) : 0
  return lineScore - cellScore + BOX_WEIGHT * boxBonus
}

const BOX_WEIGHT = 0.5

function peakNear(profile: Float64Array, centre: number, radius: number): number {
  let bestIdx = Math.round(centre)
  let best = -1
  const lo = Math.max(0, Math.round(centre - radius))
  const hi = Math.min(profile.length - 1, Math.round(centre + radius))
  for (let i = lo; i <= hi; i++) {
    if (profile[i] > best) {
      best = profile[i]
      bestIdx = i
    }
  }
  // Centre-of-mass refinement over the peak neighbourhood for subpixel lines.
  let wSum = 0
  let xSum = 0
  for (let i = Math.max(lo, bestIdx - 2); i <= Math.min(hi, bestIdx + 2); i++) {
    wSum += profile[i]
    xSum += profile[i] * i
  }
  return wSum > 0 ? xSum / wSum : bestIdx
}

/**
 * Detect grid size (4/9/16) from a warped square grid image and relocalise
 * every grid line via profile peaks, absorbing mild paper curvature.
 * Returns null when no candidate stands out (caller should ask the user).
 */
export function detectGridSize(warped: GrayImage, minConfidence = 1.25): GridSizeResult | null {
  const r = detectRegular(warped, minConfidence)
  if (r === null || r.size !== 4) return r
  const sixteen = sixteenInDisguise(warped, r)
  if (sixteen) return sixteen
  // A 4x4's cells hold digits only. Rules running through them mean this is
  // a fragment of a finer grid (two boxes of a 9x9 framed by its box rules),
  // not a puzzle: better no answer than a confident wrong one.
  return hasInnerRules(warped, r) ? null : r
}

/** Rules crossing the interior of the cells (see spanProfiles). */
function hasInnerRules(warped: GrayImage, r: GridSizeResult): boolean {
  const window = Math.max(15, Math.round(warped.width / 24)) | 1
  const span = spanProfiles(warped, Math.max(3, Math.round(window / 9)))
  const inner = (profile: Float64Array, lines: number[]): number => {
    const peaks: number[] = []
    for (let i = 0; i + 1 < lines.length; i++) {
      const pad = (lines[i + 1] - lines[i]) * 0.18
      let best = 0
      for (let p = Math.ceil(lines[i] + pad); p <= lines[i + 1] - pad; p++) best = Math.max(best, profile[p] ?? 0)
      peaks.push(best)
    }
    peaks.sort((a, b) => a - b)
    return peaks[peaks.length >> 1]
  }
  return Math.max(inner(span.rows, r.rowLines), inner(span.cols, r.colLines)) > INNER_RULE_LEVEL
}

/** Mean glyph offset from 16x16 cell centres (uniform clutter: ~0.25). */
const LATTICE_OFFSET = 0.16

/** Span-profile level of a rule inside a cell (rules themselves reach ~1). */
const INNER_RULE_LEVEL = 0.45

/**
 * A 16x16 whose thin rules are too faint to register (a screen, a light
 * print) shows only its box rules - a perfect 4x4 lattice. A real 4x4 has
 * at most one large digit per cell, whereas these "cells" each hold several
 * small glyphs in a lattice of their own. When most non-empty cells do, the
 * grid is read as 16x16, each 4x4 cell split evenly between its rules.
 */
function sixteenInDisguise(warped: GrayImage, r: GridSizeResult): GridSizeResult | null {
  const dim = warped.width
  const mask = adaptiveThreshold(warped, Math.max(15, Math.round(dim / 24)) | 1, 8)
  const { components } = labelComponents(mask)
  const counts = new Array<number>(16).fill(0)
  const big = new Array<number>(16).fill(0)
  // How far small glyphs sit from the centres of the would-be 16x16 cells
  // (0 = centred, 0.5 = on a rule): a real 16x16 centres its glyphs, pencil
  // notes and other clutter land anywhere.
  let offSum = 0
  let offN = 0
  for (const c of components) {
    const h = c.y1 - c.y0 + 1
    const w = c.x1 - c.x0 + 1
    const cx = (c.x0 + c.x1) / 2
    const cy = (c.y0 + c.y1) / 2
    const col = r.colLines.findIndex((v, i) => i < 4 && cx >= v && cx < r.colLines[i + 1])
    const row = r.rowLines.findIndex((v, i) => i < 4 && cy >= v && cy < r.rowLines[i + 1])
    if (col < 0 || row < 0) continue
    const cellH = r.rowLines[row + 1] - r.rowLines[row]
    const cellW = r.colLines[col + 1] - r.colLines[col]
    // Rules and their fragments are long and thin; skip them.
    if (w > 0.6 * cellW || h > 0.6 * cellH || c.size < 6) {
      if (h > 0.35 * cellH && h < 0.8 * cellH && w < 0.6 * cellW) big[row * 4 + col]++
      continue
    }
    if (h >= 0.05 * cellH && h <= 0.25 * cellH && w <= 0.25 * cellW) {
      counts[row * 4 + col]++
      const fx = ((cx - r.colLines[col]) / cellW) * 4
      const fy = ((cy - r.rowLines[row]) / cellH) * 4
      offSum += Math.abs(fx - Math.floor(fx) - 0.5) + Math.abs(fy - Math.floor(fy) - 0.5)
      offN += 2
    }
  }
  let nonEmpty = 0
  let crowded = 0
  for (let i = 0; i < 16; i++) {
    if (counts[i] + big[i] === 0) continue
    nonEmpty++
    if (counts[i] >= 3 && big[i] === 0) crowded++
  }
  if (nonEmpty < 4 || crowded * 2 < nonEmpty || offN === 0 || offSum / offN > LATTICE_OFFSET) return null
  const split = (lines: number[]): number[] => {
    const out: number[] = []
    for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) out.push(lines[i] + ((lines[i + 1] - lines[i]) * k) / 4)
    out.push(lines[4])
    return out
  }
  return { size: 16, confidence: r.confidence, rowLines: split(r.rowLines), colLines: split(r.colLines), faint: true }
}

/** The best-supported size whose relocalised lines are regular. */
function detectRegular(warped: GrayImage, minConfidence: number): GridSizeResult | null {
  const primary = detectFromInk(warped, minConfidence)
  if (primary !== null && linesRegular(primary)) return primary
  // Faint rules (pale cell lines on a screen, a dark-mode board read in
  // negative): the ink profiles then peak on rows of digits, not on the
  // lines, and the spacing comes out irregular. Profiles that only count
  // a dip running across the whole grid ignore the digits.
  const window = Math.max(15, Math.round(warped.width / 24)) | 1
  const span = spanProfiles(warped, Math.max(3, Math.round(window / 9)))
  const fallback = sizeFromProfiles(span.rows, span.cols, warped.width, minConfidence, true)
  if (fallback !== null && linesRegular(fallback)) return { ...fallback, faint: true }
  return primary
}

function linesRegular(r: GridSizeResult): boolean {
  return Math.max(spacingIrregularity(r.rowLines), spacingIrregularity(r.colLines)) <= MAX_LINE_IRREGULARITY
}

/**
 * Row/column profiles of FAINT lines that span the grid: each row is cut
 * into segments, a valley's depth is averaged per segment, and the row
 * scores its lower-quartile segment. A rule dips in every segment, even a
 * few grey levels deep; a row of digits dips only where the digits are,
 * so it scores near zero however dark its strokes.
 */
export function spanProfiles(img: GrayImage, d: number, segments = 12): { rows: Float64Array; cols: Float64Array } {
  const { width: w, height: h, data } = img
  const cap = 20
  const rows = new Float64Array(h)
  const cols = new Float64Array(w)
  const seg = new Float64Array(segments)
  const q = Math.floor(segments / 4)
  const cuts = (len: number): number[] => Array.from({ length: segments + 1 }, (_, s) => Math.round((s * len) / segments))
  const bx = cuts(w)
  const by = cuts(h)
  for (let y = d; y < h - d; y++) {
    const up = (y - d) * w
    const mid = y * w
    const dn = (y + d) * w
    for (let s = 0; s < segments; s++) {
      let sum = 0
      for (let x = bx[s]; x < bx[s + 1]; x++) {
        const depth = Math.min(data[up + x], data[dn + x]) - data[mid + x]
        if (depth > 0) sum += Math.min(depth, cap)
      }
      seg[s] = sum / Math.max(1, bx[s + 1] - bx[s])
    }
    rows[y] = Float64Array.from(seg).sort()[q]
  }
  for (let x = d; x < w - d; x++) {
    for (let s = 0; s < segments; s++) {
      let sum = 0
      for (let y = by[s]; y < by[s + 1]; y++) {
        const r = y * w + x
        const depth = Math.min(data[r - d], data[r + d]) - data[r]
        if (depth > 0) sum += Math.min(depth, cap)
      }
      seg[s] = sum / Math.max(1, by[s + 1] - by[s])
    }
    cols[x] = Float64Array.from(seg).sort()[q]
  }
  const normalise = (p: Float64Array): void => {
    const sorted = Float64Array.from(p).sort()
    const top = sorted[Math.floor(0.99 * (sorted.length - 1))] || 1
    for (let i = 0; i < p.length; i++) p[i] = Math.min(1, p[i] / top)
  }
  normalise(rows)
  normalise(cols)
  return { rows, cols }
}

/** Size from ink profiles (thresholded, or soft when the print is faint). */
function detectFromInk(warped: GrayImage, minConfidence: number): GridSizeResult | null {
  const dim = warped.width
  const window = Math.max(15, Math.round(dim / 24)) | 1
  const candidates: GridSize[] = [4, 9, 16]

  let { rows, cols } = profiles(adaptiveThreshold(warped, window, 8))
  let scores = candidates.map((n) => scoreSize(rows, cols, n, dim))
  // Faint print, blur or low resolution can leave grid lines under the
  // binarisation offset, so the thresholded profile carries almost no line
  // signal. Fall back to a soft darkness profile (no threshold): a line row
  // is consistently a little darker than its surroundings across the whole
  // width, which sums to a clear peak even when no pixel clears the offset.
  if (Math.max(...scores) < SOFT_PROFILE_SCORE) {
    const soft = softProfiles(warped, window)
    const softScores = candidates.map((n) => scoreSize(soft.rows, soft.cols, n, dim))
    // A 4x4 is a large-print children's puzzle with bold rules; one that is
    // too faint for the binary profile does not occur, whereas a blurred 9x9
    // whose corners were misjudged readily masquerades as a 4x4 here. The
    // fallback may therefore only ever conclude 9 or 16.
    softScores[0] = -1
    if (Math.max(...softScores) > Math.max(...scores)) {
      rows = soft.rows
      cols = soft.cols
      scores = softScores
    }
  }

  return sizeFromProfiles(rows, cols, dim, minConfidence, false, scores)
}

/** Pick the size the profiles support and relocalise its lines. `noFour`
 * rules out a 4x4 (faint-profile fallbacks, see detectFromInk). */
function sizeFromProfiles(
  rows: Float64Array,
  cols: Float64Array,
  dim: number,
  minConfidence: number,
  noFour: boolean,
  given?: number[],
): GridSizeResult | null {
  const candidates: GridSize[] = [4, 9, 16]
  const scores = given ?? candidates.map((n) => scoreSize(rows, cols, n, dim))
  if (noFour) scores[0] = -1
  let bestIdx = 0
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bestIdx]) bestIdx = i
  const runnerUp = Math.max(...scores.filter((_, i) => i !== bestIdx), 1e-9)
  const best = scores[bestIdx]
  if (best <= 0) return null
  const confidence = best / Math.max(runnerUp, 1e-9)

  const size = candidates[bestIdx]
  // 9 vs 3-line aliasing guard: a 9x9's box lines also score as 4-ish grids;
  // rely on the ratio test for that, only reject clearly ambiguous results.
  if (confidence < minConfidence) return null

  const rowLines = relocaliseLines(rows, size, dim)
  const colLines = relocaliseLines(cols, size, dim)
  const cell = dim / size

  // Sanity: relocalised lines must stay strictly ordered; otherwise fall back
  // to uniform spacing.
  for (let i = 1; i < rowLines.length; i++) {
    if (rowLines[i] - rowLines[i - 1] < cell * 0.5) {
      return {
        size,
        confidence,
        rowLines: uniform(size, dim),
        colLines: uniform(size, dim),
      }
    }
  }
  for (let i = 1; i < colLines.length; i++) {
    if (colLines[i] - colLines[i - 1] < cell * 0.5) {
      return {
        size,
        confidence,
        rowLines: uniform(size, dim),
        colLines: uniform(size, dim),
      }
    }
  }
  return { size, confidence, rowLines, colLines }
}

/**
 * Relocalise all size+1 grid lines of one axis from its ink profile.
 *
 * The outer border is located too, not pinned to the warp edge: detected
 * quads are routinely a little loose (model corners are a few px rough, and
 * a caption or neighbouring rule can merge into the border contour), which
 * otherwise shifts every cell and lets the border stroke intrude into the
 * first row/column of crops. The border is accepted inside the edge only when
 * it is as strong as the interior lines; otherwise the edge stands.
 */
export function relocaliseLines(profile: Float64Array, size: number, dim: number): number[] {
  const cell = dim / size
  const radius = cell * 0.22
  // Interior line strength under the uniform assumption sets the bar an
  // outer peak must clear, so stray text in a loose margin cannot pass.
  const strengths: number[] = []
  for (let k = 1; k < size; k++) strengths.push(windowMax(profile, k * cell, radius))
  strengths.sort((a, b) => a - b)
  const reference = strengths[strengths.length >> 1] ?? 0

  const first = outerLine(profile, 0, cell, dim, reference)
  const last = outerLine(profile, 1, cell, dim, reference)
  const span = last - first
  const lines: number[] = [first]
  for (let k = 1; k < size; k++) lines.push(peakNear(profile, first + (k * span) / size, radius))
  lines.push(last)
  snapOutliers(lines, span / size)
  return lines
}

/**
 * A faint or broken grid line can lose its peak to a nearby digit stroke,
 * which drags one line off by a fraction of a cell. Such a line stands out
 * against its two neighbours (large second difference) while a genuinely
 * skewed warp changes spacing smoothly, so replacing only isolated outliers
 * with their neighbours' midpoint fixes the miss without hiding real skew.
 */
function snapOutliers(lines: number[], cell: number): void {
  for (let pass = 0; pass < 2; pass++) {
    let worst = -1
    let worstDev = 0.1 * cell
    for (let k = 1; k < lines.length - 1; k++) {
      const dev = Math.abs(lines[k] - (lines[k - 1] + lines[k + 1]) / 2)
      if (dev > worstDev) {
        worstDev = dev
        worst = k
      }
    }
    if (worst === -1) return
    lines[worst] = (lines[worst - 1] + lines[worst + 1]) / 2
  }
}

/** The grid's outer border positions along one axis for a hypothesis of n
 * cells: the edges of the warp unless a line as strong as the interior
 * ones sits a little inside them. */
export function outerSpan(profile: Float64Array, n: number, dim: number): [number, number] {
  const cell = dim / n
  const radius = cell * 0.22
  const strengths: number[] = []
  for (let k = 1; k < n; k++) strengths.push(windowMax(profile, k * cell, radius))
  strengths.sort((a, b) => a - b)
  const reference = strengths[strengths.length >> 1] ?? 0
  return [outerLine(profile, 0, cell, dim, reference), outerLine(profile, 1, cell, dim, reference)]
}

function outerLine(profile: Float64Array, edge: 0 | 1, cell: number, dim: number, reference: number): number {
  const range = cell * 0.45
  const lo = edge === 0 ? 0 : Math.max(0, dim - 1 - range)
  const hi = edge === 0 ? Math.min(dim - 1, range) : dim - 1
  let bestIdx = -1
  let best = 0
  for (let i = Math.round(lo); i <= Math.round(hi); i++) {
    if (profile[i] > best) {
      best = profile[i]
      bestIdx = i
    }
  }
  if (bestIdx === -1 || best < 0.5 * reference) return edge === 0 ? 0 : dim
  return peakNear(profile, bestIdx, 2)
}

/**
 * Ink profiles restricted to the edge bands of a warped grid: rows measured
 * over the left and right `band` columns, columns over the top and bottom
 * `band` rows. On a true-to-square warp the two row profiles put every line
 * at the same y; residual perspective or page curl makes them disagree.
 */
export function edgeProfiles(
  warped: GrayImage,
  band: number,
): { rowsLeft: Float64Array; rowsRight: Float64Array; colsTop: Float64Array; colsBottom: Float64Array } {
  const dim = warped.width
  const mask = adaptiveThreshold(warped, Math.max(15, Math.round(dim / 24)) | 1, 8)
  const { data } = mask
  const rowsLeft = new Float64Array(dim)
  const rowsRight = new Float64Array(dim)
  const colsTop = new Float64Array(dim)
  const colsBottom = new Float64Array(dim)
  for (let y = 0; y < dim; y++) {
    const row = y * dim
    for (let x = 0; x < band; x++) if (data[row + x]) rowsLeft[y]++
    for (let x = dim - band; x < dim; x++) if (data[row + x]) rowsRight[y]++
  }
  for (let x = 0; x < dim; x++) {
    for (let y = 0; y < band; y++) if (data[y * dim + x]) colsTop[x]++
    for (let y = dim - band; y < dim; y++) if (data[y * dim + x]) colsBottom[x]++
  }
  for (let i = 0; i < dim; i++) {
    rowsLeft[i] /= band
    rowsRight[i] /= band
    colsTop[i] /= band
    colsBottom[i] /= band
  }
  return { rowsLeft, rowsRight, colsTop, colsBottom }
}

/**
 * How strongly the grid lines register in a warp: mean binary-profile peak
 * at the relocalised interior lines. A warp whose corners are right has
 * crisp, full-width lines; a skewed one smears them. Used to judge whether
 * a re-warp improved the geometry.
 */
export function gridLineStrength(warped: GrayImage, rowLines: number[], colLines: number[]): number {
  const dim = warped.width
  const mask = adaptiveThreshold(warped, Math.max(15, Math.round(dim / 24)) | 1, 8)
  const { rows, cols } = profiles(mask)
  const n = rowLines.length - 1
  let total = 0
  for (let k = 1; k < n; k++) total += windowMax(rows, rowLines[k], 2) + windowMax(cols, colLines[k], 2)
  return total / (2 * (n - 1))
}

/** Per-cell grid lines that follow page curl (see localLines). */
export interface LocalLines {
  /** rowsByCol[c] = the size+1 row-line positions measured around column c. */
  rowsByCol: number[][]
  /** colsByRow[r] = the size+1 column-line positions measured around row r. */
  colsByRow: number[][]
}

/**
 * Grid lines measured locally: the row lines are relocalised separately
 * for each cell column from a band about three cells wide around it, and
 * the column lines for each cell row likewise. A single homography leaves
 * the lines of a curled or crumpled page bowed across the warp, so the
 * outer cells drift off their global lines; local lines follow the bow.
 * A local line that strays far from the global fit is noise (a digit
 * stroke in a sparse band) and falls back to the global position.
 */
/**
 * How far (in cells) a locally measured line may sit from the global one
 * before it is distrusted. Page curl moves a line by a few percent of a
 * cell; a band whose faint rules lose their peaks to pencil strokes puts
 * lines a third of a cell off, and those must fall back to the global line
 * or the crops cut the digits.
 */
const LOCAL_LINE_LIMIT = 0.35

/** Plain ink-count profile of a band. */
function bandProfile(data: Uint8Array, dim: number, lo: number, hi: number, alongRows: boolean): Float64Array {
  const prof = new Float64Array(dim)
  const span = Math.max(1, hi - lo)
  for (let p = 0; p < dim; p++) {
    let count = 0
    for (let q = lo; q < hi; q++) if (data[alongRows ? p * dim + q : q * dim + p]) count++
    prof[p] = count / span
  }
  return prof
}

export function localLines(warped: GrayImage, rowLines: number[], colLines: number[]): LocalLines {
  const dim = warped.width
  const n = rowLines.length - 1
  const cell = dim / n
  const mask = adaptiveThreshold(warped, Math.max(15, Math.round(dim / 24)) | 1, 8)
  const { data } = mask
  const limit = LOCAL_LINE_LIMIT * cell
  const clampTo = (lines: number[], global: number[]): number[] =>
    lines.map((v, k) => (Math.abs(v - global[k]) > limit ? global[k] : v))

  const rowsByCol: number[][] = []
  for (let c = 0; c < n; c++) {
    const x0 = Math.max(0, Math.round(colLines[Math.max(0, c - 1)]))
    const x1 = Math.min(dim, Math.round(colLines[Math.min(n, c + 2)]))
    rowsByCol.push(clampTo(relocaliseLines(bandProfile(data, dim, x0, x1, true), n, dim), rowLines))
  }
  const colsByRow: number[][] = []
  for (let r = 0; r < n; r++) {
    const y0 = Math.max(0, Math.round(rowLines[Math.max(0, r - 1)]))
    const y1 = Math.min(dim, Math.round(rowLines[Math.min(n, r + 2)]))
    colsByRow.push(clampTo(relocaliseLines(bandProfile(data, dim, y0, y1, false), n, dim), colLines))
  }
  return { rowsByCol, colsByRow }
}

export function uniform(size: number, dim: number): number[] {
  const lines: number[] = []
  for (let k = 0; k <= size; k++) lines.push((k * dim) / size)
  return lines
}

/** Reject grids whose implied lines are unevenly spaced (misplaced corner).
 * Real grids measure 0.01-0.19, skewed quads 0.20+ (see verification_bank). */
export const MAX_LINE_IRREGULARITY = 0.19

export function spacingIrregularity(lines: number[]): number {
  if (lines.length < 2) return Infinity
  const gaps: number[] = []
  let total = 0
  for (let i = 1; i < lines.length; i++) {
    gaps.push(lines[i] - lines[i - 1])
    total += lines[i] - lines[i - 1]
  }
  const mean = total / gaps.length
  if (mean <= 0) return Infinity
  let worst = 0
  for (const gap of gaps) worst = Math.max(worst, Math.abs(gap - mean))
  return worst / mean
}
