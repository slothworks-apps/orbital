/**
 * Features that ship in the DMG but are off until turned on in Settings
 * (docs/why-orbital.md → Experimental, Labs, and out). Harness, Terminal
 * and Limit suns have left Labs for the regular settings, each still off
 * until turned on; Labs is listed only while it holds a feature.
 * Experimental holds work in progress (adr:
 * walkthrough-sits-behind-an-experimental-switch) and only appears once
 * `EXPERIMENTAL_UNLOCKED_KEY` is set, which the reveal chord toggles while
 * Settings is open.
 */

import type { KeyboardEventLike } from './keymap'

export const EXPERIMENTAL_UNLOCKED_KEY = 'experimental_unlocked'
export const WALKTHROUGH_ENABLED_KEY = 'walkthrough_enabled'
/** The model the narrate query asks (spec 2026-09-30-narrate-out-of-band-design § Settings › Experimental). */
export const NARRATE_MODEL_KEY = 'narrate_model'
/** Asks Orbital's sessions to say what they change and why, for Narrate to read. */
export const NARRATE_COMMENTARY_KEY = 'narrate_commentary'
/** What the server asks when `NARRATE_MODEL_KEY` is unset — mirrors `DEFAULT_NARRATE_MODEL` there. */
export const DEFAULT_NARRATE_MODEL = 'sonnet'
export const HARNESS_ENABLED_KEY = 'harness_enabled'
/**
 * Lets the Archipelago map theme be picked. Only Planets and Desk are kept
 * working as the app changes (adr: archipelago-sits-behind-an-experimental-switch).
 */
export const ARCHIPELAGO_ENABLED_KEY = 'archipelago_enabled'
/**
 * The user's own shells beside a session (spec
 * 2026-10-05-embedded-terminal-design § Behind an experimental switch; now
 * Settings → Terminal). Off, nothing of the terminal shows; shells already
 * running keep running.
 */
export const TERMINAL_ENABLED_KEY = 'terminal_enabled'
/** Where the terminal sits: the dock under the map (48a) or the side slot (48b). */
export const TERMINAL_PLACEMENT_KEY = 'terminal_placement'
export const TERMINAL_CURSOR_KEY = 'terminal_cursor'
export const TERMINAL_CURSOR_BLINK_KEY = 'terminal_cursor_blink'
/**
 * One sun per Claude account on the map, dimming as its plan's usage runs
 * out (spec 2026-10-20-limit-suns-design § 4; Settings → Appearance). Off, the map draws none.
 */
export const LIMIT_SUNS_ENABLED_KEY = 'limit_suns_enabled'
/** Where each sun sits: JSON, account key to map coordinates. The server's default is `{}`. */
export const LIMIT_SUN_POSITIONS_KEY = 'map_limit_sun_positions'
/** The suns' style, `eclipse` (the server's default) or `dim` (canvas 60e). */
export const LIMIT_SUN_STYLE_KEY = 'map_limit_sun_style'
/** Each account's star colour: JSON, account key to colour name. The server's default is `{}`. */
export const LIMIT_SUN_COLORS_KEY = 'map_limit_sun_colors'

/**
 * The most orbits a planet's moons share (spec 2026-10-21-moon-orbit-limit-design).
 * The limit is on for everyone; only the number sits in Experimental.
 */
export const MOON_ORBITS_KEY = 'map_moon_orbits'
export const MOON_ORBITS_DEFAULT = 3
export const MOON_ORBITS_MIN = 1
export const MOON_ORBITS_MAX = 8

export type TerminalPlacement = 'dock' | 'side'
export type TerminalCursor = 'block' | 'bar' | 'underline'

type Settings = Record<string, string | undefined>

export function experimentalUnlocked(settings: Settings): boolean {
  return settings[EXPERIMENTAL_UNLOCKED_KEY] === 'true'
}

export function walkthroughEnabled(settings: Settings): boolean {
  return settings[WALKTHROUGH_ENABLED_KEY] === 'true'
}

export function narrateModel(settings: Settings): string {
  return settings[NARRATE_MODEL_KEY] || DEFAULT_NARRATE_MODEL
}

export function narrateCommentary(settings: Settings): boolean {
  return settings[NARRATE_COMMENTARY_KEY] === 'true'
}

export function harnessEnabled(settings: Settings): boolean {
  return settings[HARNESS_ENABLED_KEY] === 'true'
}

export function archipelagoEnabled(settings: Settings): boolean {
  return settings[ARCHIPELAGO_ENABLED_KEY] === 'true'
}

export function terminalEnabled(settings: Settings): boolean {
  return settings[TERMINAL_ENABLED_KEY] === 'true'
}

export function limitSunsEnabled(settings: Settings): boolean {
  return settings[LIMIT_SUNS_ENABLED_KEY] === 'true'
}

/** The stored limit as a whole number in the slider's range, the default when unset or unparsable. */
export function moonOrbits(settings: Settings): number {
  const stored = settings[MOON_ORBITS_KEY]
  const raw = Number(stored)
  if (!stored || !Number.isFinite(raw)) return MOON_ORBITS_DEFAULT
  return Math.min(MOON_ORBITS_MAX, Math.max(MOON_ORBITS_MIN, Math.round(raw)))
}

/** The dock unless the side panel was picked. */
export function terminalPlacement(settings: Settings): TerminalPlacement {
  return settings[TERMINAL_PLACEMENT_KEY] === 'side' ? 'side' : 'dock'
}

/** A steady block unless the user picked otherwise (48f). */
export function terminalCursor(settings: Settings): TerminalCursor {
  const value = settings[TERMINAL_CURSOR_KEY]
  return value === 'bar' || value === 'underline' ? value : 'block'
}

export function terminalCursorBlink(settings: Settings): boolean {
  return settings[TERMINAL_CURSOR_BLINK_KEY] === 'true'
}

/**
 * ⌘⇧. — Finder's own "show hidden files". Matched on `e.code`: on a Czech
 * layout Shift+. prints `:`, so `e.key` would never read `.` here. Kept out
 * of the keymap on purpose, so the Shortcuts pane does not list it.
 */
export function isRevealChord(e: KeyboardEventLike): boolean {
  return e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'Period'
}
