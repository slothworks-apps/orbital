/**
 * Colour themes (spec 2026-10-29-colour-tokens-design, canvas `Feature -
 * Colour themes`). A theme replaces the palette's token values and nothing
 * else: `theme.css` holds one `:root[data-colours='<id>']` block per theme,
 * and Deep Field, the default, is the `@theme` itself, so it carries no
 * attribute at all.
 *
 * On the Mac the choice is a setting, offered in Appearance while Labs →
 * Colour themes is on. The phone keeps its own choice on the phone
 * (`mobile/platform/colourTheme.ts`); nothing syncs between them.
 */

type Settings = Record<string, string | undefined>

export type ColourThemeKind = 'dark' | 'light'

export type ColourTheme = {
  id: string
  name: string
  kind: ColourThemeKind
  /** The editor palette it is after, shown beside the name (1f). */
  after: string | null
  /** space · panel · accent, the picker's three dots (1f). */
  swatch: readonly [string, string, string]
}

export const DEFAULT_COLOUR_THEME = 'deep-field'
/** What Follow the system takes while the OS is in light mode, unless set (1f, 1k). */
export const DEFAULT_LIGHT_COLOUR_THEME = 'albedo'

/** In the picker's order: dark first, then light (1f). */
export const COLOUR_THEMES: readonly ColourTheme[] = [
  { id: 'deep-field', name: 'Deep Field', kind: 'dark', after: null, swatch: ['#05070d', '#0a101c', '#59e4f3'] },
  { id: 'event-horizon', name: 'Event Horizon', kind: 'dark', after: null, swatch: ['#000101', '#030508', '#35eeff'] },
  { id: 'solar-dark', name: 'Solar Dark', kind: 'dark', after: 'Solarized Dark', swatch: ['#00242f', '#002c37', '#4fa6e9'] },
  { id: 'molten', name: 'Molten', kind: 'dark', after: 'Monokai', swatch: ['#1a1b16', '#262722', '#6addf7'] },
  { id: 'velvet', name: 'Velvet', kind: 'dark', after: 'Dracula', swatch: ['#1d1e29', '#292a35', '#c4a4fe'] },
  { id: 'arctic', name: 'Arctic', kind: 'dark', after: 'Nord', swatch: ['#222630', '#2e333d', '#88cada'] },
  { id: 'ember', name: 'Ember', kind: 'dark', after: 'Gruvbox', swatch: ['#1e1c1b', '#2b2826', '#7abfc3'] },
  { id: 'slate', name: 'Slate', kind: 'dark', after: 'One Dark', swatch: ['#1e2229', '#292e38', '#5db2f7'] },
  { id: 'albedo', name: 'Albedo', kind: 'light', after: null, swatch: ['#eff4f8', '#fbfdff', '#00677a'] },
  { id: 'solar-light', name: 'Solar Light', kind: 'light', after: 'Solarized Light', swatch: ['#f0e7d2', '#fcf5e3', '#0062a1'] },
]

export function colourThemeById(id: string | null | undefined): ColourTheme | null {
  return COLOUR_THEMES.find((theme) => theme.id === id) ?? null
}

/** The themes of one kind, for a picker filtered to light or dark (1k C). */
export function colourThemesOfKind(kind: ColourThemeKind): ColourTheme[] {
  return COLOUR_THEMES.filter((theme) => theme.kind === kind)
}

/** A stored id, or the fallback for a missing, unknown or removed one. */
export function knownColourTheme(raw: string | null | undefined, fallback: string): string {
  return colourThemeById(raw)?.id ?? fallback
}

/** A stored id for a slot of one kind: anything unknown, removed or of the other kind is the fallback. */
export function knownColourThemeOfKind(raw: unknown, kind: ColourThemeKind, fallback: string): string {
  const theme = typeof raw === 'string' ? colourThemeById(raw) : null
  return theme && theme.kind === kind ? theme.id : fallback
}

/** A picker's group headings, by kind (1f, 1k B). */
export const COLOUR_THEME_KIND_LABEL: Record<ColourThemeKind, string> = { dark: 'DARK', light: 'LIGHT' }

