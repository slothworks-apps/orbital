import { describe, expect, it } from 'vitest'
import type { ApiSession, BackgroundTask, LimitWait, PendingDecision, Tag } from '../lib/types'
import { agoLabel, asOfLabel, basename, checkedLabel, homePath, relayHost } from '../mobile/format'
import {
  decisionReason, gateReason, glyphFor, groupOf, groupSessions, inputReason, isGateRow, latestActivity, limitLine, moonsSummary,
  moonsSummaryAsleep, stateLine, tagChips, tasksForRow,
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

describe('10a groups', () => {
  const wait = (patch: Partial<LimitWait> = {}): LimitWait => ({
    resetsAt: new Date(2026, 9, 5, 14, 5).toISOString(), windowKind: 'five_hour', windowLabel: '5-hour window',
    cancelled: false, willContinue: true, queued: [], ...patch,
  })

  it('puts a waiting gate in NEEDS INPUT and a reviewing gate with its own state', () => {
    expect(groupOf(session('g', { status: 'needs_input', harnessGate: 'waiting' }))).toBe('input')
    expect(groupOf(session('r', { status: 'idle', harnessGate: 'reviewing' }))).toBe('idle')
  })

  it('puts a limit wait between WORKING and IDLE, cancelled or not, and never a terminal one', () => {
    const groups = groupSessions(
      [
        session('idle'),
        session('wait', { limitWait: wait() }),
        session('cancelled', { limitWait: wait({ cancelled: true, willContinue: false }) }),
        session('work', { status: 'working' }),
      ],
      null,
    )
    expect(groups.map((g) => g.key)).toEqual(['working', 'limit', 'idle'])
    expect(groups[1].sessions.map((s) => s.id).sort()).toEqual(['cancelled', 'wait'])
    expect(groupOf(session('t', { source: 'terminal', limitWait: wait() }))).toBe('idle')
  })

  it('leads each group with its pinned rows in pin order, then the rest newest first', () => {
    const [idle] = groupSessions(
      [
        session('new', { lastAt: 9 }),
        session('pin-late', { lastAt: 1, pinnedAt: 20 }),
        session('old', { lastAt: 2 }),
        session('pin-early', { lastAt: 1, pinnedAt: 10 }),
      ],
      null,
    )
    expect(idle.sessions.map((s) => s.id)).toEqual(['pin-early', 'pin-late', 'new', 'old'])
  })

  it('keeps a pinned ended session above the fold and folds the unpinned ones', () => {
    const groups = groupSessions(
      [
        session('gone', { status: 'ended' }),
        session('kept', { status: 'ended', pinnedAt: 5 }),
        session('asks', { status: 'needs_input', pendingDecision: question, pinnedAt: 1 }),
      ],
      null,
    )
    expect(groups.map((g) => [g.key, g.sessions.map((s) => s.id)])).toEqual([
      ['input', ['asks']],
      ['pinned', ['kept']],
      ['ended', ['gone']],
    ])
  })
})

describe('10a rows', () => {
  const now = new Date(2026, 9, 5, 13, 41).getTime()
  const wait = (patch: Partial<LimitWait> = {}): LimitWait => ({
    resetsAt: new Date(2026, 9, 5, 14, 5).toISOString(), windowKind: 'five_hour', windowLabel: '5-hour window',
    cancelled: false, willContinue: true, queued: [], ...patch,
  })

  it('names the gated step, and a parked call outranks the gate', () => {
    const gate = session('g', { status: 'needs_input', harnessGate: 'waiting', harnessStep: { index: 3, total: 7 } })
    expect(isGateRow(gate)).toBe(true)
    expect(inputReason(gate)).toBe('◆ Harness · step 4 of 7 needs your OK')
    expect(gateReason(null)).toBe('◆ Harness · needs your OK')
    const parked = { ...gate, pendingDecision: question }
    expect(isGateRow(parked)).toBe(false)
    expect(inputReason(parked)).toBe('Which branch?')
    expect(isGateRow(session('r', { status: 'needs_input', harnessGate: 'reviewing' }))).toBe(false)
  })

  it("says when a limit wait continues, in each of its forms", () => {
    const at = '14:05'
    expect(limitLine(session('w', { limitWait: wait({ queued: ['go on'] }) }), false, 'studio', now)).toBe(
      `Continues at ${at} · 5-hour window · 1 queued`,
    )
    expect(limitLine(session('w', { limitWait: wait() }), false, 'studio', now)).toBe(`Continues at ${at} · 5-hour window`)
    expect(limitLine(session('c', { limitWait: wait({ cancelled: true, willContinue: false }) }), false, 'studio', now)).toBe(
      `Limit resets ${at} · auto-continue cancelled`,
    )
    expect(limitLine(session('o', { limitWait: wait({ willContinue: false, autoContinue: false }) }), false, 'studio', now)).toBe(
      `Limit resets ${at} · automatic continue is off`,
    )
    expect(limitLine(session('a', { limitWait: wait() }), true, 'studio', now)).toBe(
      `Resets at ${at} — continues only if studio is awake then`,
    )
    expect(limitLine(session('t', { source: 'terminal', limitWait: wait() }), false, 'studio', now)).toBeNull()
    expect(limitLine(session('n'), false, 'studio', now)).toBeNull()
  })

  it('adds the tasks to the collapsed summary after the subagents', () => {
    const agents = [
      { id: 'a', name: 'tests', state: 'working' as const, startedAt: 1 },
      { id: 'b', name: 'lint', state: 'ended' as const, startedAt: 1, endedAt: 2 },
    ]
    const task: BackgroundTask = { id: 't', kind: 'shell', label: 'npm run dev', state: 'running', startedAt: 1, hasOutput: true }
    expect(moonsSummary(session('s', { subagents: agents }))).toEqual({ subagents: '2 subagents · 1 running', tasks: null })
    expect(moonsSummary(session('s', { subagents: agents, backgroundTasks: [task] }))).toEqual({
      subagents: '2 subagents · 1 running',
      tasks: '1 task',
    })
    expect(moonsSummary(session('s', { backgroundTasks: [task, { ...task, id: 'u' }] }))).toEqual({ subagents: null, tasks: '2 tasks' })
    expect(moonsSummaryAsleep(session('s', { subagents: agents, backgroundTasks: [task] }))).toBe('2 subagents · ▣ 1 task · last known')
    expect(moonsSummaryAsleep(session('s'))).toBeNull()
  })

  it('lists running tasks before ended ones', () => {
    const base: BackgroundTask = { id: '', kind: 'shell', label: '', state: 'ended', startedAt: 0, hasOutput: true }
    const tasks = tasksForRow([
      { ...base, id: 'old-ended', startedAt: 1 },
      { ...base, id: 'running', state: 'running', startedAt: 2 },
      { ...base, id: 'new-ended', startedAt: 3 },
    ])
    expect(tasks.map((t) => t.id)).toEqual(['running', 'new-ended', 'old-ended'])
  })
})
