import { describe, it, expect } from 'vitest'
import type { KeyboardEventLike } from '../lib/keymap'
import {
  COMMANDS,
  SCOPES,
  accelerator,
  chordGlyphs,
  chordLabel,
  command,
  digitFromEvent,
  isTypingTarget,
  keymapGroups,
  matches,
  menuCommands,
  parseChord,
} from '../lib/keymap'

/** A forbidden punctuation key per rule 3 — no default chord may use these. */
const FORBIDDEN_KEYS = ['/', '[', ']', '-', '=', ';', "'"]

function event(overrides: Partial<KeyboardEventLike>): KeyboardEventLike {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  }
}

describe('parseChord', () => {
  it('splits modifiers from the key part', () => {
    expect(parseChord('meta+shift+n')).toEqual({ mods: new Set(['meta', 'shift']), key: 'n' })
    expect(parseChord('Escape')).toEqual({ mods: new Set(), key: 'Escape' })
    expect(parseChord('meta+,')).toEqual({ mods: new Set(['meta']), key: ',' })
  })

  it('parses every COMMANDS chord', () => {
    for (const cmd of COMMANDS) {
      for (const chord of cmd.chords) {
        expect(() => parseChord(chord)).not.toThrow()
      }
    }
  })
})

describe('matches', () => {
  it('matches a QWERTZ-style event where the physical key differs from the letter', () => {
    // code: 'KeyY' but the layout prints 'z' — meta+z matches on e.key, not e.code.
    const e = event({ key: 'z', code: 'KeyY', metaKey: true })
    expect(matches('meta+z', e, { isMac: true })).toBe(true)
  })

  it('matches a digit chord by e.code even when e.key prints a different character', () => {
    // Czech layout: the "1" key prints '+' without Shift.
    const e = event({ key: '+', code: 'Digit1', metaKey: true })
    expect(matches('meta+Digit1', e, { isMac: true })).toBe(true)
  })

  it('matches the backquote chord on either key a Mac ISO keyboard may report', () => {
    // The terminal's ⌃` on a Czech layout, where the key prints a dead accent.
    for (const code of ['Backquote', 'IntlBackslash']) {
      expect(matches('ctrl+Backquote', event({ key: 'Dead', code, ctrlKey: true }), { isMac: true })).toBe(true)
    }
    expect(matches('ctrl+Backquote', event({ key: '`', code: 'Quote', ctrlKey: true }), { isMac: true })).toBe(false)
    expect(chordLabel('ctrl+Backquote')).toBe('⌃`')
  })

  it('matches shift+letter arriving as the upper-case key', () => {
    const e = event({ key: 'N', code: 'KeyN', metaKey: true, shiftKey: true })
    expect(matches('meta+shift+n', e, { isMac: true })).toBe(true)
  })

  it('misses when an extra modifier is held', () => {
    const e = event({ key: 'n', code: 'KeyN', metaKey: true, altKey: true })
    expect(matches('meta+n', e, { isMac: true })).toBe(false)
  })

  it('ctrl+shift+Tab matches only ctrlKey, not metaKey', () => {
    const withCtrl = event({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true })
    expect(matches('ctrl+shift+Tab', withCtrl, { isMac: true })).toBe(true)

    const withMetaToo = event({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true, metaKey: true })
    expect(matches('ctrl+shift+Tab', withMetaToo, { isMac: true })).toBe(false)
  })

  it('meta matches ctrlKey off macOS, so ctrl+n cannot stand in for it there', () => {
    const e = event({ key: 'n', code: 'KeyN', ctrlKey: true })
    expect(matches('meta+n', e, { isMac: false })).toBe(true)
    // On macOS the same event is a bare Ctrl+N, never Cmd+N.
    expect(matches('meta+n', e, { isMac: true })).toBe(false)
  })
})

describe('digitFromEvent', () => {
  it('reads Digit1..Digit9 from e.code', () => {
    expect(digitFromEvent(event({ code: 'Digit1' }))).toBe(1)
    expect(digitFromEvent(event({ code: 'Digit9' }))).toBe(9)
  })

  it('reads Numpad1..Numpad9 as the same digits', () => {
    expect(digitFromEvent(event({ code: 'Numpad1' }))).toBe(1)
    expect(digitFromEvent(event({ code: 'Numpad9' }))).toBe(9)
    expect(digitFromEvent(event({ code: 'Numpad0' }))).toBeNull()
  })

  it('is null for anything else', () => {
    expect(digitFromEvent(event({ code: 'Digit0' }))).toBeNull()
    expect(digitFromEvent(event({ code: 'KeyN' }))).toBeNull()
    expect(digitFromEvent(event({ code: '' }))).toBeNull()
  })
})

