import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withHarnessRows, pillReading } from '../lib/harnessSession'
import { listableSessions, useOrbital, visibleSessions } from '../store/store'
import { api } from '../lib/api'
import { stateDot } from '../lib/stateStyle'
import { sessionStateKey, statePill } from '../lib/types'
import type { ApiSession, ChatMessage, HarnessEvent, SessionHarness, StepState } from '../lib/types'
import { DEFAULT_HARNESS_OPTIONS } from '../lib/types'

const T0 = Date.parse('2026-10-02T21:00:00Z')
const at = (min: number) => T0 + min * 60_000
const iso = (min: number) => new Date(at(min)).toISOString()

function harness(state: StepState[], extra: Partial<SessionHarness> = {}): SessionHarness {
  return {
    sessionId: 's1',
    templateId: 1,
    name: 'Build a component',
    steps: state.map((_, i) => ({
      id: `step-${i + 1}`,
      title: `Step ${i + 1} title`,
      instructions: '',
      mode: i === 1 ? 'gate' : 'auto',
      doneWhen: '',
    })),
    inputs: {},
    state,
    options: DEFAULT_HARNESS_OPTIONS,
    paused: false,
    pauseReason: null,
    pauseKind: null,
    pausedAt: null,
    removedAt: null,
    autoRounds: 0,
    idleNudges: 0,
    createdAt: at(0),
    updatedAt: at(0),
    ...extra,
  }
}

const h = harness([{ status: 'done' }, { status: 'awaiting_approval' }, { status: 'pending' }])

let nextId = 1
const event = (min: number, kind: HarnessEvent['kind'], detail: Record<string, unknown> = {}): HarnessEvent => ({
  id: nextId++,
  sessionId: 's1',
  at: at(min),
  kind,
  detail,
})

const msg = (id: string, min: number | null, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  text: id,
  ...(min === null ? {} : { timestamp: iso(min) }),
  ...extra,
})

const shape = (rows: ChatMessage[]) => rows.map((r) => (r.role === 'harness' ? `◆ ${r.text}` : r.id))

describe('withHarnessRows', () => {
  it('lays each event in before the first message stamped after it', () => {
    const rows = withHarnessRows(
      [msg('a', 1), msg('b', 5), msg('c', 9)],
      // Newest first, as the log arrives.
      [event(7, 'resumed'), event(3, 'paused', { by: 'user' })],
      [h],
      null,
    )
    expect(shape(rows)).toEqual(['a', '◆ paused by you', 'b', '◆ resumed', 'c'])
  })

  it('keeps a message without a time where it is, and puts later events at the end', () => {
    const rows = withHarnessRows([msg('a', 1), msg('b', null), msg('c', 2)], [event(4, 'resumed')], [h], null)
    expect(shape(rows)).toEqual(['a', 'b', 'c', '◆ resumed'])
  })

  it('leaves out what happened before the oldest message held, until the history is read', () => {
    const events = [event(0, 'paused', { by: 'user' }), event(3, 'resumed')]
    expect(shape(withHarnessRows([msg('a', 2)], events, [h], at(2)))).toEqual(['a', '◆ resumed'])
    expect(shape(withHarnessRows([msg('a', 2)], events, [h], null))).toEqual(['◆ paused by you', 'a', '◆ resumed'])
  })

  it('turns Orbital’s own messages into harness rows, never the user’s', () => {
    const rows = withHarnessRows(
      [
        msg('k', 1, { role: 'user', harnessMessage: { kind: 'kickoff', step: 0 } }),
        msg('u', 2, { role: 'user' }),
        msg('s', 3, { role: 'user', harnessMessage: { kind: 'advance', step: 1 } }),
        msg('n', 4, { role: 'user', harnessMessage: { kind: 'nudge', step: 2 } }),
      ],
      [],
      [h],
      null,
    )
    expect(shape(rows)).toEqual([
      '◆ started · Build a component',
      'u',
      '◆ sent on to step 2 · Step 2 title',
      '◆ nudged · step 3',
    ])
  })

  it('a ticked gate stops for you in a row of its own — unless the reviewer takes it at once', () => {
    const tick = event(2, 'ticked', { step: 'step-2', index: 1, verify: 'passed', gate: true })
    expect(shape(withHarnessRows([msg('a', 1)], [tick], [h], null))).toEqual([
      'a',
      '◆ step 2 ticked · verify passed',
      '◆ stopped for you · step 2 is a gate',
    ])
    const review = event(2, 'review_started', { step: 'step-2', index: 1 })
    expect(shape(withHarnessRows([msg('a', 1)], [review, tick], [h], null))).toEqual([
      'a',
      '◆ step 2 ticked · verify passed',
      '◆ reviewer is reading step 2',
    ])
  })

  it('shows no row for what the messages already say', () => {
    const events = [event(2, 'attached'), event(3, 'advanced', { index: 1 }), event(4, 'nudged', { index: 1 }), event(5, 'options')]
    expect(shape(withHarnessRows([msg('a', 1)], events, [h], null))).toEqual(['a'])
  })
})

