import { describe, expect, it } from 'vitest'
import { processImage } from '../../src/lib/cv/pipeline'
import { loadFixture, loadManifest } from './helpers'

const manifest = loadManifest()
const positives = manifest.filter((n) => !n.startsWith('neg-'))
const negatives = manifest.filter((n) => n.startsWith('neg-'))

describe('grid detection on fixtures', () => {
  it.each(positives)('%s: finds grid, right size, accurate corners', (name) => {
    const { image, meta } = loadFixture(name)
    const result = processImage(image)
    expect(result.ok, `expected success on ${name}`).toBe(true)
    if (!result.ok) return
    expect(result.size).toBe(meta.size)

    // Corner error vs ground truth, in full-res pixels.
    const gt = meta.corners!
    let worst = 0
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(result.corners[i].x - gt[i][0], result.corners[i].y - gt[i][1])
      worst = Math.max(worst, d)
    }
    // GT corners sit on the outer edge of the border stroke; the detector
    // traces the same outer boundary. Allow a few pixels at full resolution.
    expect(worst, `corner error ${worst.toFixed(1)}px on ${name}`).toBeLessThan(8)
  })

  it.each(negatives)('%s: rejects non-grids', (name) => {
    const { image } = loadFixture(name)
    const result = processImage(image)
    expect(result.ok).toBe(false)
  })
})

describe('cell extraction on fixtures', () => {
  it.each(positives)('%s: empty/non-empty split matches ground truth', (name) => {
    const { image, meta } = loadFixture(name)
    const result = processImage(image)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const cells = meta.cells!
    expect(result.cells.length).toBe(cells.length)
    let wrong = 0
    for (let i = 0; i < cells.length; i++) {
      const shouldBeEmpty = cells[i] === '.'
      if (result.cells[i].isEmpty !== shouldBeEmpty) wrong++
    }
    const errRate = wrong / cells.length
    expect(errRate, `${wrong}/${cells.length} empty-detection errors on ${name}`).toBeLessThan(0.01)
  })
})
