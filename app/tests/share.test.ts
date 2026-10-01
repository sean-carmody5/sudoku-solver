import { describe, expect, it } from 'vitest'
import { decodePuzzle, encodePuzzle, readPuzzleFromHash } from '../src/lib/share'
import { EXAMPLES } from '../src/lib/examples'
import { charToValue, gridFromString } from '../src/lib/solver/board'
import { countSolutions } from '../src/lib/solver/solve'
import { EASY_9 } from './solver/fixtures'

describe('share links', () => {
  it('round-trips a 9x9', () => {
    const values = Array.from(gridFromString(9, EASY_9))
    const payload = encodePuzzle(9, values, 'hex')
    expect(payload.startsWith('9:')).toBe(true)
    const back = decodePuzzle(payload)
    expect(back?.size).toBe(9)
    expect(back?.values).toEqual(values)
  })

  it('round-trips a 16x16 in both conventions', () => {
    const values = new Array(256).fill(0)
    values[0] = 1
    values[255] = 16
    for (const convention of ['hex', 'letter'] as const) {
      const payload = encodePuzzle(16, values, convention)
      const back = decodePuzzle(payload)
      expect(back?.convention).toBe(convention)
      expect(back?.values).toEqual(values)
    }
  })

  it('rejects malformed payloads', () => {
    expect(decodePuzzle('9:123')).toBeNull()
    expect(decodePuzzle('7:' + '.'.repeat(49))).toBeNull()
    expect(decodePuzzle('9:' + 'x'.repeat(81))).toBeNull()
    expect(decodePuzzle('4:' + '5'.repeat(16))).toBeNull() // 5 is not a 4x4 value
  })

  it('reads the hash form the app writes', () => {
    const values = Array.from(gridFromString(9, EASY_9))
    const hash = `#p=${encodeURIComponent(encodePuzzle(9, values, 'hex'))}`
    expect(readPuzzleFromHash(hash)?.values).toEqual(values)
    expect(readPuzzleFromHash('#other')).toBeNull()
  })
})

describe('example puzzles', () => {
  it.each(EXAMPLES.map((e) => [e.name, e] as const))('%s is a proper puzzle', (_, ex) => {
    expect(ex.cells.length).toBe(ex.size * ex.size)
    const grid = Uint8Array.from(ex.cells, (ch) => (ch === '.' ? 0 : charToValue(ex.size, ch, 'hex')))
    expect(countSolutions(grid, ex.size, 2).count).toBe(1)
  })
})
