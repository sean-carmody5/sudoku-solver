import { describe, expect, it } from 'vitest'
import { gridFromString } from '../../src/lib/solver/board'
import { countSolutions, solve } from '../../src/lib/solver/solve'
import type { CellReading } from '../../src/lib/ocr/repair'
import { repairGrid } from '../../src/lib/ocr/repair'
import { EASY_9, mulberry32 } from '../solver/fixtures'

function cleanReadings(values: ArrayLike<number>): CellReading[] {
  return Array.from(values, (v) => ({
    value: v,
    confidence: 0.99,
    altValue: 0,
    altConfidence: 0.005,
  }))
}

const puzzle = gridFromString(9, EASY_9)
const solved = solve(puzzle, 9).solution!

describe('repairGrid', () => {
  it('passes a clean correct grid through untouched', () => {
    const result = repairGrid(cleanReadings(puzzle), 9)
    expect(result.solvable).toBe(true)
    expect(result.repaired).toBe(false)
    expect(result.values).toEqual(Array.from(puzzle))
    expect(result.flags.every((f) => f === 'ok')).toBe(true)
  })

  it.each([1, 2, 3])('recovers %i corrupted low-confidence cells', (k) => {
    const rand = mulberry32(k * 17)
    const readings = cleanReadings(puzzle)
    const givens = readings.map((r, i) => ({ r, i })).filter(({ r }) => r.value !== 0)
    for (let c = 0; c < k; c++) {
      const { r, i } = givens[Math.floor(rand() * givens.length)]
      const truth = puzzle[i]
      // Plausible confusion: misread as a different digit, truth as runner-up.
      r.value = (truth % 9) + 1
      r.confidence = 0.6
      r.altValue = truth
      r.altConfidence = 0.35
      void c
    }
    const result = repairGrid(readings, 9)
    expect(result.solvable).toBe(true)
    expect(result.values).toEqual(Array.from(puzzle))
  })

  it('does not silently guess when corruption exceeds the search cap', () => {
    const readings = cleanReadings(puzzle)
    const givens = readings.map((r, i) => ({ r, i })).filter(({ r }) => r.value !== 0)
    // Corrupt 12 cells with NO useful alternative - unrecoverable.
    for (let c = 0; c < 12; c++) {
      const { r, i } = givens[c * 2]
      r.value = (puzzle[i] % 9) + 1
      r.confidence = 0.6
      r.altValue = (puzzle[i] % 9) + 1 === 9 ? 1 : ((puzzle[i] % 9) + 2) % 10 || 1
      r.altConfidence = 0.3
    }
    const result = repairGrid(readings, 9)
    expect(result.solvable).toBe(false)
    expect(result.repaired).toBe(false)
    // Low-confidence cells stay flagged for the review screen.
    expect(result.flags.filter((f) => f === 'low').length).toBeGreaterThanOrEqual(12)
  })

  it('repairs a conflict introduced by a confident misread', () => {
    const readings = cleanReadings(puzzle)
    // Find an empty cell and fill it with a value conflicting in its row,
    // with 'empty' as the runner-up (junk misread as digit).
    const solvedRow0 = solved.slice(0, 9)
    void solvedRow0
    const idx = Array.from(puzzle).findIndex((v, i) => v === 0 && i < 9)
    const rowStart = 0
    const existing = Array.from(puzzle.slice(rowStart, rowStart + 9)).find((v) => v !== 0)!
    readings[idx] = { value: existing, confidence: 0.85, altValue: 0, altConfidence: 0.12 }
    const result = repairGrid(readings, 9)
    expect(result.solvable).toBe(true)
    expect(result.repaired).toBe(true)
    expect(result.values[idx]).toBe(0)
    expect(result.flags[idx]).toBe('repaired')
  })

  it('restores a dropped given the unique solution confirms', () => {
    // A given the puzzle does not need: without it the solution is still unique.
    const idx = Array.from(puzzle).findIndex((v, i) => {
      if (v === 0) return false
      const g = Uint8Array.from(puzzle)
      g[i] = 0
      return countSolutions(g, 9).count === 1
    })
    expect(idx).toBeGreaterThanOrEqual(0)
    const readings = cleanReadings(puzzle)
    readings[idx] = { value: 0, confidence: 0.45, altValue: puzzle[idx], altConfidence: 0.55 }
    const result = repairGrid(readings, 9)
    expect(result.values).toEqual(Array.from(puzzle))
    expect(result.flags[idx]).toBe('repaired')
  })

  it('leaves out a doubtful digit the solution contradicts', () => {
    const idx = Array.from(puzzle).findIndex((v) => v === 0)
    const readings = cleanReadings(puzzle)
    readings[idx] = { value: 0, confidence: 0.45, altValue: (solved[idx] % 9) + 1, altConfidence: 0.55 }
    const result = repairGrid(readings, 9)
    expect(result.values[idx]).toBe(0)
    expect(result.repaired).toBe(false)
  })
})
