/**
 * Features that ship in the DMG but are off unless turned on from a hidden
 * Settings section (adr: walkthrough-sits-behind-an-experimental-switch).
 * The section itself only appears once `EXPERIMENTAL_UNLOCKED_KEY` is set,
 * which the reveal chord toggles while Settings is open.
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
 * 2026-10-05-embedded-terminal-design § Behind an experimental switch). Off,
 * nothing of the terminal shows; shells already running keep running.
 */
export const TERMINAL_ENABLED_KEY = 'terminal_enabled'
/** Where the terminal sits: the dock under the map (48a) or the side slot (48b). */
export const TERMINAL_PLACEMENT_KEY = 'terminal_placement'
export const TERMINAL_CURSOR_KEY = 'terminal_cursor'
export const TERMINAL_CURSOR_BLINK_KEY = 'terminal_cursor_blink'

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
