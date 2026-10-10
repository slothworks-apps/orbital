import type { KeyboardEventLike } from '../lib/keymap'

/**
 * The keys a focused terminal hands back to Orbital (spec
 * 2026-10-05-embedded-terminal-design § Keys). The same names travel from
 * Electron's main process, which catches them ahead of the menu
 * (`desktop/src/lib/terminalKeys.ts` decides the same chords there).
 */
export type TerminalChord = 'new-tab' | 'close-tab' | `tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`

const TAB_CHORD = /^tab-([1-9])$/

/** A chord name that came over IPC, or null for anything else. */
export function parseTerminalChord(value: unknown): TerminalChord | null {
  if (value === 'new-tab' || value === 'close-tab') return value
  if (typeof value === 'string' && TAB_CHORD.test(value)) return value as TerminalChord
  return null
}

/** The 1-based tab a `tab-N` chord picks, or null for the other chords. */
export function chordTabIndex(chord: TerminalChord): number | null {
  const match = TAB_CHORD.exec(chord)
  return match ? Number(match[1]) : null
}

/**
 * ⌘T, ⌘W and ⌘1–9 as a focused terminal reads them in a browser, where no
 * main process catches them first. Letters by character, digits by position,
 * as the keymap binds them (its rule 2).
 */
export function terminalChordOf(e: KeyboardEventLike): TerminalChord | null {
  if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  const key = e.key.toLowerCase()
  if (key === 't') return 'new-tab'
  if (key === 'w') return 'close-tab'
  const digit = /^Digit([1-9])$/.exec(e.code)
  return digit ? (`tab-${digit[1]}` as TerminalChord) : null
}