describe('isTypingTarget', () => {
  it('is true for INPUT, TEXTAREA and contentEditable', () => {
    expect(isTypingTarget(document.createElement('input'))).toBe(true)
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true)
    const div = document.createElement('div')
    Object.defineProperty(div, 'isContentEditable', { value: true })
    expect(isTypingTarget(div)).toBe(true)
  })

  it('is false for a plain element or null', () => {
    // jsdom leaves `isContentEditable` `undefined` rather than `false` on a
    // plain element, so this checks falsiness, not strict `false`.
    expect(isTypingTarget(document.createElement('div'))).toBeFalsy()
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('chordGlyphs / chordLabel / accelerator', () => {
  it.each([
    ['meta+shift+n', ['⌘', '⇧', 'N'], '⌘⇧N', 'CmdOrCtrl+Shift+N'],
    ['ctrl+shift+Tab', ['⌃', '⇧', '⇥'], '⌃⇧⇥', 'Ctrl+Shift+Tab'],
    ['meta+Digit2', ['⌘', '2'], '⌘2', 'CmdOrCtrl+2'],
    ['meta+,', ['⌘', ','], '⌘,', 'CmdOrCtrl+,'],
    ['Escape', ['esc'], 'esc', 'Escape'],
  ] as const)('%s', (chord, glyphs, label, accel) => {
    expect(chordGlyphs(chord)).toEqual(glyphs)
    expect(chordLabel(chord)).toBe(label)
    expect(accelerator(chord)).toBe(accel)
  })
})

describe('keymapGroups', () => {
  it('yields every scope in SCOPES order for an empty query', () => {
    const groups = keymapGroups('')
    expect(groups.map((g) => g.scope)).toEqual(SCOPES.map((s) => s.scope))
    expect(groups).toHaveLength(7)
  })

  it('narrows to one group with one row for a label match', () => {
    const groups = keymapGroups('fit')
    expect(groups).toHaveLength(1)
    expect(groups[0].scope).toBe('map')
    expect(groups[0].rows).toHaveLength(1)
    expect(groups[0].rows[0].id).toBe('map.fit')
  })

  it('matches a glyph query against the cycling rows', () => {
    const groups = keymapGroups('⌃')
    const ids = groups.flatMap((g) => g.rows.map((r) => r.id))
    expect(ids).toContain('global.next-session')
    expect(ids).toContain('global.previous-session')
  })

  it('yields no groups for a query that matches nothing', () => {
    expect(keymapGroups('zzzzzz-no-match')).toEqual([])
  })
})

describe('COMMANDS', () => {
  it('has unique ids', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('uses no forbidden punctuation key', () => {
    for (const cmd of COMMANDS) {
      for (const chord of cmd.chords) {
        const { key } = parseChord(chord)
        expect(FORBIDDEN_KEYS).not.toContain(key)
      }
    }
  })
})

describe('menuCommands', () => {
  const items = menuCommands()
  const MENU_ORDER = ['File', 'Session', 'View', 'Window']

  it('holds exactly the commands with a menu', () => {
    expect(new Set(items.map((item) => item.id))).toEqual(
      new Set(COMMANDS.filter((c) => c.menu).map((c) => c.id))
    )
    expect(items).toHaveLength(COMMANDS.filter((c) => c.menu).length)
  })

  it('is sorted by menu, then by order', () => {
    const sorted = [...items].sort(
      (a, b) => MENU_ORDER.indexOf(a.menu) - MENU_ORDER.indexOf(b.menu) || a.order - b.order
    )
    expect(items).toEqual(sorted)
  })

  it('gives every item an accelerator, an id main accepts, and whileTyping as registerAccelerator', () => {
    for (const item of items) {
      const cmd = command(item.id)
      expect(item.accelerator).not.toBe('')
      expect(item.accelerator).toBe(accelerator(cmd.chords[0]))
      // desktop/src/lib/appMenu.ts's parseMenuCommands drops any other id.
      expect(item.id).toMatch(/^[a-z]+\.[a-z-]+$/)
      expect(item.registerAccelerator).toBe(cmd.whileTyping)
      expect({ menu: item.menu, order: item.order }).toEqual(cmd.menu)
    }
  })
})

describe('command', () => {
  it('returns the command by id', () => {
    expect(command('map.fit').label).toBe('Fit the map')
  })

  it('throws on an unknown id', () => {
    expect(() => command('nope')).toThrow()
  })
})
