import type { GridSize } from '../solver/board'
import { countSolutions, solve } from '../solver/solve'
import { findConflicts } from '../solver/validate'

/** A cell's recognised solver value plus its best alternative, for repair. */
export interface CellReading {
  /** Solver value 1..size, or 0 for empty. */
  value: number
  confidence: number
  altValue: number
  altConfidence: number
}

/** Cells below this confidence are highlighted for review. */
export const LOW_CONFIDENCE = 0.9
/** Max low-confidence cells considered by the repair search. */
const MAX_REPAIR_CELLS = 8
/** Max cells changed together in one repair (larger = combinatorial). */
const MAX_REPAIR_SIZE = 4
/** Cap on full solver runs during repair (16x16 solves are not free). */
const MAX_SOLVE_ATTEMPTS = 200
/** Wall-clock cap on the whole repair search. A misread grid can make every
 * candidate expensive to disprove; without a clock this ran for minutes on
 * a phone (the scan looked frozen). An unrepaired grid goes to review. */
const REPAIR_BUDGET_MS = 700
/** Solver effort per candidate: a correct repair of a real puzzle resolves
 * in a few thousand nodes, so anything needing more is not the answer. */
const ATTEMPT_MAX_NODES = 40_000
/** A digit demoted below the reading bar with at least this probability is
 * a candidate for restoring a missing given. */
const MAYBE_MIN = 0.2
/** At most this many missing givens restored together. */
const MAX_RESTORE = 3
/** A demoted digit at least this likely is restored when the puzzle's own
 * solution puts that digit in its cell. */
const AGREE_MIN = 0.4

export type CellFlag = 'ok' | 'low' | 'repaired'

export interface RepairResult {
  values: number[]
  flags: CellFlag[]
  /** True if the (possibly repaired) grid has at least one solution. */
  solvable: boolean
  /** True if it has exactly one: a reading that leaves several solutions
   * is usually missing digits, so it is not solved without a look. */
  unique: boolean
  /** True when a repair was applied. */
  repaired: boolean
}

function gridStatus(values: number[], size: GridSize): 'unique' | 'multiple' | 'invalid' {
  const grid = Uint8Array.from(values)
  if (findConflicts(grid, size).size > 0) return 'invalid'
  const count = countSolutions(grid, size, 2, { maxNodes: 200_000 })
  if (count.count === 0) return 'invalid'
  return count.count > 1 ? 'multiple' : 'unique'
}

/**
 * Constraint-driven repair: if the recognised grid is invalid or unsolvable,
 * search alternative readings of the least-confident cells for a minimal set
 * of flips that yields a uniquely solvable grid. Never guesses beyond the
 * search cap - unresolved grids are surfaced for manual review instead.
 */
export function repairGrid(readings: CellReading[], size: GridSize): RepairResult {
  const values = readings.map((r) => r.value)
  const flags: CellFlag[] = readings.map((r) => (r.confidence < LOW_CONFIDENCE ? 'low' : 'ok'))

  const initial = gridStatus(values, size)
  if (initial === 'unique') {
    return confirmMissing(readings, values, flags, size) ?? { values, flags, solvable: true, unique: true, repaired: false }
  }
  if (initial === 'multiple') {
    return restoreMissing(readings, values, flags, size) ?? { values, flags, solvable: true, unique: false, repaired: false }
  }

  // Candidate cells: conflicts and low-confidence reads. Each can change to
  // its alternative digit (if any) OR to empty - blanking covers a confident
  // hallucination in a noise cell, which has no digit alternative to swap to.
  const conflictCells = findConflicts(Uint8Array.from(values), size)
  const candidates = readings
    .map((r, i) => ({ i, r }))
    .filter(({ i, r }) => conflictCells.has(i) || r.confidence < LOW_CONFIDENCE)
    .map(({ i, r }) => {
      const options: number[] = []
      if (r.altConfidence > 0.005 && r.altValue !== values[i]) options.push(r.altValue)
      if (values[i] !== 0) options.push(0) // blank a filled uncertain/conflicting cell
      return { i, r, options }
    })
    .filter((c) => c.options.length > 0)
    .sort((a, b) => {
      const ca = conflictCells.has(a.i) ? 0 : 1
      const cb = conflictCells.has(b.i) ? 0 : 1
      if (ca !== cb) return ca - cb
      return a.r.confidence - b.r.confidence
    })
    .slice(0, MAX_REPAIR_CELLS)

  if (candidates.length === 0) {
    return { values, flags, solvable: false, unique: false, repaired: false }
  }

  const accept = (grid: Uint8Array): boolean => {
    if (findConflicts(grid, size).size > 0) return false
    // Require uniqueness: a repair that leaves several solutions is a guess.
    const r = countSolutions(grid, size, 2, { maxNodes: ATTEMPT_MAX_NODES })
    return r.count === 1 && r.exhausted
  }
  const deadline = performance.now() + REPAIR_BUDGET_MS
  const outOfBudget = (): boolean => attempts >= MAX_SOLVE_ATTEMPTS || performance.now() > deadline

  // Try changing the fewest cells first (1, then 2, ...); single-cell repairs
  // cover the overwhelming majority (one bad read), larger sets are the tail.
  // Bounded by MAX_SOLVE_ATTEMPTS.
  let attempts = 0
  const trySet = (cellIdxs: number[]): number[] | null => {
    // Cartesian product of the chosen cells' options.
    let product: number[][] = [[]]
    for (const ci of cellIdxs) {
      const next: number[][] = []
      for (const partial of product) {
        for (const opt of candidates[ci].options) next.push([...partial, opt])
      }
      product = next
    }
    for (const combo of product) {
      if (outOfBudget()) return null
      attempts++
      const trial = values.slice()
      cellIdxs.forEach((ci, j) => (trial[candidates[ci].i] = combo[j]))
      if (accept(Uint8Array.from(trial))) {
        cellIdxs.forEach((ci) => (flags[candidates[ci].i] = 'repaired'))
        return trial
      }
    }
    return null
  }

  const maxSize = Math.min(MAX_REPAIR_SIZE, candidates.length)
  for (let size = 1; size <= maxSize && !outOfBudget(); size++) {
    const combos = combinations(candidates.length, size)
    for (const cellIdxs of combos) {
      if (outOfBudget()) break
      const fixed = trySet(cellIdxs)
      if (fixed) return { values: fixed, flags, solvable: true, unique: true, repaired: true }
    }
  }

  return { values, flags, solvable: false, unique: false, repaired: false }
}

