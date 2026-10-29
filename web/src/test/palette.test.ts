import { describe, expect, it } from 'vitest'
import { DEEP_FIELD_FALLBACK, hexWithAlpha, swatchIn } from '../lib/palette'

describe('swatch', () => {
  it('mixes a translucent token where color-mix() exists', () => {
    expect(swatchIn(true, 'ink-900', 0.6)).toBe('color-mix(in oklab, var(--color-ink-900) 60%, transparent)')
  })

  it("falls back to Deep Field's literal with the alpha where it does not", () => {
    expect(swatchIn(false, 'ink-900', 0.6)).toBe(`${DEEP_FIELD_FALLBACK['ink-900']}99`)
    // An opaque token is a plain var(), which every engine reads.
    expect(swatchIn(false, 'ink-900')).toBe('var(--color-ink-900)')
  })

  it('writes the alpha as two hex digits, clamped', () => {
    expect(hexWithAlpha('#a8c6e9', 0.02)).toBe('#a8c6e905')
    expect(hexWithAlpha('#a8c6e9', 0)).toBe('#a8c6e900')
    expect(hexWithAlpha('#a8c6e9', -1)).toBe('#a8c6e900')
  })
})
