import { describe, expect, it } from 'vitest'
import { detectGridSize, localLines } from '../../src/lib/cv/gridSize'
import { refineWarpByLines, WARP_SIZE } from '../../src/lib/cv/pipeline'
import { warpToSquare } from '../../src/lib/cv/warp'
import { loadFixture } from './helpers'

/** Worst corner distance between two quads. */
function cornerError(a: { x: number; y: number }[], gt: number[][]): number {
  let worst = 0
  for (let i = 0; i < 4; i++) worst = Math.max(worst, Math.hypot(a[i].x - gt[i][0], a[i].y - gt[i][1]))
  return worst
}

describe('refineWarpByLines', () => {
  // (A skewed 4x4 warp is sized 16 before refinement can run - real detection
  // never places a 4x4 corner that far off, so 4x4 is not exercised here.)
  it.each(['photo-9-0', 'photo-16-1'])('pulls a short corner back onto the border (%s)', (name) => {
    const { image, meta } = loadFixture(name)
    const gt = meta.corners!
    // One corner placed short by ~7% of the grid side: the classic error on
    // a far, dark corner of a hand-held photo.
    const side = Math.hypot(gt[1][0] - gt[0][0], gt[1][1] - gt[0][1])
    const off = 0.07 * side
    let corners = gt.map(([x, y]) => ({ x, y }))
    corners[2] = { x: gt[2][0] - off, y: gt[2][1] - off }
    let warped = warpToSquare(image, corners, WARP_SIZE)
    let sized = detectGridSize(warped)
    expect(sized, 'perturbed warp still verifies').not.toBeNull()
    if (!sized) return
    expect(sized.size).toBe(meta.size)

    const before = cornerError(corners, gt)
    let passes = 0
    for (let i = 0; i < 3; i++) {
      const refined = refineWarpByLines(image, corners, warped, sized)
      if (!refined) break
      passes++
      corners = refined.corners
      warped = refined.warped
      sized = refined.sized
    }
    const after = cornerError(corners, gt)
    // Never worse; and on a 9x9 (bold rules, measurable borders) clearly better.
    expect(after, `corner error ${before.toFixed(1)}px -> ${after.toFixed(1)}px`).toBeLessThanOrEqual(before)
    if (meta.size === 9) {
      expect(passes, 'refinement should trigger on a visibly skewed warp').toBeGreaterThan(0)
      expect(after, `corner error ${before.toFixed(1)}px -> ${after.toFixed(1)}px`).toBeLessThan(before * 0.5)
    }
    expect(sized.size).toBe(meta.size)
  })

  it('leaves an accurate warp alone', () => {
    const { image, meta } = loadFixture('photo-9-1')
    const corners = meta.corners!.map(([x, y]) => ({ x, y }))
    const warped = warpToSquare(image, corners, WARP_SIZE)
    const sized = detectGridSize(warped)!
    expect(refineWarpByLines(image, corners, warped, sized)).toBeNull()
  })
})

describe('localLines', () => {
  it('agrees with the global lines on a flat page', () => {
    const { image, meta } = loadFixture('photo-9-2')
    const corners = meta.corners!.map(([x, y]) => ({ x, y }))
    const warped = warpToSquare(image, corners, WARP_SIZE)
    const sized = detectGridSize(warped)!
    const local = localLines(warped, sized.rowLines, sized.colLines)
    const cell = WARP_SIZE / sized.size
    for (let c = 0; c < sized.size; c++) {
      for (let k = 0; k <= sized.size; k++) {
        expect(Math.abs(local.rowsByCol[c][k] - sized.rowLines[k])).toBeLessThan(0.1 * cell)
        expect(Math.abs(local.colsByRow[c][k] - sized.colLines[k])).toBeLessThan(0.1 * cell)
      }
    }
  })
})
