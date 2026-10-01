import { describe, expect, it } from 'vitest'
import { gridFromString, gridToString } from '../../src/lib/solver/board'
import { countSolutions, solve, solveOrder } from '../../src/lib/solver/solve'
import { findConflicts, isValidSolution } from '../../src/lib/solver/validate'
import {
  DUPLICATE_9,
  EASY_4,
  EASY_9,
  HARD_9,
  MINIMAL_17,
  UNSOLVABLE_9,
  generateSolvedGrid,
  punchHoles,
} from './fixtures'

describe('solve 9x9', () => {
  it('solves an easy puzzle', () => {
    const grid = gridFromString(9, EASY_9)
    const r = solve(grid, 9)
    expect(r.status).toBe('solved')
    expect(isValidSolution(grid, r.solution!, 9)).toBe(true)
  })

  it('solves the hardest known puzzle', () => {
    const grid = gridFromString(9, HARD_9)
    const start = performance.now()
    const r = solve(grid, 9)
    const ms = performance.now() - start
    expect(r.status).toBe('solved')
    expect(isValidSolution(grid, r.solution!, 9)).toBe(true)
    expect(ms).toBeLessThan(50)
  })

  it('solves a 17-clue puzzle', () => {
    const grid = gridFromString(9, MINIMAL_17)
    const r = solve(grid, 9)
    expect(r.status).toBe('solved')
    expect(isValidSolution(grid, r.solution!, 9)).toBe(true)
  })

  it('reports unsolvable for a contradictory puzzle', () => {
    const r = solve(gridFromString(9, UNSOLVABLE_9), 9)
    expect(r.status).toBe('unsolvable')
  })

  it('reports unsolvable for duplicate givens', () => {
    const r = solve(gridFromString(9, DUPLICATE_9), 9)
    expect(r.status).toBe('unsolvable')
  })

  it('respects the node budget', () => {
    const empty = new Uint8Array(81)
    const r = solve(empty, 9, { maxNodes: 1 })
    expect(r.status).toBe('budget-exceeded')
  })
})

describe('solve other sizes', () => {
  it('solves 4x4', () => {
    const grid = gridFromString(4, EASY_4)
    const r = solve(grid, 4)
    expect(r.status).toBe('solved')
    expect(isValidSolution(grid, r.solution!, 4)).toBe(true)
  })

  it('solves 16x16 puzzles quickly', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const solved = generateSolvedGrid(16, seed)
      const puzzle = punchHoles(solved, 0.55, seed + 100)
      const start = performance.now()
      const r = solve(puzzle, 16)
      const ms = performance.now() - start
      expect(r.status).toBe('solved')
      expect(isValidSolution(puzzle, r.solution!, 16)).toBe(true)
      expect(ms).toBeLessThan(250)
    }
  })
})

describe('countSolutions', () => {
  it('finds exactly one for a proper puzzle', () => {
    const r = countSolutions(gridFromString(9, EASY_9), 9)
    expect(r.count).toBe(1)
  })

  it('finds multiple for an underdetermined grid', () => {
    const r = countSolutions(new Uint8Array(81), 9)
    expect(r.count).toBe(2)
  })

  it('finds zero for an unsolvable grid', () => {
    const r = countSolutions(gridFromString(9, UNSOLVABLE_9), 9)
    expect(r.count).toBe(0)
  })
})

describe('solveOrder', () => {
  it('covers every initially-empty cell exactly once, in a valid order', () => {
    const grid = gridFromString(9, HARD_9)
    const r = solve(grid, 9)
    const order = solveOrder(grid, r.solution!, 9)

    const emptyCells = new Set<number>()
    for (let c = 0; c < 81; c++) if (grid[c] === 0) emptyCells.add(c)
    expect(order.length).toBe(emptyCells.size)

    const filled = grid.slice()
    for (const p of order) {
      expect(emptyCells.has(p.cell)).toBe(true)
      expect(filled[p.cell]).toBe(0)
      expect(p.value).toBe(r.solution![p.cell])
      filled[p.cell] = p.value
    }
    expect(gridToString(9, filled)).toBe(gridToString(9, r.solution!))
  })

  it('uses only singles on an easy puzzle', () => {
    const grid = gridFromString(9, EASY_9)
    const r = solve(grid, 9)
    const order = solveOrder(grid, r.solution!, 9)
    expect(order.every((p) => p.kind === 'single')).toBe(true)
  })
})

describe('findConflicts', () => {
  it('flags both cells of a duplicate pair', () => {
    const conflicts = findConflicts(gridFromString(9, DUPLICATE_9), 9)
    expect(conflicts).toEqual(new Set([0, 5]))
  })

  it('is empty for valid givens', () => {
    expect(findConflicts(gridFromString(9, EASY_9), 9).size).toBe(0)
  })
})
