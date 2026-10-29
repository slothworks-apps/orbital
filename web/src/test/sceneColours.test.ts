import { describe, expect, it } from 'vitest'
import {
  BODY_ENDED_LINE,
  BODY_IDLE_ACCENT,
  BODY_WORKING_ACCENT,
  buildSceneColours,
  CONTEXT_CRITICAL_DANGER,
  DEEP_FIELD_FALLBACK,
  holeDark,
  HOLE_TOKEN_SHARE,
  lightness,
  mixOklab,
  oklabToRgb,
  parseHex,
  SCENE_CSS,
  SCENE_TOKENS,
  type Rgb,
} from '../lib/sceneColours'
import type { Token } from '../lib/palette'

type Fs = { readFileSync(path: URL, encoding: 'utf8'): string }
// Through `process` rather than an import: web/'s tsconfig carries no Node
// types (as `mobilebundle.test.ts`). And not `?raw`: Vitest hands CSS over empty.
const fs = (globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } }).process.getBuiltinModule('node:fs')
// Through a local, so Vite's asset-url plugin leaves the URL a file:// path.
const here = import.meta.url
const THEME_CSS = fs.readFileSync(new URL('../theme.css', here), 'utf8')

/** `oklch(L% C H)` → sRGB bytes, the CSS Color 4 way. */
function oklch(value: string): Rgb {
  const [, l, c, h] = value.match(/oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)/)!
  const rad = (Number(h) * Math.PI) / 180
  return oklabToRgb([Number(l) / 100, Number(c) * Math.cos(rad), Number(c) * Math.sin(rad)])
}

/** A theme block's token values, `var()` references resolved within the block or against Deep Field. */
function tokensOf(block: string, base?: Record<Token, Rgb>): Record<Token, Rgb> {
  const raw = new Map<string, string>()
  for (const [, name, value] of block.matchAll(/--color-([a-z0-9-]+):\s*([^;]+);/g)) raw.set(name, value.trim())
  const out = { ...base } as Record<Token, Rgb>
  const value = (token: string): Rgb => {
    const v = raw.get(token)
    if (v === undefined) return out[token as Token]
    const ref = v.match(/^var\(--color-([a-z0-9-]+)\)$/)
    if (ref) return value(ref[1])
    return v.startsWith('#') ? parseHex(v)! : oklch(v)
  }
  for (const token of SCENE_TOKENS) out[token] = value(token)
  return out
}

const themeBlock = THEME_CSS.match(/@theme \{([\s\S]*?)\n\}/)![1]
const DEEP_FIELD = tokensOf(themeBlock)
const THEMES = Object.fromEntries(
  [...THEME_CSS.matchAll(/:root\[data-colours='([a-z-]+)'\] \{([\s\S]*?)\n\}/g)].map(([, id, block]) => [
    id,
    tokensOf(block, DEEP_FIELD),
  ]),
) as Record<string, Record<Token, Rgb>>

/** Largest per-channel difference. */
const distance = (a: Rgb, b: Rgb) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))

describe('scene palette', () => {
  it('falls back to exactly the @theme values of theme.css', () => {
    for (const token of SCENE_TOKENS) {
      expect([token, parseHex(DEEP_FIELD_FALLBACK[token])]).toEqual([token, DEEP_FIELD[token]])
    }
  })

  it('reads every theme theme.css defines', () => {
    expect(Object.keys(THEMES).length).toBeGreaterThanOrEqual(9)
  })

  it('mixes like color-mix(in oklab): the ends are the colours themselves', () => {
    const a: Rgb = [150, 205, 255]
    const b: Rgb = [5, 7, 13]
    expect(mixOklab(a, b, 1)).toEqual(a)
    expect(mixOklab(a, b, 0)).toEqual(b)
  })

  it('reproduces the canvas body and arc colours in Deep Field', () => {
    const p = buildSceneColours('deep-field', 'dark', DEEP_FIELD)
    const near = (got: Rgb, canvas: string, within = 8) => expect(distance(got, oklch(canvas))).toBeLessThanOrEqual(within)
    near(p.bodyWorking[0], 'oklch(30% 0.05 220)')
    near(p.bodyWorking[1], 'oklch(20% 0.04 225)')
    near(p.bodyWorking[2], 'oklch(16% 0.03 230)')
    near(p.bodyIdle[0], 'oklch(28% 0.05 220)', 9)
    near(p.bodyIdle[1], 'oklch(18% 0.04 225)')
    near(mixOklab(DEEP_FIELD.line, DEEP_FIELD.space, BODY_ENDED_LINE), 'oklch(16% 0.01 230)')
    near(mixOklab(DEEP_FIELD.danger, DEEP_FIELD['danger-soft'], CONTEXT_CRITICAL_DANGER), 'oklch(72% 0.17 25)')
    // The shares are what the stops are built from.
    expect(p.bodyWorking[0]).toEqual(mixOklab(DEEP_FIELD.accent, DEEP_FIELD['space-deep'], BODY_WORKING_ACCENT[0]))
    expect(p.bodyIdle[0]).toEqual(mixOklab(DEEP_FIELD.accent, DEEP_FIELD['space-deep'], BODY_IDLE_ACCENT[0]))
  })

  it('reproduces the canvas DOM surfaces in Deep Field', () => {
    const canvas: Record<keyof typeof SCENE_CSS, string> = {
      markTile: 'oklch(34% 0.012 250)',
      sunStaleDisc: 'oklch(19% 0.008 250)',
      sunSpentDisc: 'oklch(15% 0.01 250)',
    }
    for (const [key, css] of Object.entries(SCENE_CSS) as [keyof typeof SCENE_CSS, string][]) {
      const [, a, share, b] = css.match(/var\(--color-([a-z0-9-]+)\) ([\d.]+)%, var\(--color-([a-z0-9-]+)\)/)!
      const mixed = mixOklab(DEEP_FIELD[a as Token], DEEP_FIELD[b as Token], Number(share) / 100)
      expect([key, distance(mixed, oklch(canvas[key])) <= 4]).toEqual([key, true])
    }
  })
})

describe('holeDark', () => {
  it('starts from the shade on a dark theme and from the dark ink on a light one', () => {
    expect(holeDark(DEEP_FIELD.shade, DEEP_FIELD['ink-50'])).toEqual(mixOklab(DEEP_FIELD.shade, [0, 0, 0], HOLE_TOKEN_SHARE))
    const infrared = THEMES.infrared
    expect(holeDark(infrared.shade, infrared['ink-50'])).toEqual(mixOklab(infrared['ink-50'], [0, 0, 0], HOLE_TOKEN_SHARE))
  })

  it('stays the black the canvas draws in Deep Field', () => {
    expect(distance(holeDark(DEEP_FIELD.shade, DEEP_FIELD['ink-50']), [0, 0, 0])).toBeLessThanOrEqual(8)
  })

  it('keeps the hole the darkest surface of the map in every theme', () => {
    for (const [id, t] of [['deep-field', DEEP_FIELD], ...Object.entries(THEMES)] as [string, Record<Token, Rgb>][]) {
      const hole = lightness(holeDark(t.shade, t['ink-50']))
      for (const surface of ['space', 'space-deep', 'shade', 'panel', 'panel-solid', 'raised', 'ink-50'] as const) {
        // Black is as dark as it gets: a surface that already rounds to it ties.
        expect([id, surface, hole < lightness(t[surface]) || hole === 0]).toEqual([id, surface, true])
      }
    }
  })
})
