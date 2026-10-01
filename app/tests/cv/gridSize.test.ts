import { describe, expect, it } from 'vitest'
import { relocaliseLines, scoreSize, uniform } from '../../src/lib/cv/gridSize'

const DIM = 1024

/** A synthetic ink profile: peaks of `strength` at `positions`, plus noise. */
function profile(positions: number[], strengths: number[], noise = 0.02): Float64Array {
  const p = new Float64Array(DIM)
  for (let i = 0; i < DIM; i++) p[i] = noise * ((i * 7919) % 13) / 13
  positions.forEach((pos, k) => {
    const c = Math.round(pos)
    for (let d = -2; d <= 2; d++) {
      const i = c + d
      if (i >= 0 && i < DIM) p[i] = Math.max(p[i], strengths[k] * (1 - Math.abs(d) * 0.2))
    }
  })
  return p
}

/** Row/column profile of an n x n grid whose box rules are heavier. */
function gridProfile(n: number, offset = 0, span = DIM, missing: number[] = []): Float64Array {
  const box = Math.round(Math.sqrt(n))
  const positions: number[] = []
  const strengths: number[] = []
  for (let k = 0; k <= n; k++) {
    if (missing.includes(k)) continue
    positions.push(offset + (k * span) / n)
    strengths.push(k % box === 0 ? 0.9 : 0.5)
  }
  return profile(positions, strengths)
}

describe('scoreSize', () => {
  it.each([4, 9, 16] as const)('prefers %i for an %ix%i grid', (n) => {
    const rows = gridProfile(n)
    const cols = gridProfile(n)
    const scores = [4, 9, 16].map((m) => scoreSize(rows, cols, m, DIM))
    const best = [4, 9, 16][scores.indexOf(Math.max(...scores))]
    expect(best).toBe(n)
  })

  it('does not mistake a 4x4 for a 16x16 whose box rules coincide with it', () => {
    const rows = gridProfile(4)
    expect(scoreSize(rows, rows, 4, DIM)).toBeGreaterThan(scoreSize(rows, rows, 16, DIM))
  })
})

describe('relocaliseLines', () => {
  it('finds lines where they are, not where a uniform grid would put them', () => {
    // Lines drift by up to 12px (paper curl); the finder must follow them.
    const truth = uniform(9, DIM).map((v, k) => (k === 0 || k === 9 ? v : v + 12 * Math.sin(k)))
    const p = profile(truth, truth.map(() => 0.7))
    const lines = relocaliseLines(p, 9, DIM)
    for (let k = 1; k < 9; k++) expect(Math.abs(lines[k] - truth[k])).toBeLessThan(2.5)
  })

  it('relocalises the outer border when the quad is loose', () => {
    // Grid occupies [30, 990] of the warp: border inside the edge on both sides.
    const p = gridProfile(9, 30, 960)
    const lines = relocaliseLines(p, 9, DIM)
    expect(Math.abs(lines[0] - 30)).toBeLessThan(2.5)
    expect(Math.abs(lines[9] - 990)).toBeLessThan(2.5)
    // ...and the interior lines follow the real span, not the warp edges.
    expect(Math.abs(lines[4] - (30 + (4 * 960) / 9))).toBeLessThan(2.5)
  })

  it('keeps the border at the edge when it sits there', () => {
    const p = gridProfile(9)
    const lines = relocaliseLines(p, 9, DIM)
    expect(lines[0]).toBeLessThan(3)
    expect(lines[9]).toBeGreaterThan(DIM - 3)
  })

  it('keeps the edge when nothing line-like sits inside it', () => {
    // Border stroke cut off by the warp: no peak near either edge.
    const p = gridProfile(9, 0, DIM, [0, 9])
    const lines = relocaliseLines(p, 9, DIM)
    expect(lines[0]).toBe(0)
    expect(lines[9]).toBe(DIM)
  })

  it('snaps a single missing line back between its neighbours', () => {
    // Line 5 is absent; a digit stroke sits 30px off where it should be.
    const p = gridProfile(9, 0, DIM, [5])
    const stroke = 5 * (DIM / 9) + 30
    for (let d = -2; d <= 2; d++) p[Math.round(stroke) + d] = Math.max(p[Math.round(stroke) + d], 0.35)
    const lines = relocaliseLines(p, 9, DIM)
    expect(Math.abs(lines[5] - 5 * (DIM / 9))).toBeLessThan(3)
  })
})
