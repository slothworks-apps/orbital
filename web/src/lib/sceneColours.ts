import { useEffect, useRef, useSyncExternalStore } from 'react'
import { invalidate } from '@react-three/fiber'
import * as THREE from 'three'
import { colourThemeById, DEFAULT_COLOUR_THEME, type ColourThemeKind } from './colourTheme'
import type { Token } from './palette'

/**
 * The palette for what cannot read a CSS variable: three.js materials and
 * canvas-2D textures on the map (spec 2026-10-29-colour-tokens-design § 3).
 * The colour theme lives in `theme.css` as `--color-*` values on the root;
 * this resolves them to sRGB once per theme and hands them over as
 * `THREE.Color`s, so the map follows the same switch as the chrome.
 *
 * Reading happens only when the theme changes (or the stylesheet first
 * arrives), never per frame: a theme's palette is built once and cached by
 * its id. The colours it hands out are shared — read them, copy them, lerp
 * toward them; never mutate one.
 */

/** sRGB, 0–255 per channel. */
export type Rgb = readonly [number, number, number]

/** Every token of `theme.css`, the same list as `Token` in `palette.ts`. */
export const SCENE_TOKENS = [
  'space',
  'space-deep',
  'shade',
  'panel',
  'panel-solid',
  'raised',
  'line',
  'ink-50',
  'ink-100',
  'ink-200',
  'ink-300',
  'ink-400',
  'ink-500',
  'ink-600',
  'ink-700',
  'ink-800',
  'ink-900',
  'accent',
  'sky',
  'sky-soft',
  'warning',
  'warning-soft',
  'warning-deep',
  'success',
  'danger',
  'danger-soft',
  'danger-pale',
  'shadow',
  'highlight',
  'nebula-a',
  'nebula-b',
  'star',
  'body-hi',
  'body-mid',
  'body-lo',
  'body-idle-hi',
  'body-idle-lo',
  'body-ended',
  'void',
  'disc-off',
  'eclipse',
] as const satisfies readonly Token[]

/**
 * Deep Field's `@theme` values, for the one moment the stylesheet is not
 * there yet (and jsdom, which never loads it). A test holds this table to
 * `theme.css`, so it cannot drift from it.
 */
export const DEEP_FIELD_FALLBACK: Readonly<Record<Token, string>> = {
  space: '#05070d',
  'space-deep': '#03111a',
  shade: '#040810',
  panel: '#0a101c',
  'panel-solid': '#0a1220',
  raised: '#101626',
  line: '#96cdff',
  'ink-50': '#f2f9ff',
  'ink-100': '#e8eef8',
  'ink-200': '#dcebff',
  'ink-300': '#cfe6ff',
  'ink-400': '#d6e2f2',
  'ink-500': '#c8dcf5',
  'ink-600': '#c8d6eb',
  'ink-700': '#bed4ee',
  'ink-800': '#b2cbe6',
  'ink-900': '#a8c6e9',
  accent: '#59e4f3',
  sky: '#8fd8ff',
  'sky-soft': '#c6ecff',
  warning: '#ffbb7b',
  'warning-soft': '#ffd6ad',
  'warning-deep': '#fba962',
  success: '#7fe3b0',
  danger: '#de3b3d',
  'danger-soft': '#fa8880',
  'danger-pale': '#ffb4ad',
  shadow: '#040810',
  highlight: '#ffffff',
  'nebula-a': '#6e50dc',
  'nebula-b': '#28aadc',
  star: '#ffffff',
  'body-hi': '#07333f',
  'body-mid': '#001924',
  'body-lo': '#010f18',
  'body-idle-hi': '#012e3a',
  'body-idle-lo': '#00151f',
  'body-ended': '#090e11',
  void: '#000000',
  'disc-off': '#111417',
  eclipse: '#080c0f',
}

/**
 * What a theme's kind sets beside its colours (`theme.css` `:root`, canvas
 * `Feature - Colour themes` 1l, 1m): the tag hue's lightness and chroma as a
 * body, whether glows paint, the light themes' edge, and the limit sun's rim.
 */
export interface SceneKind {
  /** `--tb-l`, `--tb-c`: a tag hue as a body, OKLCH lightness 0–1 and chroma. */
  tagL: number
  tagC: number
  /** `--glow-k`: 1 where glows paint (dark themes), 0 where they do not. */
  glowK: number
  /** `--edge-w`: the 1 px edge in the tag hue a light theme draws round a body, in CSS px; 0 on a dark theme. */
  edgeW: number
  /** `--sun-l`, `--sun-c`, `--sun-ra`: a limit sun's rim and week arc, lightness 0–100 and chroma, and the rim's alpha. */
  sunL: number
  sunC: number
  sunRa: number
}

