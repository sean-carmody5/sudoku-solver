import type { GridSize } from '../solver/board'

/** Class order matches model/common.py: 0 = empty, 1..10 = '0'..'9', 11..17 = 'A'..'G'. */
export const CLASSES = ['', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F', 'G']
export const NUM_CLASSES = CLASSES.length
export const EMPTY_CLASS = 0

/**
 * The glyphs legally usable for a grid size. 16x16 accepts the union of both
 * conventions (0-9, A-G) because the convention is only resolved after the
 * whole grid is read; the reader then narrows to hex (0-F) or letter (1-G).
 */
export function legalClasses(size: GridSize): number[] {
  const out: number[] = []
  for (let c = 1; c < NUM_CLASSES; c++) {
    const ch = CLASSES[c]
    if (size === 16) {
      out.push(c) // any of 0-9, A-G
    } else if (/[1-9]/.test(ch) && Number(ch) <= size) {
      out.push(c)
    }
  }
  return out
}
