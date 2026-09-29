/**
 * Features that ship in the DMG but are off unless turned on from a hidden
 * Settings section (adr: walkthrough-sits-behind-an-experimental-switch).
 * The section itself only appears once `EXPERIMENTAL_UNLOCKED_KEY` is set,
 * which the reveal chord toggles while Settings is open.
 */

import type { KeyboardEventLike } from './keymap'

export const EXPERIMENTAL_UNLOCKED_KEY = 'experimental_unlocked'
export const WALKTHROUGH_ENABLED_KEY = 'walkthrough_enabled'

type Settings = Record<string, string | undefined>

export function experimentalUnlocked(settings: Settings): boolean {
  return settings[EXPERIMENTAL_UNLOCKED_KEY] === 'true'
}

export function walkthroughEnabled(settings: Settings): boolean {
  return settings[WALKTHROUGH_ENABLED_KEY] === 'true'
}

/**
 * ⌘⇧. — Finder's own "show hidden files". Matched on `e.code`: on a Czech
 * layout Shift+. prints `:`, so `e.key` would never read `.` here. Kept out
 * of the keymap on purpose, so the Shortcuts pane does not list it.
 */
export function isRevealChord(e: KeyboardEventLike): boolean {
  return e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'Period'
}
