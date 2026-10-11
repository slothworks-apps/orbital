import { describe, expect, it } from 'vitest'
import { activeAfterClose, tabLabels, terminalChipTitle } from '../terminal/tabs'
import { parseTerminalChord, terminalChordOf } from '../terminal/keys'
import { parseTerminalControl } from '../terminal/types'

const tab = (label: string, busy = false, exitCode: number | null = null) => ({ label, busy, exitCode })

describe('tabLabels', () => {
  it('numbers the second and later of equal labels, in tab order', () => {
    expect(tabLabels([tab('orbital'), tab('npm run dev'), tab('orbital'), tab('orbital')])).toEqual([
      'orbital',
      'npm run dev',
      'orbital 2',
      'orbital 3',
    ])
  })

  it('gives the number up when a tab stops sharing its label', () => {
    expect(tabLabels([tab('web'), tab('orbital')])).toEqual(['web', 'orbital'])
  })
})

describe('terminalChipTitle', () => {
  it('names what runs, never an exited tab', () => {
    const tabs = [tab('npm run dev', true), tab('orbital'), tab('vitest', true, 1)]
    expect(terminalChipTitle(tabs, '⌃`')).toBe('3 terminals · npm run dev running · ⌃`')
  })

  it('says one terminal in the singular, and nothing about running when nothing runs', () => {
    expect(terminalChipTitle([tab('orbital')], '⌃`')).toBe('1 terminal · ⌃`')
  })

  it('names a running tab by its numbered label', () => {
    expect(terminalChipTitle([tab('orbital'), tab('orbital', true)], '⌃`')).toBe(
      '2 terminals · orbital 2 running · ⌃`',
    )
  })
})

describe('activeAfterClose', () => {
  const ids = ['a', 'b', 'c']

  it('moves to the tab after the closed active one', () => {
    expect(activeAfterClose(ids, 'b', 'b')).toBe('c')
  })

  it('moves to the one before when the last tab closes', () => {
    expect(activeAfterClose(ids, 'c', 'c')).toBe('b')
  })

  it('keeps the active tab when another one closes', () => {
    expect(activeAfterClose(ids, 'a', 'c')).toBe('a')
  })

  it('leaves nothing active when the only tab closes', () => {
    expect(activeAfterClose(['a'], 'a', 'a')).toBeNull()
  })
})

describe('terminal chords', () => {
  const key = (k: string, code: string, mods: Partial<KeyboardEvent> = {}) => ({
    key: k,
    code,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  })

  it('reads ⌘T and ⌘W by character and ⌘1–9 by position', () => {
    // Czech QWERTZ: the 1 key prints `+`.
    expect(terminalChordOf(key('t', 'KeyT'))).toBe('new-tab')
    expect(terminalChordOf(key('w', 'KeyW'))).toBe('close-tab')
    expect(terminalChordOf(key('+', 'Digit1'))).toBe('tab-1')
    expect(terminalChordOf(key('t', 'KeyT', { shiftKey: true }))).toBeNull()
    expect(terminalChordOf(key('0', 'Digit0'))).toBeNull()
  })

  it('accepts only the chord names main sends', () => {
    expect(parseTerminalChord('tab-9')).toBe('tab-9')
    expect(parseTerminalChord('tab-0')).toBeNull()
    expect(parseTerminalChord('close-window')).toBeNull()
    expect(parseTerminalChord(3)).toBeNull()
  })
})

describe('parseTerminalControl', () => {
  it('reads the three control messages', () => {
    expect(parseTerminalControl('{"type":"exit","exitCode":137}')).toEqual({ type: 'exit', exitCode: 137 })
    expect(parseTerminalControl('{"type":"status","label":"vitest","busy":true}')).toEqual({
      type: 'status',
      label: 'vitest',
      busy: true,
    })
    expect(parseTerminalControl('{"type":"restart"}')).toEqual({ type: 'restart' })
  })

  it('drops anything else', () => {
    expect(parseTerminalControl('not json')).toBeNull()
    expect(parseTerminalControl('{"type":"exit"}')).toBeNull()
    expect(parseTerminalControl('null')).toBeNull()
  })
})
