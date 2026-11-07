import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSelectionEndDetector,
  isOrbitalPage,
  MAX_SELECTION_CHARS,
  normalizeSelection,
  SELECTION_DEBOUNCE_MS,
} from '../src/selection'

describe('createSelectionEndDetector', () => {
  let selection = ''
  let active = true
  let sent: string[] = []
  const make = () =>
    createSelectionEndDetector({
      read: () => selection,
      send: (t) => sent.push(t),
      isActive: () => active,
    })
  type Detector = ReturnType<typeof make>
  const trusted = { isTrusted: true }
  const scripted = { isTrusted: false }

  beforeEach(() => {
    vi.useFakeTimers()
    selection = ''
    active = true
    sent = []
  })
  afterEach(() => vi.useRealTimers())

  /** The user presses, the selection changes to `text`, the user releases. */
  const gesture = (d: Detector, text: string) => {
    d.onPress(trusted)
    selection = text
    d.onSelectionChange()
    d.onRelease(trusted)
  }

  it('sends a selection once the user lets go and the debounce passes', () => {
    const d = make()
    gesture(d, 'hello')
    expect(sent).toEqual([])
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual(['hello'])
  })

  it('does nothing on a release without a selection change', () => {
    const d = make()
    selection = 'stale'
    d.onPress(trusted)
    d.onRelease(trusted)
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS * 2)
    expect(sent).toEqual([])
  })

  it('collapses a run of shift+arrow key ups into one event with the final text', () => {
    const d = make()
    for (const text of ['a', 'ab', 'abc']) {
      gesture(d, text)
      vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS / 2)
    }
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual(['abc'])
  })

  it('sends ⌘A in a text field, ended by the ⌘ key going up', () => {
    const d = make()
    d.onPress(trusted) // ⌘
    d.onPress(trusted) // A, whose keyup never comes
    selection = 'all of the field'
    d.onSelectionChange() // select
    d.onSelectionChange() // selectionchange
    d.onRelease(trusted) // ⌘
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual(['all of the field'])
  })

  it('a press before the debounce ends cancels the pending send', () => {
    const d = make()
    gesture(d, 'first')
    d.onPress(trusted)
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS * 2)
    expect(sent).toEqual([])
  })

  it('never sends on events a page dispatched', () => {
    const d = make()
    d.onPress(scripted)
    selection = 'injected'
    d.onSelectionChange()
    d.onRelease(scripted)
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS * 2)
    expect(sent).toEqual([])
  })

  it('never sends a selection changed by script outside a press, even on a real release', () => {
    const d = make()
    selection = 'injected'
    d.onSelectionChange()
    d.onPress(trusted)
    d.onRelease(trusted)
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS * 2)
    expect(sent).toEqual([])
  })

  it('a dispatched event after the gesture cancels the pending send', () => {
    const d = make()
    gesture(d, 'mine')
    d.onRelease(scripted)
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS * 2)
    expect(sent).toEqual([])
  })

  it('does not send a selection a script changed after the gesture', () => {
    const d = make()
    gesture(d, 'mine')
    selection = 'injected'
    d.onSelectionChange()
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS * 2)
    expect(sent).toEqual([])
  })

  it('never sends from a document without focus or out of sight', () => {
    const d = make()
    active = false
    gesture(d, 'background')
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS * 2)
    expect(sent).toEqual([])
  })

  it('still sends when the user leaves the page right after the gesture', () => {
    const d = make()
    gesture(d, 'take this')
    active = false
    d.onBlur()
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual(['take this'])
  })

  it('a press that lost the window no longer lets a change count', () => {
    const d = make()
    d.onPress(trusted)
    d.onBlur()
    selection = 'injected'
    d.onSelectionChange()
    d.onRelease(trusted)
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS * 2)
    expect(sent).toEqual([])
  })

  it('does not send whitespace or an empty selection', () => {
    const d = make()
    gesture(d, '   \n ')
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual([])
  })

  it('does not send the same text twice in a row', () => {
    const d = make()
    gesture(d, 'same')
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    gesture(d, ' same ')
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual(['same'])
  })

  it('sends the same text again after the selection was cleared in between', () => {
    const d = make()
    gesture(d, 'same')
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    gesture(d, '')
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    gesture(d, 'same')
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual(['same', 'same'])
  })

  it('dispose cancels a pending send', () => {
    const d = make()
    gesture(d, 'x')
    d.dispose()
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual([])
  })
})

describe('normalizeSelection', () => {
  it('trims and caps', () => {
    expect(normalizeSelection('  a b \n')).toBe('a b')
    expect(normalizeSelection('x'.repeat(MAX_SELECTION_CHARS + 10))).toHaveLength(
      MAX_SELECTION_CHARS,
    )
  })
})

describe('isOrbitalPage', () => {
  const at = (url: string) => new URL(url)

  it('skips the configured port, the default port and the dev ports on loopback', () => {
    expect(isOrbitalPage(at('http://127.0.0.1:5000/'), 5000)).toBe(true)
    expect(isOrbitalPage(at('http://127.0.0.1:4737/'), 5000)).toBe(true)
    expect(isOrbitalPage(at('http://localhost:4839/session/x'), 4737)).toBe(true)
    expect(isOrbitalPage(at('http://[::1]:4838/'), 4737)).toBe(true)
  })

  it('runs everywhere else', () => {
    expect(isOrbitalPage(at('http://127.0.0.1:3000/'), 4737)).toBe(false)
    expect(isOrbitalPage(at('https://app.clickup.com/t/1'), 4737)).toBe(false)
    expect(isOrbitalPage(at('http://example.com:4737/'), 4737)).toBe(false)
    expect(isOrbitalPage(at('http://localhost/'), 4737)).toBe(false)
    expect(isOrbitalPage(at('file:///tmp/a.html'), 4737)).toBe(false)
  })
})
