import { describe, expect, it } from 'vitest'
import { lightness, mixOklab, oklabToRgb, parseHex, parseKindValue, type Rgb } from '../lib/sceneColours'
import { DEEP_FIELD_FALLBACK, TOKENS, type Token } from '../lib/palette'
import { COLOUR_THEMES, DEFAULT_COLOUR_THEME } from '../lib/colourTheme'

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

/** The `--color-*` names a block defines. */
function namesOf(block: string): Set<string> {
  return new Set([...block.matchAll(/--color-([a-z0-9-]+):/g)].map(([, name]) => name))
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
  for (const token of TOKENS) out[token] = value(token)
  return out
}

// Deep Field is the `@theme` and the plain `:root` blocks: the tokens no
// Tailwind utility uses sit in `:root`, or the build would drop them.
const deepFieldBlock = [
  THEME_CSS.match(/^@theme \{([\s\S]*?)\n\}/m)![1],
  ...[...THEME_CSS.matchAll(/^:root \{([\s\S]*?)\n\}/gm)].map(([, block]) => block),
].join('\n')
const DEEP_FIELD = tokensOf(deepFieldBlock)
const THEME_BLOCKS = new Map(
  [...THEME_CSS.matchAll(/:root\[data-colours='([a-z-]+)'\] \{([\s\S]*?)\n\}/g)].map(([, id, block]) => [id, block]),
)
const THEMES = Object.fromEntries(
  [...THEME_BLOCKS].map(([id, block]) => [id, tokensOf(block, DEEP_FIELD)]),
) as Record<string, Record<Token, Rgb>>

describe('scene palette', () => {
  it('falls back to exactly the Deep Field values of theme.css', () => {
    for (const token of TOKENS) {
      expect([token, parseHex(DEEP_FIELD_FALLBACK[token])]).toEqual([token, DEEP_FIELD[token]])
    }
  })

  it('has Deep Field define exactly the tokens of TOKENS', () => {
    expect([...namesOf(deepFieldBlock)].sort()).toEqual([...TOKENS].sort())
  })

  it('has a block in theme.css for every colour theme, defining every token', () => {
    const others = COLOUR_THEMES.filter((theme) => theme.id !== DEFAULT_COLOUR_THEME).map((theme) => theme.id)
    expect([...THEME_BLOCKS.keys()].sort()).toEqual(others.sort())
    for (const [id, block] of THEME_BLOCKS) {
      const names = namesOf(block)
      expect([id, TOKENS.filter((token) => !names.has(token))]).toEqual([id, []])
    }
  })

  it('mixes like color-mix(in oklab): the ends are the colours themselves', () => {
    const a: Rgb = [150, 205, 255]
    const b: Rgb = [5, 7, 13]
    expect(mixOklab(a, b, 1)).toEqual(a)
    expect(mixOklab(a, b, 0)).toEqual(b)
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
