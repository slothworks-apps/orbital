import { describe, expect, it } from 'vitest'
import type { ApiSession, ClaudeDirLimits, LimitWait, OrbitalModel } from '../lib/types'
import {
  CONTEXT_BRIGHTER_AT,
  CONTEXT_FULL_INK_AT,
  contextReading,
  phoneContextLevel,
  readoutLines,
  ringGradient,
  sheetHeadline,
} from '../mobile/limits/context'
import { limitNoticeKey, phoneLimitNotice } from '../mobile/limits/limitCopy'
import { phoneLimitsView } from '../mobile/limits/limitsView'
import { memberLimitDirs } from '../mobile/limits/members'

// Local time, so the clock words read the same whatever the machine's zone.
const NOW = new Date(2026, 9, 5, 13, 41).getTime()
const RESET = new Date(2026, 9, 5, 14, 5).toISOString()

const MODEL: OrbitalModel = {
  value: 'sonnet[1m]', resolvedModel: 'claude-sonnet-5[1m]', family: 'sonnet', version: '5', shortVersion: 'Sonnet 5',
  variant: '1m', blurb: '', contextWindow: 1_000_000,
}

function session(patch: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's', cwd: '/x', title: 't', firstAt: null, lastAt: NOW, status: 'idle', source: 'orbital',
    model: 'sonnet[1m]', contextUsedTokens: 640_212, ...patch,
  } as ApiSession
}

const reading = (patch: Partial<ApiSession> = {}, learned: Record<string, number> = {}) => {
  const r = contextReading(session(patch), [MODEL], learned)
  if (!r) throw new Error('no reading')
  return r
}

describe('phoneContextLevel', () => {
  it('steps brighter at each threshold, not before', () => {
    expect(phoneContextLevel(0)).toBe('normal')
    expect(phoneContextLevel(CONTEXT_BRIGHTER_AT - 0.001)).toBe('normal')
    expect(phoneContextLevel(CONTEXT_BRIGHTER_AT)).toBe('brighter')
    expect(phoneContextLevel(CONTEXT_FULL_INK_AT - 0.001)).toBe('brighter')
    expect(phoneContextLevel(CONTEXT_FULL_INK_AT)).toBe('full')
    expect(phoneContextLevel(1)).toBe('full')
  })

  it('reads the level off the measured fill', () => {
    expect(reading({ contextUsedTokens: 799_999 }).level).toBe('normal')
    expect(reading({ contextUsedTokens: 800_000 }).level).toBe('brighter')
    expect(reading({ contextUsedTokens: 950_000 }).level).toBe('full')
  })
})

describe('contextReading', () => {
  it('reads used over the window, k-rounded in the header and exact in the sheet', () => {
    const r = reading()
    expect(readoutLines(r)).toEqual({ used: '640k', window: '/ 1M' })
    expect(sheetHeadline(r)).toEqual({ used: '640,212', rest: 'of 1,000,000 tokens · 64%' })
    expect(ringGradient(r)).toContain('64%')
  })

  it('floors the percent, so it never reads a threshold the ink has not reached', () => {
    const r = reading({ contextUsedTokens: 799_999 })
    expect(r.percent).toBe(79)
    expect(r.level).toBe('normal')
  })

  it('shows a dash over the window while unmeasured, with an empty ring', () => {
    const r = reading({ contextUsedTokens: null })
    expect(readoutLines(r)).toEqual({ used: '—', window: '/ 1M' })
    expect(sheetHeadline(r)).toEqual({ used: '—', rest: 'of 1,000,000 tokens' })
    expect(r.fill).toBeNull()
    expect(ringGradient(r)).toContain(' 0%')
  })

  it('shows the count alone and no ring when the window is unknown', () => {
    const r = reading({ model: 'mystery', resolvedModel: 'claude-mystery' })
    expect(readoutLines(r)).toEqual({ used: '640k', window: null })
    expect(sheetHeadline(r)).toEqual({ used: '640,212', rest: 'tokens' })
    expect(ringGradient(r)).toBeNull()
  })

  it("takes a window the Mac has measured for a model the catalog lacks", () => {
    const r = reading({ model: null, resolvedModel: 'claude-mystery' }, { 'claude-mystery': 200_000 })
    expect(readoutLines(r)).toEqual({ used: '640k', window: '/ 200k' })
  })

  it('draws a context above its window full, with the number as measured', () => {
    const r = reading({ contextUsedTokens: 1_040_000 })
    expect(r.fill).toBe(1)
    expect(r.level).toBe('full')
    expect(r.percent).toBe(104)
    expect(readoutLines(r).used).toBe('1M')
    expect(sheetHeadline(r).rest).toBe('of 1,000,000 tokens · 104%')
  })

  it('draws nothing for a terminal session, live or ended', () => {
    expect(contextReading(session({ source: 'terminal' }), [MODEL])).toBeNull()
    expect(contextReading(session({ source: 'terminal', status: 'ended' }), [MODEL])).toBeNull()
  })
})

