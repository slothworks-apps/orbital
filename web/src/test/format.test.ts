import { describe, it, expect } from 'vitest'
import { endedFootnote, formatDuration, formatToolDuration } from '../lib/format'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatDuration', () => {
  it('rounds anything under a minute up to a minute', () => {
    expect(formatDuration(45_000)).toBe('1m')
    expect(formatDuration(0)).toBe('1m')
  })

  it('formats a single unit by default', () => {
    expect(formatDuration(30 * MINUTE)).toBe('30m')
    expect(formatDuration(90 * MINUTE)).toBe('1h')
    expect(formatDuration(8 * HOUR)).toBe('8h')
    expect(formatDuration(DAY)).toBe('1d')
  })

  it('adds the next unit down when asked for two', () => {
    expect(formatDuration(90 * MINUTE, 2)).toBe('1h 30m')
    expect(formatDuration(6 * DAY + 22 * HOUR, 2)).toBe('6d 22h')
  })

  it('drops a second unit that would read zero', () => {
    expect(formatDuration(2 * DAY, 2)).toBe('2d')
    expect(formatDuration(3 * HOUR, 2)).toBe('3h')
  })
})

describe('formatToolDuration', () => {
  it('formats under 10s with one decimal (canvas 11b: "0.3s")', () => {
    expect(formatToolDuration(300)).toBe('0.3s')
    expect(formatToolDuration(6_200)).toBe('6.2s')
  })

  it('formats 10s up to a minute as whole seconds', () => {
    expect(formatToolDuration(10_000)).toBe('10s')
    expect(formatToolDuration(42_000)).toBe('42s')
  })

  // Each band is picked from the value as it will be shown, so a duration
  // that rounds up to the next band reads the way that band writes it.
  it('moves to the next band when rounding reaches it', () => {
    expect(formatToolDuration(9_960)).toBe('10s')
    expect(formatToolDuration(59_600)).toBe('1m 0s')
    expect(formatToolDuration(60 * MINUTE - 400)).toBe('1h 0m')
  })

  it('formats a minute and over as "Nm Ns"', () => {
    expect(formatToolDuration(60_000)).toBe('1m 0s')
    expect(formatToolDuration(64_000)).toBe('1m 4s')
    expect(formatToolDuration(3 * MINUTE + 5_000)).toBe('3m 5s')
  })

  it('stays "Nm Ns" right up to an hour', () => {
    expect(formatToolDuration(59 * MINUTE + 59_000)).toBe('59m 59s')
  })

  it('formats an hour and over as "Nh Nm", dropping seconds', () => {
    expect(formatToolDuration(60 * MINUTE)).toBe('1h 0m')
    expect(formatToolDuration(487 * MINUTE + 12_000)).toBe('8h 7m')
  })

  it('renders no duration at all for a missing value — never "0s" or "—"', () => {
    expect(formatToolDuration(undefined)).toBeUndefined()
  })
})

describe('endedFootnote', () => {
  const now = 1_700_000_000_000

  it('says what a pin means, whenever it ended', () => {
    const line = 'pinned · stays on the map until you unpin it or drop it in the trash'
    expect(endedFootnote({ pinned: true, endedAt: now - HOUR, now })).toBe(line)
    expect(endedFootnote({ pinned: true, endedAt: null, now })).toBe(line)
  })

  it('says how long ago it ended, with no countdown after it', () => {
    expect(endedFootnote({ pinned: false, endedAt: now - 2 * HOUR, now })).toBe('ended 2h ago')
  })

  it('reads "just now" rather than "now ago" for a session that just ended', () => {
    expect(endedFootnote({ pinned: false, endedAt: now - 10_000, now })).toBe('ended just now')
  })

  it('names the date instead of an unreadable day count past a month', () => {
    const line = endedFootnote({ pinned: false, endedAt: now - 40 * DAY, now })
    expect(line).toMatch(/^ended on /)
    expect(line).not.toMatch(/ago/)
  })

  it('has nothing to say about a session with no end time', () => {
    expect(endedFootnote({ pinned: false, endedAt: null, now })).toBeNull()
  })
})
