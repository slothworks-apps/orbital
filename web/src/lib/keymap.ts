/**
 * The keymap: every keyboard shortcut Orbital knows, declared once (spec:
 * 2026-09-23-shortcuts-design § 2, § 3). Pure module, no React, no DOM
 * beyond `KeyboardEvent`'s shape — the dispatcher, the Electron menu and the
 * Settings pane (later tasks) all read from `COMMANDS` rather than each
 * hard-coding its own chords.
 *
 * Rule 2 (letters bind by character, digits by position): ⌘ does not change
 * the character a key produces, so a letter chord is matched on `e.key`
 * (lower-cased) and a digit chord on `e.code`, which is what keeps ⌘1 on
 * the physical "1" key on a Czech layout, where Shift-less digits print
 * `+ ě š č ř ž ý á í é`.
 */

import type { MenuCommand } from './desktop'

export type Scope = 'global' | 'map' | 'session' | 'composer' | 'dialogs' | 'files'

/** 'meta+shift+n', 'ctrl+shift+Tab', 'meta+Digit2', 'meta+,', 'Enter', 'alt+Enter' */
export type Chord = string

export type Modifier = 'meta' | 'shift' | 'alt' | 'ctrl'

export type KeyboardEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>

export interface Command {
  id: string
  label: string
  scope: Scope
  /** [0] is primary; any further chord prints muted after `/` in the pane. */
  chords: Chord[]
  /** The caps to print instead of the chords, one string per cap (rule: `dialogs.pick`'s nine digits). */
  display?: string[]
  /** The pane's small line under the label. */
  note?: string
  whileTyping: boolean
  /** Where it appears in the Electron menu, if anywhere. */
  menu?: { menu: 'File' | 'Session' | 'View' | 'Window'; order: number }
  /**
   * Display-only rows: the key is handled by a component with `matches` or
   * `digitFromEvent` directly (composer ⏎, dialog ⏎, question digits) or by
   * the escape layer. The dispatcher never fires these.
   */
  local?: true
  /** A pointer gesture drawn as a dashed cap, e.g. '⌥-click'. */
  gesture?: string
}

export const SCOPES: readonly { scope: Scope; title: string; when: string }[] = [
  { scope: 'global', title: 'GLOBAL', when: 'anywhere in the app' },
  { scope: 'map', title: 'MAP', when: 'nothing selected, focus on the canvas' },
  { scope: 'session', title: 'SESSION', when: 'a session is selected' },
  { scope: 'composer', title: 'COMPOSER', when: 'caret in the input' },
  { scope: 'dialogs', title: 'DIALOGS & CARDS', when: 'a dialog or a question is up' },
  { scope: 'files', title: 'FILES', when: 'a file is open' },
]

