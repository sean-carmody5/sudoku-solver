/**
 * Parity: the TypeScript cell normalisation must reproduce model/common.py's
 * cell_to_tensor on the same raw crops (golden-cells.json is emitted by
 * model/gen_cell_golden.py). Training data and inference share this code
 * path, so any drift silently degrades the classifier.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cellToTensor, EMPTY_INK_RATIO } from '../../src/lib/cv/cells'

const goldenPath = join(__dirname, '..', 'fixtures', 'golden-cells.json')

interface Case {
  label: string
  width: number
  height: number
  pixels: number[]
  inkRatio: number
  tensor: number[]
  /** [x0, y0, x1, y1]: the region normalised, with the rest as context. */
  inner?: [number, number, number, number]
}

describe.skipIf(!existsSync(goldenPath))('cellToTensor parity with common.py', () => {
  const { cases } = JSON.parse(readFileSync(goldenPath, 'utf8')) as { cases: Case[] }

  it.each(cases.map((c, i) => [i, c] as const))('case %i reproduces the Python tensor', (_, c) => {
    const inner = c.inner ? { x0: c.inner[0], y0: c.inner[1], x1: c.inner[2], y1: c.inner[3] } : undefined
    const out = cellToTensor({ data: Uint8Array.from(c.pixels), width: c.width, height: c.height }, inner)
    expect(out.inkRatio).toBeCloseTo(c.inkRatio, 4)
    // Python signals "empty" with an all-background tensor (the texture
    // guard can do so even above EMPTY_INK_RATIO).
    const pyEmpty = Math.max(...c.tensor) <= -1 + 1e-6
    expect(out.isEmpty).toBe(pyEmpty)
    if (!pyEmpty) expect(c.inkRatio).toBeGreaterThanOrEqual(EMPTY_INK_RATIO)
    let worst = 0
    for (let k = 0; k < c.tensor.length; k++) worst = Math.max(worst, Math.abs(out.tensor[k] - c.tensor[k]))
    // Python computes in float64, the port in float32; the JSON is rounded
    // to 5 decimals. Anything beyond ~1e-3 is a real algorithmic difference.
    expect(worst, `max abs diff ${worst} on label '${c.label}'`).toBeLessThan(2e-3)
  })
})
