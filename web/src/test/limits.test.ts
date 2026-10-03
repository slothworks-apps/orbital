import { describe, expect, it } from 'vitest'
import {
  formatMoney,
  formatResetAt,
  formatResetPhrase,
  limitSeverity,
  limitWaitCopy,
  severityWord,
} from '../lib/limits'
import type { LimitWait } from '../lib/types'

// Built from local parts, so "today" means the same thing whatever zone the
// suite runs in.
const NOW = new Date(2026, 9, 3, 13, 42).getTime()
const iso = (...parts: [number, number, number, number, number]) => new Date(...parts).toISOString()

describe('reset times', () => {
  it('writes a reset later today as the time alone', () => {
    expect(formatResetAt(iso(2026, 9, 3, 15, 0), NOW)).toBe('15:00')
    expect(formatResetPhrase(iso(2026, 9, 3, 15, 0), NOW)).toBe('at 15:00')
  })

  it('names the day for any other day, including tomorrow just past midnight', () => {
    expect(formatResetAt(iso(2026, 9, 8, 9, 0), NOW)).toBe('Thu 8 Oct, 09:00')
    expect(formatResetPhrase(iso(2026, 9, 8, 9, 0), NOW)).toBe('Thu 8 Oct at 09:00')
    expect(formatResetAt(iso(2026, 9, 4, 0, 5), NOW)).toBe('Sun 4 Oct, 00:05')
  })

  it('rounds the server\'s just-short-of-the-hour reset to the minute it means', () => {
    const shy = new Date(new Date(2026, 9, 3, 15, 0).getTime() - 350).toISOString()
    expect(formatResetAt(shy, NOW)).toBe('15:00')
    // …including when that minute falls on the next day.
    const midnight = new Date(new Date(2026, 9, 4, 0, 0).getTime() - 350).toISOString()
    expect(formatResetAt(midnight, NOW)).toBe('Sun 4 Oct, 00:00')
  })

  it('reads a missing or unreadable time as a dash, never a guess', () => {
    expect(formatResetAt(null, NOW)).toBe('—')
    expect(formatResetAt('not a date', NOW)).toBe('—')
  })
})

describe('severity', () => {
  it('falls back to normal for a value it does not know', () => {
    expect(limitSeverity('warning')).toBe('warning')
    expect(limitSeverity('alarming')).toBe('normal')
    expect(limitSeverity(undefined)).toBe('normal')
  })

  it('says LIMIT REACHED at 100 % whatever the grade', () => {
    expect(severityWord('normal', 34)).toBe('')
    expect(severityWord('critical', 92)).toBe('CRITICAL')
    expect(severityWord('normal', 100)).toBe('LIMIT REACHED')
  })
})

describe('formatMoney', () => {
  it('keeps cents only where there are any', () => {
    expect(formatMoney(1840, 'USD')).toBe('$18.40')
    expect(formatMoney(5000, 'USD')).toBe('$50')
  })

  it('falls back to the number for a code Intl rejects', () => {
    expect(formatMoney(1840, 'not-a-code')).toBe('18.40')
  })
})

describe('limitWaitCopy', () => {
  const wait: LimitWait = {
    resetsAt: iso(2026, 9, 3, 15, 0),
    windowKind: 'session',
    windowLabel: '5-hour window',
    cancelled: false,
    willContinue: true,
    queued: [],
  }
  const on = { autoContinue: true, text: 'Continue where you left off.' }

  it('offers Cancel while it will continue, Undo once cancelled, nothing with the setting off', () => {
    expect(limitWaitCopy(wait, on, NOW).action).toBe('cancel')
    const cancelled = limitWaitCopy({ ...wait, cancelled: true, willContinue: false }, on, NOW)
    expect(cancelled.action).toBe('undo')
    expect(cancelled.pill).toBe('limit · resets 15:00')
    const off = limitWaitCopy({ ...wait, willContinue: false }, { ...on, autoContinue: false }, NOW)
    expect(off.action).toBeNull()
    expect(off.showSettings).toBe(true)
  })

  it('says the queued messages go out rather than the continuation text', () => {
    const copy = limitWaitCopy({ ...wait, cancelled: true, queued: ['a', 'b'] }, on, NOW)
    expect(copy.title).toBe('Limit reached, continues at 15:00')
    expect(copy.sub).toBe('5-hour window · then sends your 2 queued messages')
  })
})
