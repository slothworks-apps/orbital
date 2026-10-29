/**
 * A palette token as a CSS colour, for inline styles and SVG attributes —
 * the `style` twin of a Tailwind class like `text-ink-900/60`. The value is
 * a `var()`, so it follows the active colour theme (spec
 * 2026-10-29-colour-tokens-design). Not for three.js, canvas 2D or xterm,
 * which cannot resolve CSS variables.
 */
export type Token =
  | 'space'
  | 'space-deep'
  | 'shade'
  | 'panel'
  | 'panel-solid'
  | 'raised'
  | 'line'
  | 'ink-50'
  | 'ink-100'
  | 'ink-200'
  | 'ink-300'
  | 'ink-400'
  | 'ink-500'
  | 'ink-600'
  | 'ink-700'
  | 'ink-800'
  | 'ink-900'
  | 'accent'
  | 'sky'
  | 'sky-soft'
  | 'warning'
  | 'warning-soft'
  | 'warning-deep'
  | 'success'
  | 'danger'
  | 'danger-soft'
  | 'danger-pale'
  | 'shadow'
  | 'highlight'
  | 'nebula-a'
  | 'nebula-b'
  | 'star'

export function swatch(token: Token, alpha = 1): string {
  if (alpha >= 1) return `var(--color-${token})`
  return `color-mix(in oklab, var(--color-${token}) ${+(alpha * 100).toFixed(2)}%, transparent)`
}