/**
 * A reading that solves uniquely can still have dropped a given (a clue the
 * puzzle did not strictly need): a digit the classifier leaned towards but
 * could not assert. Where the solution puts that same digit in that cell, it
 * was printed there - a stray mark would have to match the solution by
 * chance - so it is restored as a given.
 */
function confirmMissing(readings: CellReading[], values: number[], flags: CellFlag[], size: GridSize): RepairResult | null {
  const maybe = readings
    .map((r, i) => ({ i, r }))
    .filter(({ i, r }) => values[i] === 0 && r.altValue !== 0 && r.altConfidence >= AGREE_MIN)
  if (maybe.length === 0) return null
  const { solution } = solve(Uint8Array.from(values), size, { maxNodes: 200_000 })
  if (!solution) return null
  const restored = values.slice()
  let n = 0
  for (const { i, r } of maybe) {
    if (solution[i] !== r.altValue) continue
    restored[i] = r.altValue
    flags[i] = 'repaired'
    n++
  }
  return n > 0 ? { values: restored, flags, solvable: true, unique: true, repaired: true } : null
}

/**
 * A reading with several solutions is usually missing a given that the
 * classifier saw but could not assert (its digit fell under the reading bar;
 * it is kept as the cell's alternative). Restore the fewest such digits that
 * make the solution unique - and only when exactly one choice of that size
 * does, so the puzzle's own logic, not a guess, decides.
 */
function restoreMissing(readings: CellReading[], values: number[], flags: CellFlag[], size: GridSize): RepairResult | null {
  const maybe = readings
    .map((r, i) => ({ i, r }))
    .filter(({ i, r }) => values[i] === 0 && r.altValue !== 0 && r.altConfidence >= MAYBE_MIN)
    .sort((a, b) => b.r.altConfidence - a.r.altConfidence)
    .slice(0, MAX_REPAIR_CELLS)
  if (maybe.length === 0) return null
  const deadline = performance.now() + REPAIR_BUDGET_MS
  let attempts = 0
  for (let k = 1; k <= Math.min(MAX_RESTORE, maybe.length); k++) {
    let found: { trial: number[]; cells: number[] } | null = null
    for (const cellIdxs of combinations(maybe.length, k)) {
      if (attempts >= MAX_SOLVE_ATTEMPTS || performance.now() > deadline) return null
      attempts++
      const trial = values.slice()
      for (const c of cellIdxs) trial[maybe[c].i] = maybe[c].r.altValue
      const grid = Uint8Array.from(trial)
      if (findConflicts(grid, size).size > 0) continue
      const r = countSolutions(grid, size, 2, { maxNodes: ATTEMPT_MAX_NODES })
      if (r.count !== 1 || !r.exhausted) continue
      if (found) return null // two different restorations work: not decided
      found = { trial, cells: cellIdxs.map((c) => maybe[c].i) }
    }
    if (found) {
      for (const i of found.cells) flags[i] = 'repaired'
      return { values: found.trial, flags, solvable: true, unique: true, repaired: true }
    }
  }
  return null
}

/** All size-k index subsets of [0, n), lexicographic. */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = []
  const idx = Array.from({ length: k }, (_, i) => i)
  if (k > n) return out
  for (;;) {
    out.push(idx.slice())
    let p = k - 1
    while (p >= 0 && idx[p] === n - k + p) p--
    if (p < 0) break
    idx[p]++
    for (let q = p + 1; q < k; q++) idx[q] = idx[q - 1] + 1
  }
  return out
}
