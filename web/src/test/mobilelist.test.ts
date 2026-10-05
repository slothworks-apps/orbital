import { describe, expect, it } from 'vitest'
import type { ApiSession, PendingDecision, Tag } from '../lib/types'
import { agoLabel, asOfLabel, basename, checkedLabel, homePath, relayHost } from '../mobile/format'
import {
  decisionReason, glyphFor, groupOf, groupSessions, latestActivity, stateLine, tagChips,
} from '../mobile/sessionList'

function session(id: string, patch: Partial<ApiSession> = {}): ApiSession {
  return {
    id, cwd: `/w/${id}`, title: id, firstAt: 1, lastAt: 1, messageCount: 1, source: 'web', permissionMode: null,
    model: null, resolvedModel: null, tagIds: [], status: 'idle', subagents: [], ...patch,
  }
}

const question: PendingDecision = {
  id: 'q', kind: 'question', createdAt: 1,
  input: { questions: [{ question: 'Which branch?', header: 'branch', options: [], multiSelect: false }] },
}

describe('groupSessions', () => {
  it('orders the groups needs input, working, idle, ended, each newest first, and drops empty ones', () => {
    const groups = groupSessions(
      [
        session('ended', { status: 'ended', lastAt: 9 }),
        session('idle-old', { lastAt: 1 }),
        session('idle-new', { lastAt: 5 }),
        session('asks', { status: 'needs_input', pendingDecision: question }),
      ],
      null,
    )
    expect(groups.map((g) => g.key)).toEqual(['input', 'idle', 'ended'])
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['idle-new', 'idle-old'])
  })

  it('puts WAITING with working, and DONE and INTERRUPTED with idle', () => {
    expect(groupOf(session('w', { status: 'working', awaitingSubagents: true, subagents: [{ id: 'a', name: 'a', state: 'working', startedAt: 1 }] }))).toBe('working')
    expect(groupOf(session('d', { status: 'needs_input' }))).toBe('idle')
    expect(groupOf(session('i', { status: 'working', interruptedAt: 5 }))).toBe('idle')
  })

  it('filters by tag, locally', () => {
    const groups = groupSessions([session('a', { tagIds: [1] }), session('b', { tagIds: [2] })], 2)
    expect(groups.flatMap((g) => g.sessions.map((s) => s.id))).toEqual(['b'])
  })
})

describe('tagChips and latestActivity', () => {
  const tags: Tag[] = [
    { id: 1, name: 'orbital', hue: 200, is_default: 1 },
    { id: 2, name: 'idle-only', hue: 40, is_default: 0 },
    { id: 3, name: 'unused', hue: 90, is_default: 0 },
  ]

  it('counts live sessions per tag and leaves out tags nothing carries', () => {
    const chips = tagChips(
      [session('a', { tagIds: [1] }), session('b', { tagIds: [1], status: 'ended' }), session('c', { tagIds: [2], status: 'ended' })],
      tags,
    )
    expect(chips.map((c) => [c.tag.id, c.live])).toEqual([[1, 1], [2, 0]])
  })

  it("reads the ended group's latest activity", () => {
    expect(latestActivity([session('a', { lastAt: 3 }), session('b', { lastAt: 7 }), session('c', { lastAt: null })])).toBe(7)
    expect(latestActivity([])).toBeNull()
  })
})

describe('decisionReason', () => {
  it("says what a needs-input session waits on", () => {
    expect(decisionReason(question)).toBe('Which branch?')
    expect(decisionReason({ id: 'p', kind: 'plan', input: {}, createdAt: 1 })).toBe('plan to approve')
    expect(decisionReason({ id: 'r', kind: 'permission', input: {}, createdAt: 1, toolName: 'Bash' })).toBe('wants to run Bash')
    expect(decisionReason({ id: 'r', kind: 'permission', input: {}, createdAt: 1, title: 'Run npm test?' })).toBe('Run npm test?')
    expect(decisionReason(null)).toBeNull()
  })
})

describe('offline', () => {
  it('stops every glyph moving and keeps its shape', () => {
    expect(glyphFor('needs_input', false).motion).toBe('breathe')
    expect(glyphFor('needs_input', true)).toEqual({ shape: 'solid', motion: 'steady' })
    expect(glyphFor('waiting', true)).toEqual({ shape: 'hollow', motion: 'steady' })
  })

  it("reads a transcript's state as what it was", () => {
    expect(stateLine('working', false, null, 0)).toBe('WORKING')
    const asOf = new Date(2026, 9, 2, 14, 32).getTime()
    expect(stateLine('working', true, asOf, asOf + 60_000)).toBe(`WAS WORKING · ${asOfLabel(asOf, asOf + 60_000)}`)
    expect(stateLine('idle', true, null, 0)).toBe('WAS IDLE')
  })
})

describe('labels', () => {
  const at = new Date(2026, 9, 2, 14, 32).getTime()

  it('names the time alone today, and the day before that', () => {
    const today = asOfLabel(at, at + 3_600_000)
    expect(today).toBe(`as of ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
    const earlier = asOfLabel(at, at + 2 * 86_400_000)
    expect(earlier).not.toBe(today)
    expect(earlier.endsWith(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))).toBe(true)
  })

  it('says "checked just now" for a minute, then how long ago', () => {
    expect(checkedLabel(at, at + 30_000)).toBe('checked just now')
    expect(checkedLabel(at, at + 5 * 60_000)).toBe('checked 5m ago')
  })

  it('reads ages, folder names and relay hosts', () => {
    expect(agoLabel(at, at + 10_000)).toBe('just now')
    expect(agoLabel(at, at + 3 * 3_600_000)).toBe('3h ago')
    expect(basename('/w/orbital/')).toBe('orbital')
    expect(relayHost('https://relay.example.org:8443/x')).toBe('relay.example.org:8443')
    expect(relayHost('not a url')).toBe('not a url')
  })

  it('folds the home folder into ~ and leaves every other path alone', () => {
    expect(homePath('/Users/tomin/Projects/orbital')).toBe('~/Projects/orbital')
    expect(homePath('/home/ci/work')).toBe('~/work')
    expect(homePath('/Users/tomin')).toBe('~')
    expect(homePath('/Users/tomin2x/a')).toBe('~/a')
    expect(homePath('/private/tmp/x')).toBe('/private/tmp/x')
    expect(homePath('/Users')).toBe('/Users')
    expect(homePath('/srv/Users/tomin/a')).toBe('/srv/Users/tomin/a')
  })
})