export const COMMANDS: readonly Command[] = [
  {
    id: 'global.new-session',
    label: 'New session',
    scope: 'global',
    chords: ['meta+n'],
    whileTyping: true,
    menu: { menu: 'File', order: 1 },
  },
  {
    id: 'global.search',
    label: 'Search sessions',
    scope: 'global',
    chords: ['meta+k'],
    whileTyping: true,
    menu: { menu: 'View', order: 3 },
  },
  {
    id: 'global.sidebar',
    label: 'Toggle sidebar',
    scope: 'global',
    chords: ['meta+b'],
    whileTyping: true,
    menu: { menu: 'View', order: 2 },
  },
  {
    id: 'global.settings',
    label: 'Settings',
    scope: 'global',
    chords: ['meta+,'],
    whileTyping: true,
  },
  {
    id: 'global.errors',
    label: 'Error log',
    scope: 'global',
    chords: ['meta+shift+e'],
    whileTyping: true,
    menu: { menu: 'View', order: 4 },
  },
  {
    id: 'global.map',
    label: 'Map',
    scope: 'global',
    chords: ['meta+Digit1'],
    whileTyping: true,
    menu: { menu: 'Window', order: 1 },
  },
  {
    id: 'global.stats',
    label: 'Stats',
    scope: 'global',
    chords: ['meta+Digit2'],
    whileTyping: true,
    menu: { menu: 'Window', order: 2 },
  },
  {
    id: 'global.up',
    label: 'Up one level',
    scope: 'global',
    chords: ['meta+ArrowUp'],
    whileTyping: false,
    note: 'the parent crumb of the page bar',
  },
  {
    id: 'global.next-session',
    label: 'Next session',
    scope: 'global',
    chords: ['ctrl+Tab'],
    whileTyping: true,
    menu: { menu: 'Window', order: 3 },
    note: 'sidebar order, wraps',
  },
  {
    id: 'global.previous-session',
    label: 'Previous session',
    scope: 'global',
    chords: ['ctrl+shift+Tab'],
    whileTyping: true,
    menu: { menu: 'Window', order: 4 },
  },
  {
    id: 'global.next-needs-input',
    label: 'Next session needing input',
    scope: 'global',
    chords: ['meta+j'],
    whileTyping: true,
    menu: { menu: 'Window', order: 5 },
    note: 'wraps · nothing when none is waiting',
  },
  {
    id: 'map.fit',
    label: 'Fit the map',
    scope: 'map',
    chords: ['meta+f'],
    whileTyping: true,
    menu: { menu: 'View', order: 1 },
  },
  {
    id: 'map.deselect',
    label: 'Deselect',
    scope: 'map',
    chords: ['Escape'],
    whileTyping: false,
    local: true,
  },
  {
    id: 'session.interrupt',
    label: 'Interrupt the run',
    scope: 'session',
    chords: ['meta+.'],
    whileTyping: false,
    menu: { menu: 'Session', order: 1 },
  },
  {
    id: 'session.clear',
    label: 'Clear and start over',
    scope: 'session',
    chords: ['meta+shift+n'],
    whileTyping: true,
    menu: { menu: 'Session', order: 2 },
    note: 'asks first unless Confirm before Clear is off',
  },
  {
    id: 'session.end',
    label: 'End session',
    scope: 'session',
    chords: ['meta+Backspace'],
    whileTyping: false,
    menu: { menu: 'Session', order: 3 },
    note: 'asks first',
  },
  {
    id: 'session.pin',
    label: 'Pin / unpin',
    scope: 'session',
    chords: ['meta+p'],
    whileTyping: true,
    menu: { menu: 'Session', order: 4 },
  },
  {
    id: 'session.tag',
    label: 'Change tag',
    scope: 'session',
    chords: ['meta+t'],
    whileTyping: true,
    menu: { menu: 'Session', order: 5 },
    note: 'opens the tag list · arrows or typing pick',
  },
  {
    id: 'session.model',
    label: 'Switch model',
    scope: 'session',
    chords: ['meta+shift+m'],
    whileTyping: true,
    menu: { menu: 'Session', order: 6 },
  },
  {
    id: 'session.detach',
    label: 'Open in new window',
    scope: 'session',
    chords: ['meta+shift+d'],
    whileTyping: true,
    menu: { menu: 'Session', order: 7 },
    note: 'desktop app only',
  },
  {
    id: 'composer.send',
    label: 'Send',
    scope: 'composer',
    chords: ['Enter'],
    whileTyping: true,
    local: true,
  },
  {
    id: 'composer.newline',
    label: 'Newline',
    scope: 'composer',
    chords: ['shift+Enter'],
    whileTyping: true,
    local: true,
  },
  {
    id: 'composer.start',
    label: 'Start session',
    scope: 'composer',
    chords: ['meta+Enter'],
    whileTyping: true,
    local: true,
    note: 'new-session dialog',
  },
  {
    id: 'dialogs.confirm',
    label: 'Confirm',
    scope: 'dialogs',
    chords: ['Enter'],
    whileTyping: true,
    local: true,
  },
  {
    id: 'dialogs.close',
    label: 'Close · step back',
    scope: 'dialogs',
    chords: ['Escape'],
    whileTyping: true,
    local: true,
    note: 'never ends a running session',
  },
  {
    id: 'dialogs.pick',
    label: 'Pick an answer',
    scope: 'dialogs',
    chords: [
      'Digit1',
      'Digit2',
      'Digit3',
      'Digit4',
      'Digit5',
      'Digit6',
      'Digit7',
      'Digit8',
      'Digit9',
    ],
    display: ['1–9'],
    whileTyping: true,
    local: true,
  },
  {
    id: 'dialogs.move',
    label: 'Move between answers',
    scope: 'dialogs',
    chords: ['ArrowUp', 'ArrowDown'],
    display: ['↑ ↓'],
    whileTyping: true,
    local: true,
  },
  {
    id: 'files.open-in-ide',
    label: 'Open in IDE',
    scope: 'files',
    chords: ['alt+Enter'],
    whileTyping: true,
    local: true,
    note: 'file viewer',
  },
  {
    id: 'files.open-path-in-ide',
    label: 'Open path in IDE',
    scope: 'files',
    chords: [],
    whileTyping: true,
    local: true,
    gesture: '⌥-click',
  },
]

const MODIFIERS: readonly Modifier[] = ['meta', 'shift', 'alt', 'ctrl']

/** Splits a chord string into its modifier set and key part; order in the string does not matter. */
export function parseChord(chord: Chord): { mods: Set<Modifier>; key: string } {
  const parts = chord.split('+')
  const key = parts[parts.length - 1]
  const mods = new Set<Modifier>()
  for (const part of parts.slice(0, -1)) {
    if (!(MODIFIERS as readonly string[]).includes(part)) {
      throw new Error(`Unknown modifier "${part}" in chord "${chord}"`)
    }
    mods.add(part as Modifier)
  }
  return { mods, key }
}