const wait = (patch: Partial<LimitWait> = {}): LimitWait => ({
  resetsAt: RESET, windowKind: 'five_hour', windowLabel: '5-hour window',
  cancelled: false, willContinue: true, queued: [], autoContinue: true, continueText: 'continue', ...patch,
})

const live = (w: LimitWait) => phoneLimitNotice(w, { offline: false, macName: 'studio-mbp', now: NOW })
const asleep = (w: LimitWait, macName: string | null = 'studio-mbp') =>
  phoneLimitNotice(w, { offline: true, macName, now: NOW })

describe('phoneLimitNotice', () => {
  it('waiting: continues at the reset, sends the text, offers Cancel', () => {
    expect(live(wait())).toEqual({
      kind: 'live',
      title: 'Limit reached, continues at 14:05',
      sub: '5-hour window · then sends “continue”',
      meta: '5-hour window · 100% · resets 14:05',
      action: 'cancel',
    })
  })

  it('cancelled: resets at, says so, offers Undo', () => {
    const n = live(wait({ cancelled: true, willContinue: false }))
    expect(n).toMatchObject({
      title: 'Limit reached, resets at 14:05',
      sub: '5-hour window · auto-continue cancelled for this wait',
      action: 'undo',
    })
  })

  it('auto-continue off on the Mac: no button, the wait says so', () => {
    const n = live(wait({ autoContinue: false, willContinue: false }))
    expect(n).toMatchObject({
      title: 'Limit reached, resets at 14:05',
      sub: '5-hour window · automatic continue is off',
      action: null,
    })
  })

  it('reads the settings off the wait, not the defaults', () => {
    expect(live(wait({ continueText: 'keep going' }))).toMatchObject({ sub: '5-hour window · then sends “keep going”' })
  })

  it('queued messages go out at the reset whatever was cancelled, and are counted', () => {
    expect(live(wait({ queued: ['a'] }))).toMatchObject({ sub: '5-hour window · then sends your queued message' })
    expect(live(wait({ cancelled: true, willContinue: false, queued: ['a', 'b'] }))).toMatchObject({
      title: 'Limit reached, continues at 14:05',
      sub: '5-hour window · then sends your 2 queued messages',
      action: 'undo',
    })
  })

  it('names the day of a reset that is not today, never a countdown', () => {
    const tomorrow = new Date(2026, 9, 6, 9, 0).toISOString()
    expect(live(wait({ resetsAt: tomorrow }))).toMatchObject({
      title: 'Limit reached, continues Tue 6 Oct at 09:00',
      meta: '5-hour window · 100% · resets Tue 6 Oct, 09:00',
    })
  })

  it('asleep: no button, the reset needs the Mac awake, the queue counted', () => {
    expect(asleep(wait({ queued: ['a'] }))).toEqual({
      kind: 'asleep',
      title: 'Limit resets at 14:05',
      body: 'It continues only if studio-mbp is awake then. Asleep, it stays waiting and continues when the Mac wakes.',
      meta: '5-hour window · auto-continue on · 1 queued',
    })
  })

  it('asleep and cancelled or off: nothing to continue, so no promise about waking', () => {
    expect(asleep(wait({ cancelled: true, willContinue: false }))).toMatchObject({
      body: null,
      meta: '5-hour window · auto-continue cancelled',
    })
    expect(asleep(wait({ autoContinue: false, willContinue: false }))).toMatchObject({
      body: null,
      meta: '5-hour window · auto-continue off',
    })
  })

  it('asleep without a known Mac name says Your Mac', () => {
    const n = asleep(wait(), null)
    expect(n.kind === 'asleep' && n.body).toMatch(/^It continues only if Your Mac is awake then/)
  })
})

describe('limitNoticeKey', () => {
  it('changes with every word the notice shows', () => {
    const base = limitNoticeKey(wait(), false)
    expect(limitNoticeKey(wait(), false)).toBe(base)
    expect(limitNoticeKey(wait({ cancelled: true }), false)).not.toBe(base)
    expect(limitNoticeKey(wait({ queued: ['a'] }), false)).not.toBe(base)
    expect(limitNoticeKey(wait({ resetsAt: new Date(2026, 9, 5, 15).toISOString() }), false)).not.toBe(base)
    expect(limitNoticeKey(wait({ autoContinue: false }), false)).not.toBe(base)
    expect(limitNoticeKey(wait(), true)).not.toBe(base)
  })
})

