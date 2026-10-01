import { getTables, lowestValue, popcount, type Grid, type GridSize, type Tables } from './board'

export interface SolveOptions {
  /** Abort search after this many nodes. */
  maxNodes?: number
}

export interface SolveResult {
  status: 'solved' | 'unsolvable' | 'budget-exceeded'
  solution: Grid | null
  nodes: number
}

const DEFAULT_MAX_NODES = 2_000_000

interface State {
  grid: Grid
  cands: Uint32Array
}

/** Build candidate masks from a grid. Returns null on immediate contradiction. */
function initState(grid: Grid, t: Tables): State | null {
  const cands = new Uint32Array(t.numCells).fill(t.allMask)
  for (let c = 0; c < t.numCells; c++) {
    if (grid[c] !== 0) cands[c] = 1 << (grid[c] - 1)
  }
  for (let c = 0; c < t.numCells; c++) {
    if (grid[c] === 0) continue
    const bit = 1 << (grid[c] - 1)
    for (const p of t.peers[c]) {
      if (grid[p] !== 0) {
        if (p > c && grid[p] === grid[c]) return null // duplicate in unit
        continue
      }
      cands[p] &= ~bit
      if (cands[p] === 0) return null
    }
  }
  return { grid: grid.slice(), cands }
}

/**
 * Assign value to cell and eliminate it from peers, cascading naked singles.
 * Returns false on contradiction.
 */
function assign(s: State, t: Tables, cell: number, value: number): boolean {
  const stack: number[] = [cell]
  s.grid[cell] = value
  s.cands[cell] = 1 << (value - 1)

  while (stack.length > 0) {
    const c = stack.pop()!
    const bit = s.cands[c]
    for (const p of t.peers[c]) {
      if ((s.cands[p] & bit) === 0) continue
      if (s.grid[p] !== 0) return false // peer already fixed to this value
      const next = s.cands[p] & ~bit
      if (next === 0) return false
      s.cands[p] = next
      if ((next & (next - 1)) === 0) {
        s.grid[p] = lowestValue(next)
        stack.push(p)
      }
    }
  }
  return true
}

/** Apply hidden singles until fixpoint. Returns false on contradiction. */
function propagate(s: State, t: Tables): boolean {
  let changed = true
  while (changed) {
    changed = false
    for (const unit of t.units) {
      // For each value, find where it can go in this unit.
      let placed = 0
      for (const c of unit) if (s.grid[c] !== 0) placed |= s.cands[c]
      let missing = t.allMask & ~placed
      while (missing !== 0) {
        const bit = missing & -missing
        missing &= missing - 1
        let spot = -1
        let count = 0
        let nowPlaced = false
        for (const c of unit) {
          if ((s.cands[c] & bit) === 0) continue
          if (s.grid[c] !== 0) {
            // An earlier assign cascade placed this value here; no longer missing.
            nowPlaced = true
            break
          }
          spot = c
          if (++count > 1) break
        }
        if (nowPlaced) continue
        if (count === 0) return false
        if (count === 1) {
          if (!assign(s, t, spot, lowestValue(bit))) return false
          changed = true
        }
      }
    }
  }
  return true
}

/** Find the empty cell with fewest candidates, or -1 if the grid is full. */
function findMrvCell(s: State, t: Tables): number {
  let best = -1
  let bestCount = 33
  for (let c = 0; c < t.numCells; c++) {
    if (s.grid[c] !== 0) continue
    const n = popcount(s.cands[c])
    if (n < bestCount) {
      best = c
      bestCount = n
      if (n === 2) break // can't do better: 1s are auto-assigned
    }
  }
  return best
}

interface SearchCtx {
  t: Tables
  nodes: number
  maxNodes: number
  /** Solutions found so far (for counting); search stops at `limit`. */
  found: Grid[]
  limit: number
  reverseValues: boolean
}

function search(s: State, ctx: SearchCtx): 'done' | 'budget' | 'exhausted' {
  if (++ctx.nodes > ctx.maxNodes) return 'budget'
  if (!propagate(s, ctx.t)) return 'exhausted'

  const cell = findMrvCell(s, ctx.t)
  if (cell === -1) {
    ctx.found.push(s.grid.slice())
    return ctx.found.length >= ctx.limit ? 'done' : 'exhausted'
  }

  let mask = s.cands[cell]
  const values: number[] = []
  while (mask !== 0) {
    values.push(lowestValue(mask))
    mask &= mask - 1
  }
  if (ctx.reverseValues) values.reverse()

  for (const v of values) {
    const child: State = { grid: s.grid.slice(), cands: s.cands.slice() }
    if (!assign(child, ctx.t, cell, v)) continue
    const r = search(child, ctx)
    if (r !== 'exhausted') return r
  }
  return 'exhausted'
}

export function solve(grid: Grid, size: GridSize, opts: SolveOptions = {}): SolveResult {
  const t = getTables(size)
  const s = initState(grid, t)
  if (s === null) return { status: 'unsolvable', solution: null, nodes: 0 }

  const ctx: SearchCtx = {
    t,
    nodes: 0,
    maxNodes: opts.maxNodes ?? DEFAULT_MAX_NODES,
    found: [],
    limit: 1,
    reverseValues: false,
  }
  const r = search(s, ctx)
  if (r === 'budget') return { status: 'budget-exceeded', solution: null, nodes: ctx.nodes }
  if (ctx.found.length === 0) return { status: 'unsolvable', solution: null, nodes: ctx.nodes }
  return { status: 'solved', solution: ctx.found[0], nodes: ctx.nodes }
}

export interface CountResult {
  /** Number of solutions found, capped at `limit`. */
  count: number
  exhausted: boolean
  nodes: number
}

/** Count solutions up to `limit` (default 2, for uniqueness checks). */
export function countSolutions(
  grid: Grid,
  size: GridSize,
  limit = 2,
  opts: SolveOptions = {},
): CountResult {
  const t = getTables(size)
  const s = initState(grid, t)
  if (s === null) return { count: 0, exhausted: true, nodes: 0 }

  const ctx: SearchCtx = {
    t,
    nodes: 0,
    maxNodes: opts.maxNodes ?? DEFAULT_MAX_NODES,
    found: [],
    limit,
    // Reversed value order escapes the first solution's basin faster when
    // hunting for a second solution.
    reverseValues: limit > 1,
  }
  const r = search(s, ctx)
  return { count: ctx.found.length, exhausted: r !== 'budget', nodes: ctx.nodes }
}

export interface Placement {
  cell: number
  value: number
  /** 'single' = forced by constraints, 'guess' = required search. */
  kind: 'single' | 'guess'
}

/**
 * Replay a solve of `grid` toward the known `solution`, producing the order in
 * which cells become determined. Used to drive the solve animation.
 */
export function solveOrder(grid: Grid, solution: Grid, size: GridSize): Placement[] {
  const t = getTables(size)
  const placements: Placement[] = []
  const s = initState(grid, t)
  if (s === null) return placements

  const known = new Uint8Array(grid)

  const recordNew = (kind: 'single' | 'guess', guessCell = -1) => {
    for (let c = 0; c < t.numCells; c++) {
      if (known[c] === 0 && s.grid[c] !== 0) {
        known[c] = s.grid[c]
        placements.push({ cell: c, value: s.grid[c], kind: c === guessCell ? 'guess' : kind })
      }
    }
  }

  for (;;) {
    if (!propagate(s, t)) return placements
    recordNew('single')
    const cell = findMrvCell(s, t)
    if (cell === -1) return placements
    if (!assign(s, t, cell, solution[cell])) return placements
    recordNew('single', cell)
  }
}
