import { describe, it, expect } from 'vitest'
import { oklchTagColor } from '../map/Planet'

/**
 * Pins `oklchTagColor` (the OKLCH -> linear-sRGB -> THREE.Color conversion
 * used because three@0.162's `Color.setStyle` cannot parse `oklch()`
 * strings) against hex values independently computed from the CSS Color 4
 * OKLCH -> sRGB reference algorithm (Björn Ottosson's OKLab matrices +
 * standard sRGB gamma encoding), not from the implementation itself — so a
 * regression (e.g. the linear/sRGB colorspace mixup fixed here) actually
 * fails this test instead of being tautologically "correct".
 *
 * `tagColor(hue)` (`lib/types.ts`) always uses lightness .8 / chroma .13, so
 * these use the same defaults.
 */
describe('oklchTagColor', () => {
  it('oklch(80% .13 210) -> #2fd4ec (WORK tag hue)', () => {
    expect(oklchTagColor(210).getHexString()).toBe('2fd4ec')
  })

  it('oklch(80% .13 330) -> #ed9ee5 (PERSONAL tag hue)', () => {
    expect(oklchTagColor(330).getHexString()).toBe('ed9ee5')
  })
})