describe('pillReading', () => {
  it('reads a waiting gate as needs your OK, at its step', () => {
    const reading = pillReading(harness([{ status: 'done' }, { status: 'awaiting_approval', openQuestions: ['x', 'y'] }, { status: 'pending' }]))
    expect(reading).toMatchObject({ glyph: 'gate', count: '2/3', title: 'Step 2 title', status: 'needs your OK', detail: '2 open questions' })
  })

  it('a reviewer reading the gate, a pause and a finished run each have their own glyph', () => {
    expect(pillReading(harness([{ status: 'awaiting_approval', reviewing: true }])).glyph).toBe('eye')
    const paused = harness([{ status: 'active' }], { paused: true, pauseKind: 'session_ended' })
    expect(pillReading(paused)).toMatchObject({ glyph: 'pause', status: 'paused · the session ended' })
    expect(pillReading(harness([{ status: 'done' }, { status: 'done' }]))).toMatchObject({ glyph: 'done', count: '2/2' })
  })
})

describe('listableSessions', () => {
  const session = (id: string, lastAt: number, purpose: ApiSession['purpose'] = null): ApiSession =>
    ({ id, title: id, cwd: '/p', lastAt, tagIds: [], status: 'idle', subagents: [], purpose }) as unknown as ApiSession

  it('leaves a harness drafting conversation out of every list', () => {
    const sessions = { a: session('a', 1), d: session('d', 3, 'harness_draft'), b: session('b', 2) }
    expect(listableSessions({ sessions }).map((s) => s.id)).toEqual(['b', 'a'])
    const ui = { filterTagId: 'all' as const, search: '' }
    expect(visibleSessions({ sessions, ui } as unknown as Parameters<typeof visibleSessions>[0]).map((s) => s.id)).toEqual(['b', 'a'])
  })
})

describe('a waiting gate as the session state', () => {
  const base = { status: 'needs_input' as const, interruptedAt: null, pendingDecision: null, subagents: [], backgroundTasks: [] }

  it('reads NEEDS YOUR OK and counts as needs input; a reviewed gate keeps the session its own state', () => {
    expect(sessionStateKey({ ...base, harnessGate: 'waiting' })).toBe('needs_input')
    expect(statePill({ ...base, harnessGate: 'waiting' })?.label).toBe('NEEDS YOUR OK')
    expect(sessionStateKey({ ...base, harnessGate: 'reviewing' })).toBe('done')
  })

  it('holds the dot still', () => {
    expect(stateDot('needs_input', 'label', true).motion).toBe('steady')
    expect(stateDot('needs_input', 'label').motion).toBe('breathe')
  })
})

describe('the store', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getSessionHarness').mockResolvedValue({ harness: null, removed: null, events: [] })
    useOrbital.setState((s) => ({
      harnessPanel: null, subagentPanel: null, taskOutput: null, transcripts: { s1: [] },
      ui: { ...s.ui, selectedId: 's1' },
    }))
  })

  it('openHarness toggles the panel for the session', () => {
    useOrbital.getState().openHarness('s1')
    expect(useOrbital.getState().harnessPanel).toEqual({ sessionId: 's1' })
    useOrbital.getState().openHarness('s1')
    expect(useOrbital.getState().harnessPanel).toBeNull()
  })

  it('seats a harness message as Orbital’s, and its echo takes the same row', () => {
    const { applySessionEvent } = useOrbital.getState()
    applySessionEvent('s1', { event: 'harness_message', message: { uuid: 'u1', kind: 'advance', step: 3, text: 'Go on', at: at(1) } })
    applySessionEvent('s1', { event: 'message', message: { id: 'srv:1', role: 'user', uuid: 'u1', text: 'Go on' } })
    const rows = useOrbital.getState().transcripts.s1
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'srv:1', harnessMessage: { kind: 'advance', step: 3 } })
  })
})
