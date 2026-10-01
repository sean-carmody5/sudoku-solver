export type GridSize = 4 | 9 | 16

export const GRID_SIZES: GridSize[] = [4, 9, 16]

/** Cell values are 1..size internally; 0 means empty. */
export type Grid = Uint8Array

export interface Tables {
  size: GridSize
  boxSize: number
  numCells: number
  allMask: number
  /** 3*size units (rows, cols, boxes), each an array of cell indices. */
  units: Int16Array[]
  /** For each cell, the indices of its ~3 units in `units`. */
  cellUnits: Int16Array[]
  /** For each cell, the distinct cells sharing a unit with it. */
  peers: Int16Array[]
}

const cache = new Map<GridSize, Tables>()

export function getTables(size: GridSize): Tables {
  const cached = cache.get(size)
  if (cached) return cached

  const boxSize = Math.sqrt(size)
  const numCells = size * size
  const units: Int16Array[] = []

  for (let r = 0; r < size; r++) {
    const u = new Int16Array(size)
    for (let c = 0; c < size; c++) u[c] = r * size + c
    units.push(u)
  }
  for (let c = 0; c < size; c++) {
    const u = new Int16Array(size)
    for (let r = 0; r < size; r++) u[r] = r * size + c
    units.push(u)
  }
  for (let b = 0; b < size; b++) {
    const u = new Int16Array(size)
    const r0 = Math.floor(b / boxSize) * boxSize
    const c0 = (b % boxSize) * boxSize
    let i = 0
    for (let r = r0; r < r0 + boxSize; r++)
      for (let c = c0; c < c0 + boxSize; c++) u[i++] = r * size + c
    units.push(u)
  }

  const cellUnits: Int16Array[] = []
  const peers: Int16Array[] = []
  for (let cell = 0; cell < numCells; cell++) {
    const r = Math.floor(cell / size)
    const c = cell % size
    const b = Math.floor(r / boxSize) * boxSize + Math.floor(c / boxSize)
    cellUnits.push(new Int16Array([r, size + c, 2 * size + b]))

    const set = new Set<number>()
    for (const u of [units[r], units[size + c], units[2 * size + b]])
      for (const other of u) if (other !== cell) set.add(other)
    peers.push(new Int16Array([...set]))
  }

  const tables: Tables = {
    size,
    boxSize,
    numCells,
    allMask: (1 << size) - 1,
    units,
    cellUnits,
    peers,
  }
  cache.set(size, tables)
  return tables
}

export function popcount(x: number): number {
  x -= (x >> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333)
  x = (x + (x >> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >> 24
}

/** 1-based value of the lowest set bit (bit 0 -> value 1). */
export function lowestValue(mask: number): number {
  return 32 - Math.clz32(mask & -mask)
}

/** 16x16 symbol conventions: hex uses 0-F, letter uses 1-G. */
export type Convention = 'hex' | 'letter'
const HEX_CHARS = '0123456789ABCDEF'
const LETTER_CHARS = '123456789ABCDEFG'

/** Display character for a value (1..size). 16x16 depends on the convention. */
export function valueToChar(size: GridSize, value: number, convention: Convention = 'hex'): string {
  if (value === 0) return ''
  if (size === 16) return (convention === 'letter' ? LETTER_CHARS : HEX_CHARS)[value - 1]
  return String(value)
}

/** Parse a display character to a value (1..size), or 0 if invalid. */
export function charToValue(size: GridSize, ch: string, convention: Convention = 'hex'): number {
  if (ch === '') return 0 // guard: ''.indexOf in a charset would wrongly hit 0
  const upper = ch.toUpperCase()
  if (size === 16) {
    const idx = (convention === 'letter' ? LETTER_CHARS : HEX_CHARS).indexOf(upper)
    return idx === -1 ? 0 : idx + 1
  }
  const v = parseInt(upper, 10)
  return Number.isInteger(v) && v >= 1 && v <= size ? v : 0
}

/** Parse a string of display chars ('.' or '0'/' ' = empty for 4/9; '.' = empty for 16). */
export function gridFromString(size: GridSize, s: string): Grid {
  const cleaned = s.replace(/[\s|+-]/g, '')
  const grid = new Uint8Array(size * size)
  if (cleaned.length !== size * size)
    throw new Error(`expected ${size * size} cells, got ${cleaned.length}`)
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (ch === '.') continue
    if (size !== 16 && ch === '0') continue
    grid[i] = charToValue(size, ch)
  }
  return grid
}

export function gridToString(size: GridSize, grid: Grid): string {
  let out = ''
  for (let i = 0; i < grid.length; i++)
    out += grid[i] === 0 ? '.' : valueToChar(size, grid[i])
  return out
}
