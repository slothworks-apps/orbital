/**
 * The palette's tokens, and a token as a CSS colour for inline styles and
 * SVG attributes — the `style` twin of a Tailwind class like
 * `text-ink-900/60`. The value is a `var()`, so it follows the active colour
 * theme (spec 2026-10-29-colour-tokens-design). Not for three.js, canvas 2D
 * or xterm, which cannot resolve CSS variables (`sceneColours.ts` is theirs).
 */

/** Every `--color-*` token of `theme.css`. The one list: `Token` and the scene palette both come from it. */
export const TOKENS = [
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
] as const

export type Token = (typeof TOKENS)[number]

/**
 * Deep Field's values as sRGB hex: what the scene palette stands in before the
 * stylesheet is there (and in jsdom, which never loads it), and what `swatch`
 * falls back to where `color-mix()` does not exist. A test holds this table to
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
 * Whether this engine has `color-mix()`. iOS 15.5–16.1 does not, and an
 * inline colour it cannot parse is dropped, so the element would lose it.
 * Without a `CSS` object (SSR, jsdom) it is assumed there.
 */
const HAS_COLOR_MIX =
  typeof CSS === 'undefined' ||
  typeof CSS.supports !== 'function' ||
  CSS.supports('color', 'color-mix(in oklab, red 50%, transparent)')

/** `#rrggbb` plus `alpha` 0–1 as `#rrggbbaa`. */
export function hexWithAlpha(hex: string, alpha: number): string {
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
  return `${hex}${byte.toString(16).padStart(2, '0')}`
}

/**
 * A token at a strength. Where `color-mix()` is missing, a translucent one is
 * Deep Field's literal with the alpha applied: the colour themes do not reach
 * it there, as they do not reach Tailwind's own fallback for `/60`, but it
 * never disappears.
 */
export function swatch(token: Token, alpha = 1): string {
  return swatchIn(HAS_COLOR_MIX, token, alpha)
}

/** `swatch` for an engine that has `color-mix()` or not; exported for the test. */
export function swatchIn(colorMix: boolean, token: Token, alpha = 1): string {
  if (alpha >= 1) return `var(--color-${token})`
  if (!colorMix) return hexWithAlpha(DEEP_FIELD_FALLBACK[token], alpha)
  return `color-mix(in oklab, var(--color-${token}) ${+(alpha * 100).toFixed(2)}%, transparent)`
}