/** Deep Field's, for the same moment as `DEEP_FIELD_FALLBACK`. */
export const DARK_KIND: SceneKind = { tagL: 0.8, tagC: 0.13, glowK: 1, edgeW: 0, sunL: 91, sunC: 0.09, sunRa: 0.25 }

/** Parses one of those variables: as a `fraction`, `80%` is 0.8; otherwise `1px` is 1 and `.13` is 0.13. */
export function parseKindValue(raw: string, unit: 'fraction' | 'number'): number | null {
  const value = raw.trim()
  if (!value) return null
  const n = parseFloat(value)
  if (!Number.isFinite(n)) return null
  return unit === 'fraction' && value.endsWith('%') ? n / 100 : n
}

// --- OKLab, for mixing the way CSS `color-mix(in oklab, …)` does -----------

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

/** sRGB → OKLab `[L, a, b]` (Björn Ottosson's matrices, as CSS Color 4). */
export function rgbToOklab([r8, g8, b8]: Rgb): [number, number, number] {
  const r = toLinear(r8 / 255)
  const g = toLinear(g8 / 255)
  const b = toLinear(b8 / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

/** OKLab → sRGB, clipped into the gamut and rounded to bytes. */
export function oklabToRgb([L, A, B]: readonly [number, number, number]): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const [r, g, b] = linear.map((c) => Math.round(Math.min(1, Math.max(0, toGamma(Math.max(0, c)))) * 255))
  return [r, g, b]
}

/** `color-mix(in oklab, a <share>, b)`, with `share` 0–1 the part of `a`. */
export function mixOklab(a: Rgb, b: Rgb, share: number): Rgb {
  const la = rgbToOklab(a)
  const lb = rgbToOklab(b)
  return oklabToRgb([0, 1, 2].map((i) => la[i] * share + lb[i] * (1 - share)) as [number, number, number])
}

/** How light a colour is, OKLab L 0–1. */
export function lightness(rgb: Rgb): number {
  return rgbToOklab(rgb)[0]
}

// --- Derived colours with no token of their own ----------------------------
// Each is a mix of tokens at a share that reproduces the canvas's own value
// in Deep Field (the tests hold them to it), so it follows every other theme.

/**
 * The context arc past its second threshold (canvas 1i `oklch(72% .17 25)`):
 * `danger`'s share in a mix with `danger-soft`. Between the two, as the
 * canvas's red is.
 */
export const CONTEXT_CRITICAL_DANGER = 0.185

/**
 * Map surfaces drawn in DOM that have no token: a mix in CSS, so they follow
 * the theme without three.js (each reproduces the canvas's oklch in Deep
 * Field within a few units per channel).
 */
export const SCENE_CSS = {
  /** A directory tile on a planet label or a sun label, `oklch(34% .012 250)` (44f, 60a). */
  markTile: 'color-mix(in oklab, var(--color-ink-600) 27.5%, var(--color-space))',
} as const

export type SceneColours = Readonly<Record<Token, THREE.Color>> &
  Readonly<SceneKind> & {
    /** The colour theme's id; `deep-field` for the stylesheet's own palette. */
    readonly id: string
    readonly kind: ColourThemeKind
    /** The same tokens as bytes, for canvas-2D textures and mixing. */
    readonly rgb: Readonly<Record<Token, Rgb>>
    readonly glint: THREE.Color
    /** The context arc past its second threshold. */
    readonly contextCritical: THREE.Color
  }

/** sRGB bytes as a `THREE.Color` (three keeps it linear inside, as `new THREE.Color('#…')` does). */
export function rgbColour([r, g, b]: Rgb): THREE.Color {
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace)
}

/** A CSS `rgb()` for bytes — the canvas-2D side. */
export function rgbCss([r, g, b]: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`
}

/** Builds a theme's scene palette from its resolved tokens. Pure: no DOM. */
export function buildSceneColours(
  id: string,
  kind: ColourThemeKind,
  rgb: Record<Token, Rgb>,
  sceneKind: SceneKind = DARK_KIND,
): SceneColours {
  const colours = {} as Record<Token, THREE.Color>
  for (const token of SCENE_TOKENS) colours[token] = rgbColour(rgb[token])
  return {
    ...colours,
    ...sceneKind,
    id,
    kind,
    rgb,
    // The brightest marks on a planet or a moon (the core, the needs-input
    // glow, the reticle): pure white on a dark sky, as they always were, and
    // the strongest ink on a light one.
    glint: kind === 'dark' ? new THREE.Color('#ffffff') : rgbColour(rgb['ink-50']),
    contextCritical: rgbColour(mixOklab(rgb.danger, rgb['danger-soft'], CONTEXT_CRITICAL_DANGER)),
  }
}

/** `#rrggbb` / `#rgb` to bytes, or null. */
export function parseHex(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, '')
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb
}

