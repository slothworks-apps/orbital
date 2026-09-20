import { describe, it, expect } from 'vitest'
import { formatDuration, releaseFootnote } from '../lib/format'

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

describe('releaseFootnote', () => {
  const now = 1_700_000_000_000

  it('says what a pin means, whatever the release setting is', () => {
    const line = 'pinned · stays on the map until you unpin it or drag it into the hole'
    expect(releaseFootnote({ pinned: true, endedAt: now - HOUR, releaseAfterMs: 7 * DAY, now })).toBe(line)
    expect(releaseFootnote({ pinned: true, endedAt: null, releaseAfterMs: null, now })).toBe(line)
  })

  it('pairs how long ago it ended with how long is left', () => {
    expect(releaseFootnote({ pinned: false, endedAt: now - 2 * HOUR, releaseAfterMs: 7 * DAY, now })).toBe(
      'ended 2h ago · releases into history in 6d 22h'
    )
  })

  it('promises no release when the timer is off', () => {
    expect(releaseFootnote({ pinned: false, endedAt: now - 2 * HOUR, releaseAfterMs: null, now })).toBe(
      'ended 2h ago'
    )
  })

  it('drops the release clause once the delay has already elapsed', () => {
    expect(releaseFootnote({ pinned: false, endedAt: now - 8 * DAY, releaseAfterMs: 7 * DAY, now })).toBe(
      'ended 8d ago'
    )
  })

  it('reads "just now" rather than "now ago" for a session that just ended', () => {
    expect(releaseFootnote({ pinned: false, endedAt: now - 10_000, releaseAfterMs: 2 * HOUR, now })).toBe(
      'ended just now · releases into history in 1h 59m'
    )
  })

  it('names the date instead of an unreadable day count past a month', () => {
    const line = releaseFootnote({ pinned: false, endedAt: now - 40 * DAY, releaseAfterMs: null, now })
    expect(line).toMatch(/^ended on /)
    expect(line).not.toMatch(/ago/)
  })

  it('has nothing to say about a session with no end time', () => {
    expect(releaseFootnote({ pinned: false, endedAt: null, releaseAfterMs: 2 * HOUR, now })).toBeNull()
  })
})
