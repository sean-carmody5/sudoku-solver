import { charToValue, type Convention, type GridSize } from '../solver/board'
import { CLASSES } from './classes'
import { decodeProbs, type GlyphReading } from './classify'
import type { CellReading } from './repair'

/**
 * For a 16x16 grid, decide whether the puzzle uses the hex (0-F) or letter
 * (1-G) symbol set. A real 0 forces hex; a real G forces letter; ties and
 * absence default to hex (the more common newspaper convention).
 */
export function detectConvention(readings: GlyphReading[], size: GridSize): Convention {
  if (size !== 16) return 'hex'
  let zeros = 0
  let gs = 0
  for (const r of readings) {
    if (r.glyph === '0') zeros++
    else if (r.glyph === 'G') gs++
  }
  return gs > zeros ? 'letter' : 'hex'
}

/** Class indices of the glyphs a 16x16 convention admits. */
function conventionClasses(convention: Convention): number[] {
  const chars = convention === 'letter' ? '123456789ABCDEFG' : '0123456789ABCDEF'
  return Array.from(chars, (ch) => CLASSES.indexOf(ch))
}

/**
 * Convert glyph readings to solver values under a resolved convention. For
 * 16x16 the reading is re-decoded from its logits over the convention's own
 * alphabet, so the one symbol that cannot occur (0 in a letter grid, G in a
 * hex grid) no longer competes for probability with its look-alikes. A cell
 * whose logits were not kept falls back to demotion: the alternative is used
 * when legal, otherwise the cell is marked empty with floored confidence so
 * repair/review picks it up.
 */
export function glyphsToReadings(
  readings: GlyphReading[],
  size: GridSize,
  convention: Convention,
): CellReading[] {
  const legal = size === 16 ? conventionClasses(convention) : null
  return readings.map((r) => {
    if (legal && r.logits) r = { ...decodeProbs(r.logits, legal), logits: r.logits }
    const value = charToValue(size, r.glyph, convention)
    const altValue = charToValue(size, r.altGlyph, convention)
    if (r.glyph !== '' && value === 0) {
      // Recognised glyph isn't valid under this convention; prefer the alt.
      if (altValue !== 0) {
        return { value: altValue, confidence: r.altConfidence, altValue: 0, altConfidence: 0 }
      }
      return { value: 0, confidence: 0.4, altValue: 0, altConfidence: 0 }
    }
    return {
      value,
      confidence: r.confidence,
      altValue: altValue === value ? 0 : altValue,
      altConfidence: altValue === value ? 0 : r.altConfidence,
    }
  })
}