/** What a picker says beside a theme's name (1f, 1k B): the editor palette it is after; Deep Field is the default. */
export function colourThemeInspiration(theme: ColourTheme): string | null {
  if (theme.after) return `after ${theme.after}`
  return theme.id === DEFAULT_COLOUR_THEME ? 'default' : null
}

/** What a device has chosen: one theme, or one per OS appearance while following it. */
export type ColourChoice = { theme: string; followSystem: boolean; light: string; dark: string }

/** The theme a choice paints with, given whether the OS is in dark mode. */
export function resolveColourTheme(choice: ColourChoice, systemDark: boolean): string {
  if (!choice.followSystem) return knownColourTheme(choice.theme, DEFAULT_COLOUR_THEME)
  return systemDark
    ? knownColourTheme(choice.dark, DEFAULT_COLOUR_THEME)
    : knownColourTheme(choice.light, DEFAULT_LIGHT_COLOUR_THEME)
}

/* The Mac's settings. The Labs switch gates the whole feature: while it is
   off the app paints Deep Field whatever else is stored. */
export const COLOUR_THEMES_ENABLED_KEY = 'colour_themes_enabled'
export const COLOUR_THEME_KEY = 'colour_theme'
export const COLOUR_THEME_FOLLOW_SYSTEM_KEY = 'colour_theme_follow_system'
/** Following the system: the theme for macOS's Light mode, and the one for its Dark mode. */
export const COLOUR_THEME_LIGHT_KEY = 'colour_theme_light'
export const COLOUR_THEME_DARK_KEY = 'colour_theme_dark'

export function colourThemesEnabled(settings: Settings): boolean {
  return settings[COLOUR_THEMES_ENABLED_KEY] === 'true'
}

/**
 * The Mac's choice, as the phone's. Following the system, each appearance
 * takes its own theme; until one is picked, light mode takes Albedo and dark
 * mode the one theme chosen before, if it is a dark one, or Deep Field.
 */
export function macColourChoice(settings: Settings): ColourChoice {
  const theme = knownColourTheme(settings[COLOUR_THEME_KEY], DEFAULT_COLOUR_THEME)
  return {
    theme,
    followSystem: settings[COLOUR_THEME_FOLLOW_SYSTEM_KEY] === 'true',
    light: knownColourThemeOfKind(settings[COLOUR_THEME_LIGHT_KEY], 'light', DEFAULT_LIGHT_COLOUR_THEME),
    dark: knownColourThemeOfKind(
      settings[COLOUR_THEME_DARK_KEY],
      'dark',
      knownColourThemeOfKind(theme, 'dark', DEFAULT_COLOUR_THEME),
    ),
  }
}

/** The theme the Mac paints with now. */
export function macColourTheme(settings: Settings, systemDark: boolean): string {
  if (!colourThemesEnabled(settings)) return DEFAULT_COLOUR_THEME
  return resolveColourTheme(macColourChoice(settings), systemDark)
}

/**
 * Paints `root` in a theme. Deep Field is the stylesheet's own palette, so it
 * drops the attribute. `color-scheme` follows the theme's kind, so native
 * parts of fields (caret, autofill, spelling menus) match it.
 */
export function applyColourTheme(root: HTMLElement, id: string): void {
  const known = knownColourTheme(id, DEFAULT_COLOUR_THEME)
  if (known === DEFAULT_COLOUR_THEME) delete root.dataset.colours
  else root.dataset.colours = known
  root.style.colorScheme = colourThemeById(known)?.kind ?? 'dark'
}

/**
 * A resolved token as `#rrggbb`, painted on a 1×1 canvas so an oklch() or a
 * var() value comes out as sRGB. Null where there is no canvas (jsdom).
 */
export function resolvedTokenHex(root: HTMLElement, token: string): string | null {
  const value = getComputedStyle(root).getPropertyValue(`--color-${token}`).trim()
  if (!value) return null
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = value
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/**
 * The last theme a window painted, kept so the next load paints in it before
 * settings arrive, and so pages that never load settings and other windows
 * follow through the `storage` event, as text size does.
 */
export const COLOUR_THEME_STORAGE_KEY = 'orbital.colourTheme'

/** Whether the OS is in dark mode now. */
export function systemPrefersDark(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Calls `onChange` whenever the OS switches between light and dark. */
export function onSystemAppearanceChange(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