// --- Reading the root -------------------------------------------------------

let probe: CanvasRenderingContext2D | null | undefined

/** A 1×1 canvas to paint a CSS colour on and read it back: the browser resolves oklch and color-mix itself. */
function probeContext(): CanvasRenderingContext2D | null {
  if (probe !== undefined) return probe
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    probe = canvas.getContext('2d', { willReadFrequently: true })
  } catch {
    probe = null
  }
  return probe
}

function resolve(value: string): Rgb | null {
  if (!value) return null
  const ctx = probeContext()
  if (!ctx) return parseHex(value)
  ctx.clearRect(0, 0, 1, 1)
  // An unparsable value leaves the previous fillStyle; the sentinel makes that visible.
  ctx.fillStyle = '#010203'
  ctx.fillStyle = value
  if (ctx.fillStyle === '#010203' && parseHex(value)?.join() !== '1,2,3') return null
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}

const cache = new Map<string, SceneColours>()

function themeIdOf(root: HTMLElement): string {
  return root.dataset.colours ?? DEFAULT_COLOUR_THEME
}

/**
 * The scene palette of the theme `root` paints in now. Cached per theme id;
 * a read that found the stylesheet missing stands in Deep Field's values and
 * is not cached, so the next read (the `load` below) takes the real ones.
 */
export function readSceneColours(root: HTMLElement = document.documentElement): SceneColours {
  const id = themeIdOf(root)
  const hit = cache.get(id)
  if (hit) return hit
  const style = getComputedStyle(root)
  const rgb = {} as Record<Token, Rgb>
  let complete = true
  for (const token of SCENE_TOKENS) {
    const value = resolve(style.getPropertyValue(`--color-${token}`).trim())
    if (!value) complete = false
    rgb[token] = value ?? parseHex(DEEP_FIELD_FALLBACK[token])!
  }
  const read = (name: string, unit: 'fraction' | 'number', fallback: number) => {
    const value = parseKindValue(style.getPropertyValue(name), unit)
    if (value === null) complete = false
    return value ?? fallback
  }
  const sceneKind: SceneKind = {
    tagL: read('--tb-l', 'fraction', DARK_KIND.tagL),
    tagC: read('--tb-c', 'number', DARK_KIND.tagC),
    glowK: read('--glow-k', 'number', DARK_KIND.glowK),
    edgeW: read('--edge-w', 'number', DARK_KIND.edgeW),
    // The sun's lightness stays 0–100: it goes straight back into a CSS oklch().
    sunL: read('--sun-l', 'number', DARK_KIND.sunL),
    sunC: read('--sun-c', 'number', DARK_KIND.sunC),
    sunRa: read('--sun-ra', 'number', DARK_KIND.sunRa),
  }
  const palette = buildSceneColours(id, colourThemeById(id)?.kind ?? 'dark', rgb, sceneKind)
  if (complete) cache.set(id, palette)
  return palette
}

// --- The store the hook subscribes to ---------------------------------------

const listeners = new Set<() => void>()
let current: SceneColours | null = null
let observer: MutationObserver | null = null

function refresh(): void {
  const next = readSceneColours()
  if (next === current) return
  current = next
  listeners.forEach((listener) => listener())
  // Every map canvas draws on demand: ask each for a frame in the new colours.
  invalidate()
}

function onLoad(): void {
  refresh()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-colours'] })
    // The stylesheet may land after the first read (dev's injected CSS).
    if (document.readyState !== 'complete') window.addEventListener('load', onLoad, { once: true })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && observer) {
      observer.disconnect()
      observer = null
      window.removeEventListener('load', onLoad)
    }
  }
}

function snapshot(): SceneColours {
  current ??= readSceneColours()
  return current
}

/**
 * The scene palette of the active colour theme. Re-renders the caller when
 * `data-colours` on `<html>` changes, and asks every map canvas for a frame,
 * so a `frameloop="demand"` canvas paints the new colours on the next one.
 */
export function useSceneColours(): SceneColours {
  const palette = useSyncExternalStore(subscribe, snapshot, snapshot)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    invalidate()
  }, [palette])
  return palette
}
