import { describe, expect, it } from 'vitest'
import {
  CONTEXT_CRITICAL_DANGER,
  DEEP_FIELD_FALLBACK,
  lightness,
  mixOklab,
  oklabToRgb,
  parseHex,
  parseKindValue,
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

  it('reproduces the canvas critical arc in Deep Field', () => {
    const arc = mixOklab(DEEP_FIELD.danger, DEEP_FIELD['danger-soft'], CONTEXT_CRITICAL_DANGER)
    expect(distance(arc, oklch('oklch(72% 0.17 25)'))).toBeLessThanOrEqual(8)
  })

  it('reproduces the canvas DOM surfaces in Deep Field', () => {
    const canvas: Record<keyof typeof SCENE_CSS, string> = {
      markTile: 'oklch(34% 0.012 250)',
    }
    for (const [key, css] of Object.entries(SCENE_CSS) as [keyof typeof SCENE_CSS, string][]) {
      const [, a, share, b] = css.match(/var\(--color-([a-z0-9-]+)\) ([\d.]+)%, var\(--color-([a-z0-9-]+)\)/)!
      const mixed = mixOklab(DEEP_FIELD[a as Token], DEEP_FIELD[b as Token], Number(share) / 100)
      expect([key, distance(mixed, oklch(canvas[key])) <= 4]).toEqual([key, true])
    }
  })
})

describe('the theme kind', () => {
  it('parses the variables theme.css sets beside the colours', () => {
    expect(parseKindValue('80%', 'fraction')).toBe(0.8)
    expect(parseKindValue(' 0.13', 'number')).toBe(0.13)
    expect(parseKindValue('.12', 'number')).toBe(0.12)
    expect(parseKindValue('1px', 'number')).toBe(1)
    expect(parseKindValue('91%', 'number')).toBe(91)
    expect(parseKindValue('', 'number')).toBeNull()
    expect(parseKindValue('none', 'number')).toBeNull()
  })
})

describe('the black hole', () => {
  it('stays darker than every surface of the map in every theme', () => {
    for (const [id, t] of [['deep-field', DEEP_FIELD], ...Object.entries(THEMES)] as [string, Record<Token, Rgb>][]) {
      for (const surface of ['space', 'space-deep', 'panel', 'panel-solid', 'raised', 'body-hi', 'body-idle-hi'] as const) {
        // Black is as dark as it gets: a surface that already rounds to it ties.
        const hole = lightness(t.void)
        expect([id, surface, hole < lightness(t[surface]) || hole === 0]).toEqual([id, surface, true])
      }
    }
  })
})
