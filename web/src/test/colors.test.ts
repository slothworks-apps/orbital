import { describe, it, expect } from 'vitest'
import { oklchTagColor } from '../map/Planet'
import { PERMISSION_MODES } from '../lib/permissionModes'

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

/** WCAG 2.x relative luminance from an sRGB hex string. */
function luminance(hex: string): number {
  const channel = (byte: number) => {
    const c = byte / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const n = parseInt(hex, 16)
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  )
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The permission-mode dots are the only place in Orbital where colour alone
 * carries a meaning the eye is meant to rank (green safest -> red unchecked),
 * so each one has to clear the non-text contrast floor against the space
 * background it sits on. 3:1 is WCAG 1.4.11.
 */
describe('permission mode dots', () => {
  // `--color-space`, the fill behind every surface that draws a mode dot.
  const SPACE = '05070d'

  for (const mode of PERMISSION_MODES) {
    it(`${mode.value} clears 3:1 against the space background`, () => {
      const [, l, c, h] = mode.dot.match(/oklch\((\d+)% ([\d.]+) (\d+)\)/)!
      const hex = oklchTagColor(Number(h), Number(l) / 100, Number(c)).getHexString()
      expect(contrast(hex, SPACE)).toBeGreaterThanOrEqual(3)
    })
  }
})
