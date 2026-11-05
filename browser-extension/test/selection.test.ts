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
  let sent: string[] = []
  const make = () =>
    createSelectionEndDetector({ read: () => selection, send: (t) => sent.push(t) })

  beforeEach(() => {
    vi.useFakeTimers()
    selection = ''
    sent = []
  })
  afterEach(() => vi.useRealTimers())

  const select = (d: ReturnType<typeof make>, text: string) => {
    selection = text
    d.onSelectionChange()
  }

  it('sends a selection once the mouse goes up and the debounce passes', () => {
    const d = make()
    select(d, 'hello')
    d.onPointerUp()
    expect(sent).toEqual([])
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual(['hello'])
  })

  it('does nothing on a mouse up without a selection change', () => {
    const d = make()
    selection = 'stale'
    d.onPointerUp()
    d.onKeyUp()
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS * 2)
    expect(sent).toEqual([])
  })

  it('collapses a run of shift+arrow key ups into one event with the final text', () => {
    const d = make()
    for (const text of ['a', 'ab', 'abc']) {
      select(d, text)
      d.onKeyUp()
      vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS / 2)
    }
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual(['abc'])
  })

  it('a press before the debounce ends cancels the pending send', () => {
    const d = make()
    select(d, 'first')
    d.onPointerUp()
    d.onPointerDown()
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS * 2)
    expect(sent).toEqual([])
  })

  it('does not send whitespace or an empty selection', () => {
    const d = make()
    select(d, '   \n ')
    d.onPointerUp()
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual([])
  })

  it('does not send the same text twice in a row', () => {
    const d = make()
    select(d, 'same')
    d.onPointerUp()
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    select(d, ' same ')
    d.onPointerUp()
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual(['same'])
  })

  it('sends the same text again after the selection was cleared in between', () => {
    const d = make()
    select(d, 'same')
    d.onPointerUp()
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    select(d, '')
    d.onPointerUp()
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    select(d, 'same')
    d.onPointerUp()
    vi.advanceTimersByTime(SELECTION_DEBOUNCE_MS)
    expect(sent).toEqual(['same', 'same'])
  })

  it('dispose cancels a pending send', () => {
    const d = make()
    select(d, 'x')
    d.onPointerUp()
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
