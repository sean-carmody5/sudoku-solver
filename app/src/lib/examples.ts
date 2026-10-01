import type { GridSize } from './solver/board'

/** Curated example puzzles per size, for the "Try an example" action. */
export interface Example {
  size: GridSize
  name: string
  cells: string
}

export const EXAMPLES: Example[] = [
  {
    size: 9,
    name: "Arto Inkala's \"world's hardest sudoku\"",
    cells:
      '8........' +
      '..36.....' +
      '.7..9.2..' +
      '.5...7...' +
      '....457..' +
      '...1...3.' +
      '..1....68' +
      '..85...1.' +
      '.9....4..',
  },
  {
    size: 9,
    name: 'a classic newspaper puzzle',
    cells:
      '53..7....' +
      '6..195...' +
      '.98....6.' +
      '8...6...3' +
      '4..8.3..1' +
      '7...2...6' +
      '.6....28.' +
      '...419..5' +
      '....8..79',
  },
  {
    size: 4,
    name: 'a mini 4x4',
    cells: '1..4' + '.4.2' + '..4.' + '4..1',
  },
  {
    size: 16,
    name: 'a 16x16 hex sudoku',
    cells:
      '06.5..3.7.21..FD' +
      '...D......EF..5.' +
      '.....0D..B.541..' +
      '7.F35E...A.C..B9' +
      '.0......D17.F.2A' +
      '1.2B...DA.4.3C87' +
      '.E7F6.4.2.C.9...' +
      'D8C627.....0..1.' +
      '.7..B.....FD1934' +
      '...E.1.4.C.9A27.' +
      '649C.8.01...DB.F' +
      '3F.0.92A......6.' +
      'F5..1.0...62C7.B' +
      '..07A.5..E1.....' +
      '.A..EB......5...' +
      '9B..C2.6.7..0.48',
  },
]

/** The next example for a size, cycling so repeated taps show variety. */
export function pickExample(size: GridSize, index: number): Example {
  const pool = EXAMPLES.filter((e) => e.size === size)
  return pool[index % pool.length]
}
