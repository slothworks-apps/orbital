import { SystemBars, SystemBarsStyle } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { create } from 'zustand'
import {
  DEFAULT_COLOUR_THEME,
  DEFAULT_LIGHT_COLOUR_THEME,
  applyColourTheme,
  colourThemeById,
  knownColourTheme,
  knownColourThemeOfKind,
  onSystemAppearanceChange,
  resolveColourTheme,
  systemPrefersDark,
  type ColourChoice,
  type ColourThemeKind,
} from '../../lib/colourTheme'
import { prefersReducedMotion } from '../../ui/usePresence'

/**
 * The phone's colour theme (canvas `Feature - Colour themes` 1k, spec
 * 2026-10-29-colour-tokens-design). The phone keeps its own choice on the
 * phone, as it keeps its app lock: pairing does not copy the Mac's, and
 * nothing syncs either way. Outside the cache prefix, so forgetting a Mac
 * keeps it; a phone that never chose has no row and paints Deep Field.
 */
export const COLOUR_CHOICE_PREF = 'orbital.colours'

/**
 * The theme the phone last painted, in the WebView's own storage, which reads
 * synchronously: `main.tsx` paints in it before anything renders, the restart
 * frame included, while `COLOUR_CHOICE_PREF` is still being read. A copy only;
 * the preference is what counts.
 */
export const PAINTED_COLOUR_THEME_KEY = 'orbital.phoneColourTheme'

/** How long a change of theme crossfades, so nothing flashes (canvas 1k). */
export const COLOUR_CROSSFADE_MS = 240

export const DEFAULT_COLOUR_CHOICE: ColourChoice = {
  theme: DEFAULT_COLOUR_THEME,
  followSystem: false,
  light: DEFAULT_LIGHT_COLOUR_THEME,
  dark: DEFAULT_COLOUR_THEME,
}

/** The stored choice, field by field: what cannot be read falls back on its own and leaves the rest. */
export function parseColourChoice(raw: string | null): ColourChoice {
  if (!raw) return DEFAULT_COLOUR_CHOICE
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return DEFAULT_COLOUR_CHOICE
  }
  if (typeof value !== 'object' || value === null) return DEFAULT_COLOUR_CHOICE
  const v = value as Record<string, unknown>
  return {
    theme: knownColourTheme(typeof v.theme === 'string' ? v.theme : null, DEFAULT_COLOUR_THEME),
    followSystem: v.followSystem === true,
    light: knownColourThemeOfKind(v.light, 'light', DEFAULT_LIGHT_COLOUR_THEME),
    dark: knownColourThemeOfKind(v.dark, 'dark', DEFAULT_COLOUR_THEME),
  }
}

export function serializeColourChoice(choice: ColourChoice): string {
  return JSON.stringify(choice)
}

/** Which of the choice's slots a picker writes: the one theme, or one OS appearance's while following it. */
export type ColourSlot = 'theme' | ColourThemeKind

type PhoneColours = {
  choice: ColourChoice
  /** What the phone paints with now. */
  painted: string
}

export const usePhoneColours = create<PhoneColours>()(() => ({
  choice: DEFAULT_COLOUR_CHOICE,
  painted: DEFAULT_COLOUR_THEME,
}))

let fadeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Paints the root in `id`. `fade`: through `data-colours-fading`, which
 * `mobile.css` turns into a short transition of every colour, so a switch
 * crossfades rather than flashing; never under reduced motion.
 */
function paint(id: string, fade: boolean): void {
  const root = document.documentElement
  if (fade && !prefersReducedMotion()) {
    root.style.setProperty('--colours-fade', `${COLOUR_CROSSFADE_MS}ms`)
    root.dataset.coloursFading = ''
    if (fadeTimer) clearTimeout(fadeTimer)
    fadeTimer = setTimeout(() => {
      delete root.dataset.coloursFading
      root.style.removeProperty('--colours-fade')
      fadeTimer = null
    }, COLOUR_CROSSFADE_MS)
  }
  applyColourTheme(root, id)
  paintStatusBar(id)
  try {
    localStorage.setItem(PAINTED_COLOUR_THEME_KEY, id)
  } catch {
    // The preference still holds it; the next start paints Deep Field a moment longer.
  }
}

/**
 * The system's status bar follows the theme: dark icons on a light theme,
 * light ones on a dark theme. `SystemBars` is part of Capacitor's core, so
 * every shell has it and a bundle carries the change. On Android the page
 * draws edge-to-edge, so the bar shows the page's own space behind it.
 */
function paintStatusBar(id: string): void {
  const theme = colourThemeById(id)
  if (!theme) return
  // `SystemBarsStyle.Light` is the style for a light background: dark icons.
  const style = theme.kind === 'light' ? SystemBarsStyle.Light : SystemBarsStyle.Dark
  void SystemBars.setStyle({ style }).catch(() => {})
}

function repaint(fade: boolean): void {
  const theme = resolveColourTheme(usePhoneColours.getState().choice, systemPrefersDark())
  if (theme === usePhoneColours.getState().painted) return
  usePhoneColours.setState({ painted: theme })
  paint(theme, fade)
}

/** Synchronous, before the first render: the theme painted last time. */
export function paintLastColourTheme(): void {
  let last: string | null = null
  try {
    last = localStorage.getItem(PAINTED_COLOUR_THEME_KEY)
  } catch {
    // No storage: Deep Field until the preference is read.
  }
  const theme = knownColourTheme(last, DEFAULT_COLOUR_THEME)
  usePhoneColours.setState({ painted: theme })
  paint(theme, false)
}

let unwatch: (() => void) | null = null

/**
 * Reads the stored choice and paints it, then follows the OS while the
 * choice says so. Called once at startup, before the first screen.
 */
export async function loadPhoneColours(): Promise<void> {
  try {
    const { value } = await Preferences.get({ key: COLOUR_CHOICE_PREF })
    usePhoneColours.setState({ choice: parseColourChoice(value) })
  } catch (err) {
    console.warn('[mobile] could not read the colour theme', err)
  }
  repaint(false)
  unwatch?.()
  // Always listening: the choice decides whether the OS matters, so turning
  // Follow the system on needs no new listener.
  unwatch = onSystemAppearanceChange(() => repaint(true))
}

/** A change made in Settings: painted at once, with the crossfade, then stored. */
export async function setPhoneColours(patch: Partial<ColourChoice>): Promise<void> {
  const choice = { ...usePhoneColours.getState().choice, ...patch }
  usePhoneColours.setState({ choice })
  repaint(true)
  try {
    await Preferences.set({ key: COLOUR_CHOICE_PREF, value: serializeColourChoice(choice) })
  } catch (err) {
    console.warn('[mobile] could not store the colour theme', err)
  }
}
