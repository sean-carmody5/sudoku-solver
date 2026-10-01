import { charToValue, GRID_SIZES, valueToChar, type Convention, type GridSize } from './solver/board'

/**
 * Puzzle <-> URL hash. `#p=9:53..7....` (81 chars), `#p=16h:...` for a
 * 16x16 in hex convention, `#p=16l:...` in letter convention. Empty cells
 * are '.', so a link is readable and survives copy-paste through chat apps.
 */
export interface SharedPuzzle {
  size: GridSize
  convention: Convention
  values: number[]
}

export function encodePuzzle(size: GridSize, values: ArrayLike<number>, convention: Convention): string {
  const cells = Array.from(values, (v) => (v === 0 ? '.' : valueToChar(size, v, convention))).join('')
  const tag = size === 16 ? `16${convention === 'letter' ? 'l' : 'h'}` : String(size)
  return `${tag}:${cells}`
}

export function decodePuzzle(payload: string): SharedPuzzle | null {
  const m = /^(4|9|16)([hl])?:([0-9A-Za-z.]+)$/.exec(payload.trim())
  if (!m) return null
  const size = Number(m[1]) as GridSize
  if (!GRID_SIZES.includes(size)) return null
  const convention: Convention = m[2] === 'l' ? 'letter' : 'hex'
  const cells = m[3]
  if (cells.length !== size * size) return null
  const values: number[] = []
  for (const ch of cells) {
    if (ch === '.') {
      values.push(0)
      continue
    }
    const v = charToValue(size, ch, convention)
    if (v === 0) return null
    values.push(v)
  }
  return { size, convention, values }
}

export function puzzleUrl(size: GridSize, values: ArrayLike<number>, convention: Convention): string {
  const base = `${location.origin}${location.pathname}`
  return `${base}#p=${encodePuzzle(size, values, convention)}`
}

export function readPuzzleFromHash(hash: string): SharedPuzzle | null {
  const m = /[#&]p=([^&]+)/.exec(hash)
  return m ? decodePuzzle(decodeURIComponent(m[1])) : null
}
