import { getTables, type Grid, type GridSize } from '../../src/lib/solver/board'

/** Easy 9x9 (NYT-style difficulty). */
export const EASY_9 =
  '53..7....' +
  '6..195...' +
  '.98....6.' +
  '8...6...3' +
  '4..8.3..1' +
  '7...2...6' +
  '.6....28.' +
  '...419..5' +
  '....8..79'

/** Arto Inkala's "world's hardest sudoku" (requires deep search). */
export const HARD_9 =
  '8........' +
  '..36.....' +
  '.7..9.2..' +
  '.5...7...' +
  '....457..' +
  '...1...3.' +
  '..1....68' +
  '..85...1.' +
  '.9....4..'

/** 17-clue puzzle (minimal known clue count). */
export const MINIMAL_17 =
  '.......1.' +
  '4........' +
  '.2.......' +
  '....5.4.7' +
  '..8...3..' +
  '..1.9....' +
  '3..4..2..' +
  '.5.1.....' +
  '...8.6...'

/** No duplicate givens, but cell (0,8) has no candidates: row has 1-8, box has 9. */
export const UNSOLVABLE_9 =
  '12345678.' +
  '.......9.' +
  '.........' +
  '.........' +
  '.........' +
  '.........' +
  '.........' +
  '.........' +
  '.........'

/** Row 0 contains two 5s. */
export const DUPLICATE_9 =
  '5....5...' +
  '.........' +
  '.........' +
  '.........' +
  '.........' +
  '.........' +
  '.........' +
  '.........' +
  '.........'

export const EASY_4 = '1..4' + '..1.' + '.4..' + '2..3'

/** Deterministic PRNG so fixtures are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A complete valid grid via the standard shift construction, then shuffled by
 * relabelling values and permuting rows/cols within bands (validity-preserving).
 */
export function generateSolvedGrid(size: GridSize, seed: number): Grid {
  const t = getTables(size)
  const bs = t.boxSize
  const rand = mulberry32(seed)
  const grid = new Uint8Array(t.numCells)
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      grid[r * size + c] = ((bs * (r % bs) + Math.floor(r / bs) + c) % size) + 1

  const relabel = shuffled([...Array(size).keys()], rand)
  for (let i = 0; i < grid.length; i++) grid[i] = relabel[grid[i] - 1] + 1

  const rowOrder = bandPermutation(size, bs, rand)
  const colOrder = bandPermutation(size, bs, rand)
  const out = new Uint8Array(t.numCells)
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) out[r * size + c] = grid[rowOrder[r] * size + colOrder[c]]
  return out
}

/** Blank out cells from a solved grid to produce a puzzle. */
export function punchHoles(solved: Grid, fractionEmpty: number, seed: number): Grid {
  const rand = mulberry32(seed)
  const puzzle = solved.slice()
  for (let i = 0; i < puzzle.length; i++) if (rand() < fractionEmpty) puzzle[i] = 0
  return puzzle
}

function shuffled<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function bandPermutation(size: number, bs: number, rand: () => number): number[] {
  const bands = shuffled([...Array(bs).keys()], rand)
  const order: number[] = []
  for (const band of bands)
    for (const inner of shuffled([...Array(bs).keys()], rand)) order.push(band * bs + inner)
  return order
}
