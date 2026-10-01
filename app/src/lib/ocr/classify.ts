import type { GridSize } from '../solver/board'
import { TENSOR_SIZE, type CellTensor } from '../cv/cells'
import { CLASSES, EMPTY_CLASS, legalClasses, NUM_CLASSES } from './classes'

/** Minimal interface over an ONNX session so browser (ort-web) and tests
 * (ort-node) can share this module. */
export interface LogitsRunner {
  (batch: Float32Array, count: number): Promise<Float32Array>
}

/**
 * A cell the pre-filter accepted as non-empty but which the model reads with
 * confidence below this is treated as empty (and flagged) rather than a digit.
 * A dropped-but-real digit is flagged for the user to restore, whereas a
 * fabricated given can silently break the puzzle. Confidence here is over the
 * LEGAL alphabet for the grid (see decodeProbs), so look-alikes that cannot
 * occur in this puzzle (B for 8 in a 9x9) do not drag a real digit under it.
 */
export const MIN_DIGIT_CONFIDENCE = 0.6

export interface GlyphReading {
  /** Recognised glyph character ('' = empty). */
  glyph: string
  confidence: number
  /** Best alternative glyph and its probability (repair candidates). */
  altGlyph: string
  altConfidence: number
  /** Raw logits over all classes, kept so a narrower alphabet (once the
   * 16x16 convention is known) can be decoded without re-running the model.
   * Null for cells the pre-filter judged empty. */
  logits: Float32Array | null
}

/** Softmax over a subset of classes (the legal alphabet plus empty). */
function maskedSoftmax(logits: Float32Array, classes: number[], out: Float64Array): void {
  out.fill(0)
  let max = -Infinity
  for (const c of classes) max = Math.max(max, logits[c])
  let sum = 0
  for (const c of classes) {
    out[c] = Math.exp(logits[c] - max)
    sum += out[c]
  }
  for (const c of classes) out[c] /= sum
}

/**
 * Turn one cell's logits into a reading under an alphabet: the empty class
 * always competes (the trained backstop for noise that passed the ink
 * pre-filter), and a digit that wins with too little margin is demoted to
 * empty-but-flagged rather than asserted.
 */
export function decodeProbs(logits: Float32Array, legal: Iterable<number>): Omit<GlyphReading, 'logits'> {
  const classes = [EMPTY_CLASS, ...legal]
  const probs = new Float64Array(NUM_CLASSES)
  maskedSoftmax(logits, classes, probs)
  let best = EMPTY_CLASS
  let bestP = probs[EMPTY_CLASS]
  let alt = -1
  let altP = -1
  for (const c of classes) {
    if (c === EMPTY_CLASS) continue
    if (probs[c] > bestP) {
      alt = best
      altP = bestP
      best = c
      bestP = probs[c]
    } else if (probs[c] > altP) {
      alt = c
      altP = probs[c]
    }
  }
  const tooUnsure = best !== EMPTY_CLASS && bestP < MIN_DIGIT_CONFIDENCE
  if (tooUnsure) {
    // Read as empty, but the demoted digit stays as the alternative: repair
    // can restore it when the grid is missing a given (see repairGrid).
    return { glyph: '', confidence: Math.max(probs[EMPTY_CLASS], 1 - bestP), altGlyph: CLASSES[best], altConfidence: bestP }
  }
  return {
    glyph: best === EMPTY_CLASS ? '' : CLASSES[best],
    confidence: bestP,
    altGlyph: alt === -1 || alt === EMPTY_CLASS ? '' : CLASSES[alt],
    altConfidence: alt === EMPTY_CLASS ? 0 : Math.max(0, altP),
  }
}

/**
 * Classify extracted cells into glyphs. Pre-filtered empty cells skip
 * inference. Probabilities are taken over the classes legal for the grid
 * size (16x16 keeps all of 0-9/A-G until the convention is resolved
 * downstream, which then re-decodes from the kept logits).
 */
export async function classifyGlyphs(
  cells: CellTensor[],
  size: GridSize,
  run: LogitsRunner,
): Promise<GlyphReading[]> {
  const legal = legalClasses(size)
  const active: number[] = []
  for (let i = 0; i < cells.length; i++) if (!cells[i].isEmpty) active.push(i)

  const readings: GlyphReading[] = cells.map(() => ({
    glyph: '',
    confidence: 1,
    altGlyph: '',
    altConfidence: 0,
    logits: null,
  }))
  if (active.length === 0) return readings

  const area = TENSOR_SIZE * TENSOR_SIZE
  const batch = new Float32Array(active.length * area)
  active.forEach((cellIdx, i) => batch.set(cells[cellIdx].tensor, i * area))

  const logits = await run(batch, active.length)

  active.forEach((cellIdx, i) => {
    const own = logits.slice(i * NUM_CLASSES, (i + 1) * NUM_CLASSES)
    readings[cellIdx] = { ...decodeProbs(own, legal), logits: own }
  })
  return readings
}