/**
 * `navigator.platform` / `userAgentData` sniffing, done once at module load.
 * Tests never rely on this — they pass `isMac` explicitly to `matches`.
 */
function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData
  const platform = uaData?.platform ?? navigator.platform ?? ''
  return platform.toLowerCase().includes('mac')
}

const IS_MAC = detectMac()

/**
 * The chord-vocabulary modifiers actually held down, given the platform.
 * `meta` reads `e.metaKey` on macOS and `e.ctrlKey` elsewhere (rule 2: Ctrl+N
 * is caret-down in a macOS text field, so ⌃ never stands in for ⌘ there) —
 * `ctrl` only exists as its own chord modifier on macOS, where it is used
 * for ⌃⇥ session cycling.
 */
function eventModifiers(e: KeyboardEventLike, isMac: boolean): Set<Modifier> {
  const mods = new Set<Modifier>()
  if (e.shiftKey) mods.add('shift')
  if (e.altKey) mods.add('alt')
  if (isMac) {
    if (e.metaKey) mods.add('meta')
    if (e.ctrlKey) mods.add('ctrl')
  } else if (e.ctrlKey) {
    mods.add('meta')
  }
  return mods
}

/** A `DigitN` key part. */
const DIGIT_KEY = /^Digit([0-9])$/

/** The digit `DigitN` names, or null when the key part isn't one. */
function digitOf(key: string): string | null {
  const match = DIGIT_KEY.exec(key)
  return match ? match[1] : null
}

/** A single letter upper-cased; `,` and `.` print as themselves. */
function letterOrPunctuation(key: string): string {
  return /[a-z]/i.test(key) ? key.toUpperCase() : key
}

function keyMatches(key: string, e: KeyboardEventLike): boolean {
  if (DIGIT_KEY.test(key)) return e.code === key
  if (key.length === 1) return e.key.toLowerCase() === key.toLowerCase()
  return e.key === key
}

/**
 * Whether `e` fires `chord`. The event's modifier set must equal the
 * chord's exactly — an extra modifier held down is a miss, which is also
 * what makes rule 2's macOS `ctrl` requirement (`!e.metaKey`) true without a
 * special case: holding Cmd too adds `meta` to the event's set, and a chord
 * asking only for `ctrl` no longer matches it.
 */
export function matches(chord: Chord, e: KeyboardEventLike, opts: { isMac?: boolean } = {}): boolean {
  const isMac = opts.isMac ?? IS_MAC
  const { mods, key } = parseChord(chord)
  const eventMods = eventModifiers(e, isMac)
  if (mods.size !== eventMods.size) return false
  for (const mod of mods) {
    if (!eventMods.has(mod)) return false
  }
  return keyMatches(key, e)
}

/**
 * `e.code` `Digit1`…`Digit9` or `Numpad1`…`Numpad9` → 1…9, else null. The
 * numpad's keys are positions too, and they print digits on every layout.
 * Modifiers are not checked here — the caller decides.
 */
export function digitFromEvent(e: KeyboardEventLike): number | null {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
  return match ? Number(match[1]) : null
}

/** True while focus sits in a text input/textarea/contenteditable — global shortcuts should not fire there. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

/**
 * Modifier print order, macOS convention: Control, Option, Command, Shift
 * (`⌘⇧N`, not `⇧⌘N`) — spec § 2's own table (⌘⇧N, ⌘⇧E, ⌘⇧M, ⌘⇧D) and the
 * design canvas ("⌘ ⇧ N" as one cap) are the authority for this order.
 */
const GLYPH_MODIFIER_ORDER: readonly Modifier[] = ['ctrl', 'alt', 'meta', 'shift']

const MODIFIER_GLYPHS: Record<Modifier, string> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  meta: '⌘',
}

const NAMED_KEY_GLYPHS: Record<string, string> = {
  Enter: '⏎',
  Backspace: '⌫',
  Tab: '⇥',
  ' ': '␣',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Escape: 'esc',
}

function keyGlyph(key: string): string {
  const named = NAMED_KEY_GLYPHS[key]
  if (named) return named
  const digit = digitOf(key)
  if (digit) return digit
  if (key.length === 1) return letterOrPunctuation(key)
  return key
}

/** 'meta+shift+n' → ['⌘','⇧','N'] */
export function chordGlyphs(chord: Chord): string[] {
  const { mods, key } = parseChord(chord)
  const glyphs: string[] = []
  for (const mod of GLYPH_MODIFIER_ORDER) {
    if (mods.has(mod)) glyphs.push(MODIFIER_GLYPHS[mod])
  }
  glyphs.push(keyGlyph(key))
  return glyphs
}

/** '⌘⇧N' — for keycap hints in the UI. */
export function chordLabel(chord: Chord): string {
  return chordGlyphs(chord).join('')
}

