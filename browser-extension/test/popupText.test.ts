import { describe, expect, it } from 'vitest'
import { checkedText, formatShortcut } from '../src/popupText'

describe('formatShortcut', () => {
  it('writes macOS modifiers as Orbital does', () => {
    expect(formatShortcut('⇧⌘S')).toBe('⌘⇧S')
    expect(formatShortcut('⌥⇧⌘P')).toBe('⌥⌘⇧P')
  })

  it('leaves other platforms’ text alone, and an unassigned one empty', () => {
    expect(formatShortcut('Ctrl+Shift+S')).toBe('Ctrl+Shift+S')
    expect(formatShortcut('')).toBe('')
  })
})

describe('checkedText', () => {
  const clock = () => '14:28'
  it('ages from just now to minutes to a clock time', () => {
    expect(checkedText(0, 59_000, clock)).toBe('checked just now')
    expect(checkedText(0, 60_000, clock)).toBe('checked 1 min ago')
    expect(checkedText(0, 59 * 60_000, clock)).toBe('checked 59 min ago')
    expect(checkedText(0, 60 * 60_000, clock)).toBe('checked at 14:28')
  })
})
