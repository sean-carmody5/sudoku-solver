import { describe, expect, it } from 'vitest'
import { detectConvention, glyphsToReadings } from '../../src/lib/ocr/convention'
import type { GlyphReading } from '../../src/lib/ocr/classify'

function g(glyph: string, confidence = 0.99): GlyphReading {
  return { glyph, confidence, altGlyph: '', altConfidence: 0, logits: null }
}

describe('detectConvention', () => {
  it('returns hex for non-16 sizes', () => {
    expect(detectConvention([g('5')], 9)).toBe('hex')
  })

  it('picks hex when a 0 is present', () => {
    expect(detectConvention([g('0'), g('A'), g('5')], 16)).toBe('hex')
  })

  it('picks letter when a G is present and no 0', () => {
    expect(detectConvention([g('G'), g('A'), g('9')], 16)).toBe('letter')
  })

  it('defaults to hex when neither 0 nor G appears', () => {
    expect(detectConvention([g('3'), g('A'), g('F')], 16)).toBe('hex')
  })

  it('breaks 0-vs-G ties toward the more frequent symbol', () => {
    expect(detectConvention([g('G'), g('G'), g('0')], 16)).toBe('letter')
    expect(detectConvention([g('0'), g('0'), g('G')], 16)).toBe('hex')
  })
})

describe('glyphsToReadings', () => {
  it('maps hex glyphs to 1-based values', () => {
    const r = glyphsToReadings([g('0'), g('F'), g('')], 16, 'hex')
    expect(r[0].value).toBe(1)
    expect(r[1].value).toBe(16)
    expect(r[2].value).toBe(0)
  })

  it('maps letter glyphs to 1-based values', () => {
    const r = glyphsToReadings([g('1'), g('G'), g('A')], 16, 'letter')
    expect(r[0].value).toBe(1)
    expect(r[1].value).toBe(16)
    expect(r[2].value).toBe(10)
  })

  it('demotes a glyph illegal under the convention to its alt', () => {
    // 'G' is illegal in hex; fall back to the alt 'C'.
    const reading: GlyphReading = { glyph: 'G', confidence: 0.6, altGlyph: 'C', altConfidence: 0.3, logits: null }
    const [out] = glyphsToReadings([reading], 16, 'hex')
    expect(out.value).toBe(13) // 'C' -> 13 in hex
    expect(out.confidence).toBeCloseTo(0.3)
  })

  it('flags an illegal glyph with no usable alt as empty + low confidence', () => {
    const reading: GlyphReading = { glyph: '0', confidence: 0.7, altGlyph: '', altConfidence: 0, logits: null }
    const [out] = glyphsToReadings([reading], 16, 'letter')
    expect(out.value).toBe(0)
    expect(out.confidence).toBeLessThan(0.5)
  })

  it('maps 9x9 digits directly', () => {
    const r = glyphsToReadings([g('7'), g('')], 9, 'hex')
    expect(r[0].value).toBe(7)
    expect(r[1].value).toBe(0)
  })
})