describe('phoneLimitsView', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 5, h, m).toISOString()
  const machine = (id: string, name: string, online = true) => ({ id, name, kind: 'desktop', os: 'macos', online, asOf: null })
  const dir = (patch: Partial<ClaudeDirLimits>): ClaudeDirLimits => ({
    id: 1, name: 'Personal', account: 'jan@acme.com', plan: 'pro', tracked: true, readAt: at(13, 30), stale: false,
    windows: [{
      kind: 'session', label: '5-hour window', percent: 85, resetsAt: at(15), severity: 'warning',
      estimate: { runsOutAt: at(14, 18), basis: 'recent' },
    }],
    extraUsage: null, waits: [], ...patch,
  })

  it('one account on two devices is one section, its directories listed by device', () => {
    const view = phoneLimitsView([
      dir({ machine: machine('a', 'studio-mbp') }),
      dir({ machine: machine('b', 'air-m3'), readAt: at(13, 0) }),
    ], NOW)
    expect(view.groups).toHaveLength(1)
    expect(view.groups[0]).toMatchObject({ title: 'jan@acme.com', plan: 'Pro', tiles: [], meta: 'studio-mbp: Personal · air-m3: Personal' })
    expect(view.groups[0].rows[0]).toMatchObject({ value: '85%', word: 'WARNING', reset: 'today 15:00' })
    expect(view.groups[0].rows[0].estimate).toMatchObject({ before: 'runs out ', at: '~14:20', after: ' at this pace' })
    expect(view).toMatchObject({ read: 'read 13:30', stale: null })
  })

  it('an offline device\'s reading is out of date: the stale line names it and the oldest read, the estimate goes', () => {
    const view = phoneLimitsView([
      dir({ machine: machine('a', 'studio-mbp', false), stale: true, readAt: at(9, 12) }),
      dir({ id: 2, name: 'Work', account: 'work@acme.com', machine: machine('a', 'studio-mbp', false), stale: true, readAt: at(10) }),
    ], NOW)
    expect(view.read).toBeNull()
    expect(view.stale).toBe('last read 09:12 · studio-mbp offline')
    expect(view.groups.map((g) => g.stale)).toEqual([true, true])
    expect(view.groups[0].rows[0].estimate?.before).toBe('no estimate · reading is out of date')
    // Two accounts: each wears its directories' tiles.
    expect(view.groups.map((g) => g.tiles)).toEqual([['P'], ['W']])
  })

  it('an older Mac\'s directories, with no account and no estimate, are a section each with no estimate line', () => {
    const old = (id: number, name: string) => dir({
      id, name, account: undefined, plan: undefined, machine: machine('a', 'studio-mbp'),
      windows: [{ kind: 'session', label: '5-hour window', percent: 20, resetsAt: at(15), severity: 'normal' }],
    })
    const view = phoneLimitsView([old(1, 'Personal'), old(2, 'Work')], NOW)
    expect(view.groups.map((g) => g.title)).toEqual(['Personal', 'Work'])
    expect(view.groups[0].rows[0].estimate).toBeNull()
  })
})

describe('memberLimitDirs', () => {
  const machine = { id: 'a', name: 'studio-mbp', kind: 'desktop', os: 'macos', online: true, asOf: null }
  it('tags each directory with its member, lower-cases the account and leaves out what is not its own', () => {
    const dirs = memberLimitDirs({
      machine, failed: false,
      dirs: [{ id: 1, name: 'W', account: 'Jan@Acme.com', readAt: null, stale: false }, { id: 2, machine: { id: 'b' } }, 'junk', { name: 'no id' }],
    })
    expect(dirs).toHaveLength(1)
    expect(dirs[0]).toMatchObject({ id: 1, account: 'jan@acme.com', machine, stale: false, windows: [], tracked: true })
  })
  it('marks a member\'s reading stale when it is offline or its last read failed', () => {
    const raw = [{ id: 1, readAt: null, stale: false }]
    expect(memberLimitDirs({ machine: { ...machine, online: false }, failed: false, dirs: raw })[0].stale).toBe(true)
    expect(memberLimitDirs({ machine, failed: true, dirs: raw })[0].stale).toBe(true)
  })
})