/**
 * The primary chord of a command as a keycap hint ('⌘⇧N'), for the tooltip
 * or title of the control that triggers it. Going through `command` means a
 * hint can only name a binding the app listens for.
 */
export function shortcutLabel(id: string): string {
  return chordLabel(command(id).chords[0])
}

/** Electron accelerator modifier order: CmdOrCtrl/Ctrl, then Alt, then Shift, then the key. */
const ACCELERATOR_MODIFIER_ORDER: readonly Modifier[] = ['meta', 'ctrl', 'alt', 'shift']

const ACCELERATOR_MODIFIERS: Record<Modifier, string> = {
  meta: 'CmdOrCtrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
}

const NAMED_ACCELERATOR_KEYS: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
}

function acceleratorKey(key: string): string {
  const named = NAMED_ACCELERATOR_KEYS[key]
  if (named) return named
  const digit = digitOf(key)
  if (digit) return digit
  if (key.length === 1) return letterOrPunctuation(key)
  return key
}

/** 'meta+shift+n' → 'CmdOrCtrl+Shift+N' — Electron accelerator syntax. */
export function accelerator(chord: Chord): string {
  const { mods, key } = parseChord(chord)
  const parts: string[] = []
  for (const mod of ACCELERATOR_MODIFIER_ORDER) {
    if (mods.has(mod)) parts.push(ACCELERATOR_MODIFIERS[mod])
  }
  parts.push(acceleratorKey(key))
  return parts.join('+')
}

/** Menu-bar order, which is also the order `menuCommands` sorts by. */
const MENU_ORDER: readonly MenuCommand['menu'][] = ['File', 'Session', 'View', 'Window']

/**
 * The commands the desktop app's menu lists, as the main window sends them to
 * main (spec: 2026-09-23-shortcuts-design § 5): every command with a `menu`,
 * on its primary chord, sorted by menu and then by `order`. A command that
 * must not fire while typing asks main not to claim its key.
 */
export function menuCommands(): MenuCommand[] {
  return COMMANDS.flatMap((cmd) =>
    cmd.menu
      ? [
          {
            id: cmd.id,
            label: cmd.label,
            accelerator: accelerator(cmd.chords[0]),
            menu: cmd.menu.menu,
            order: cmd.menu.order,
            registerAccelerator: cmd.whileTyping,
          },
        ]
      : []
  ).sort((a, b) => MENU_ORDER.indexOf(a.menu) - MENU_ORDER.indexOf(b.menu) || a.order - b.order)
}

/** One row of the Settings → Shortcuts pane, or a matched search result. */
export interface Row {
  id: string
  label: string
  note?: string
  /** One glyph array per printed cap — from `display` when present, else the primary chord's glyphs. */
  caps: string[][]
  /** The glyphs of a further chord, printed muted after `/`. Never set alongside `display`. */
  muted?: string[]
  gesture?: string
}

export interface Group {
  scope: Scope
  title: string
  when: string
  rows: Row[]
}

function commandCaps(cmd: Command): string[][] {
  if (cmd.display) return cmd.display.map((cap) => [cap])
  if (cmd.chords.length === 0) return []
  return [chordGlyphs(cmd.chords[0])]
}

function commandRow(cmd: Command): Row {
  return {
    id: cmd.id,
    label: cmd.label,
    note: cmd.note,
    caps: commandCaps(cmd),
    muted: !cmd.display && cmd.chords.length > 1 ? chordGlyphs(cmd.chords[1]) : undefined,
    gesture: cmd.gesture,
  }
}

/** The label, the note and every cap's glyphs (joined by a space), lower-cased, as one search haystack. */
function rowHaystack(row: Row): string {
  const capsText = row.caps.map((cap) => cap.join(' ')).join(' ')
  return [row.label, row.note ?? '', capsText].join(' ').toLowerCase()
}

/** The pane's data (§ 6): `SCOPES` order, filtered by `query`; scopes with no matching row drop out. */
export function keymapGroups(query = ''): Group[] {
  const q = query.trim().toLowerCase()
  const groups: Group[] = []
  for (const { scope, title, when } of SCOPES) {
    const rows = COMMANDS.filter((cmd) => cmd.scope === scope)
      .map(commandRow)
      .filter((row) => q === '' || rowHaystack(row).includes(q))
    if (rows.length > 0) groups.push({ scope, title, when, rows })
  }
  return groups
}

/** The pane header's `{N} bindings` count. */
export function bindingCount(): number {
  return COMMANDS.length
}

/** The command by id — throws on an unknown one, so a typo fails loudly in tests rather than silently at runtime. */
export function command(id: string): Command {
  const cmd = COMMANDS.find((c) => c.id === id)
  if (!cmd) throw new Error(`Unknown command "${id}"`)
  return cmd
}
