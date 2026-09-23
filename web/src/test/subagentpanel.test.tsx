import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ApiSession, ChatMessage, Subagent } from '../lib/types'
import { useOrbital } from '../store/store'
import { SubagentPanel } from '../panels/SubagentPanel'

// Only `dismissSubagent` (task 9) actually calls `api` from this component —
// every other test in this file exercises pure rendering off store state
// already in place, never a fetch. Mocked the same way `subagentstore.test.ts`
// does it, so a test that forgets to stub a method resolves instead of
// throwing outside the test's own assertions.
vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())
import { api } from '../lib/api'

// ---------------------------------------------------------------------------
// SubagentPanel — the read-only panel itself (task 7 brief). Store wiring
// (open/close/swap/live-append/selection-closes) is covered by
// subagentstore.test.ts; this file covers the six states, the TRUNCATED
// modifier and the read-only guarantee.
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-1'

function makeSubagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: 'agent-1',
    name: 'Run the eslint and jest suites',
    state: 'working',
    toolUseId: 'tool-1',
    startedAt: 0,
    ...overrides,
  }
}

function makeSession(overrides: Partial<ApiSession> = {}): ApiSession {
  return {
    id: SESSION_ID,
    cwd: '/repo',
    title: 'auth-refactor',
    firstAt: 0,
    lastAt: 0,
    messageCount: 0,
    source: 'web',
    permissionMode: 'auto',
    model: null,
    resolvedModel: null,
    parentId: null,
    mapDismissedAt: null,
    tagIds: [],
    status: 'working',
    subagents: [],
    ...overrides,
  }
}

function renderPanel(opts: {
  subagent: Subagent
  messages?: ChatMessage[]
  droppedCount?: number
  found?: boolean
  parentMessages?: ChatMessage[]
  /**
   * What `sessions[SESSION_ID].subagents` holds — the LIVE list the panel
   * re-reads its agent out of (C1). Defaults to the opened agent itself,
   * which is the ordinary case and makes the live read a no-op; pass `[]`
   * for the server-restarted case, where the panel falls back to its own
   * stored snapshot.
   */
  sessionSubagents?: Subagent[]
}) {
  useOrbital.setState((s) => ({
    subagentPanel: {
      sessionId: SESSION_ID,
      subagent: opts.subagent,
      messages: opts.messages ?? [],
      droppedCount: opts.droppedCount ?? 0,
      found: opts.found ?? true,
    },
    sessions: {
      [SESSION_ID]: makeSession({ subagents: opts.sessionSubagents ?? [opts.subagent] }),
    },
    transcripts: { ...s.transcripts, [SESSION_ID]: opts.parentMessages ?? [] },
  }))
  return render(<SubagentPanel widthPx={380} />)
}

beforeEach(() => {
  useOrbital.setState({
    subagentPanel: null,
    sessions: {},
    transcripts: {},
    tags: [],
    models: [],
    pendingDecisions: {},
  })
})

describe('rendering the open agent', () => {
  it('renders the fetched messages', () => {
    renderPanel({
      subagent: makeSubagent(),
      messages: [{ id: 'm1', role: 'assistant', text: 'Lint is clean, starting jest.' }],
    })
    expect(screen.getByText('Lint is clean, starting jest.')).toBeInTheDocument()
  })

  it('renders nothing when no panel is open', () => {
    const { container } = render(<SubagentPanel widthPx={380} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('STREAM LOST vs an ordinary empty panel — the 404-vs-200 distinction', () => {
  it('404 (found: false) renders the STREAM LOST reason block and "elapsed unknown"', () => {
    const { container } = renderPanel({
      subagent: makeSubagent({ state: 'ended', status: 'completed' }),
      found: false,
    })
    expect(container.querySelector('[data-stream-lost-reason]')).toBeInTheDocument()
    expect(screen.getByText('elapsed unknown')).toBeInTheDocument()
    expect(container.querySelector('[data-task-state="stream_lost"]')).toBeInTheDocument()
  })

  it('a 200 with an empty list renders an ordinary empty panel, NOT stream lost', () => {
    const { container } = renderPanel({
      subagent: makeSubagent({ state: 'working' }),
      messages: [],
      found: true,
    })
    expect(container.querySelector('[data-stream-lost-reason]')).not.toBeInTheDocument()
    expect(screen.queryByText('TRANSCRIPT UNAVAILABLE')).not.toBeInTheDocument()
    expect(container.querySelector('[data-task-state="running"]')).toBeInTheDocument()
    // A live agent that has said nothing yet reads "elapsed unknown" only in
    // the STREAM LOST branch — here it is a real, ticking number.
    expect(screen.queryByText('elapsed unknown')).not.toBeInTheDocument()
  })
})

describe('TRUNCATED — a modifier, not a state', () => {
  it('renders the marker with both numbers and composes with RUNNING', () => {
    const { container } = renderPanel({
      subagent: makeSubagent({ state: 'working' }),
      messages: [
        { id: 'm1', role: 'assistant', text: 'tail of the run' },
        { id: 'm2', role: 'assistant', text: 'still going' },
      ],
      droppedCount: 1184,
    })

    const marker = container.querySelector('[data-truncated-marker]')
    expect(marker).toBeInTheDocument()
    expect(marker?.textContent).toContain('1,184')
    // "buffer N steps" names what the buffer currently holds — the length
    // of the messages actually returned, not a hardcoded server constant.
    expect(marker?.textContent).toContain('2')

    // Both present at once: the RUNNING badge and the TRUNCATED chip.
    expect(container.querySelector('[data-task-state="running"]')).toBeInTheDocument()
    expect(container.querySelector('[data-truncated]')).toBeInTheDocument()
  })

  it('does not render when nothing was dropped', () => {
    const { container } = renderPanel({ subagent: makeSubagent(), droppedCount: 0 })
    expect(container.querySelector('[data-truncated-marker]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-truncated]')).not.toBeInTheDocument()
  })
})

describe('the four state/status combinations, each its own badge', () => {
  it.each([
    [{ state: 'working' as const }, 'running'],
    [{ state: 'ended' as const, status: 'completed' as const }, 'completed'],
    [{ state: 'ended' as const, status: 'failed' as const }, 'failed'],
    [{ state: 'ended' as const, status: 'stopped' as const }, 'stopped'],
  ])('%o -> %s', (fields, expected) => {
    const { container } = renderPanel({ subagent: makeSubagent(fields) })
    expect(container.querySelector(`[data-task-state="${expected}"]`)).toBeInTheDocument()
  })
})

describe('elapsed — ticks while running, frozen on a terminal state', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('advances while RUNNING', () => {
    vi.setSystemTime(0)
    renderPanel({ subagent: makeSubagent({ state: 'working', startedAt: 0 }) })

    // `advanceTimersByTime` moves the fake clock FORWARD by this amount from
    // wherever it already sits — 5000ms on top of the `setSystemTime(0)`
    // above lands it at 5000, not back at 5000 from zero a second time.
    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(screen.getByText('5.0s')).toBeInTheDocument()
  })

  it('stays frozen on a terminal state even as time passes', () => {
    vi.setSystemTime(0)
    renderPanel({
      subagent: makeSubagent({ state: 'ended', status: 'completed', startedAt: 0 }),
      messages: [
        { id: 'm1', role: 'assistant', text: 'done', timestamp: new Date(3000).toISOString() },
      ],
    })
    expect(screen.getByText('3.0s')).toBeInTheDocument()

    act(() => {
      vi.setSystemTime(60_000)
      vi.advanceTimersByTime(60_000)
    })

    // Still the same reading — nothing ticks for a frozen state.
    expect(screen.getByText('3.0s')).toBeInTheDocument()
  })
})

describe('read-only means read-only', () => {
  it('renders no composer, no send control, and no interactive question affordance', () => {
    const questionMessage: ChatMessage = {
      id: 'q1',
      role: 'tool_use',
      toolName: 'AskUserQuestion',
      toolUseId: 'q1',
      toolInput: {
        questions: [
          {
            question: 'Which approach?',
            header: 'APPROACH',
            options: [
              { label: 'Rewrite', description: 'start over' },
              { label: 'Patch', description: 'incremental fix' },
            ],
            multiSelect: false,
          },
        ],
      },
    }
    const { container } = renderPanel({
      subagent: makeSubagent({ state: 'working' }),
      messages: [questionMessage],
    })

    // No composer: no text input anywhere in the panel.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument()

    // The question card rendered, but never in an answerable form — see the
    // next test for the case this one alone cannot rule out.
    const card = container.querySelector('[data-question-card]')
    expect(card).toBeInTheDocument()
    expect(card?.getAttribute('data-mode')).not.toBe('interactive')
    expect(card?.getAttribute('data-mode')).not.toBe('terminal')
    expect(screen.queryByRole('button', { name: 'Rewrite' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Patch' })).not.toBeInTheDocument()
  })

  /**
   * Task 7 review, finding 1. The test above passes even by ACCIDENT: with
   * no matching `pendingDecisions` entry, `QuestionCard`'s own `isPending`
   * check is false regardless of whether the panel does anything to force
   * it. That accident is exactly what this test rules out.
   *
   * `decide()` (`server/src/runner/runner.ts`) does not read the SDK's
   * `opts.agentID`, so a subagent whose own toolset includes
   * `AskUserQuestion` produces a `decision_pending` on the PARENT's
   * `session:<id>` topic keyed by the SUBAGENT's own `toolUseId` — which is
   * exactly the `id` `forwardSubagentText` then mirrors into this panel's
   * `messages`. Seeding `pendingDecisions[SESSION_ID]` with that same id
   * reproduces the real condition: `isPending` reads true. The panel must
   * still render non-interactively — that is what `TranscriptView`'s
   * `readOnly` prop (threaded to `QuestionCard`) is for, unconditionally,
   * not by inferring it from whether an id happens to collide.
   *
   * This test is written to FAIL if that inference — "the ids can never
   * match, so nothing else is needed" — is ever reintroduced in place of
   * the explicit prop.
   */
  it('stays non-interactive even when pendingDecisions DOES match the question (finding 1)', () => {
    const questionMessage: ChatMessage = {
      id: 'q1',
      role: 'tool_use',
      toolName: 'AskUserQuestion',
      toolUseId: 'subagent-question-1',
      toolInput: {
        questions: [
          {
            question: 'Which approach?',
            header: 'APPROACH',
            options: [
              { label: 'Rewrite', description: 'start over' },
              { label: 'Patch', description: 'incremental fix' },
            ],
            multiSelect: false,
          },
        ],
      },
    }

    useOrbital.setState({
      pendingDecisions: {
        [SESSION_ID]: {
          id: 'subagent-question-1', // == the subagent's own tool_use id
          kind: 'question',
          input: questionMessage.toolInput as never,
          createdAt: 0,
        },
      },
    })

    const { container } = renderPanel({
      subagent: makeSubagent({ state: 'working' }),
      messages: [questionMessage],
    })

    const card = container.querySelector('[data-question-card]')
    expect(card).toBeInTheDocument()
    // The one assertion the accidental id-mismatch could never have failed:
    // `isPending` is true here, and the card is STILL not interactive.
    expect(card?.getAttribute('data-mode')).not.toBe('interactive')
    expect(card?.getAttribute('data-mode')).not.toBe('terminal')
    expect(screen.queryByRole('button', { name: 'Rewrite' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Patch' })).not.toBeInTheDocument()
  })
})

describe('the elapsed ticker does not outlive the panel (finding 2)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stops the ticking interval once the panel closes', () => {
    vi.setSystemTime(0)
    renderPanel({ subagent: makeSubagent({ state: 'working', startedAt: 0 }) })
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')

    act(() => {
      useOrbital.setState({ subagentPanel: null })
    })

    // The buggy version gated the effect on a `taskState` that FALLS BACK TO
    // `'running'` when `panel` is null — so closing never changed the value
    // the effect depends on, the effect never re-ran, and its cleanup (this
    // `clearInterval` call) never fired: the interval kept ticking a
    // `setNowMs` for a component now rendering nothing.
    expect(clearSpy).toHaveBeenCalled()
  })

  it('resets immediately when swapping directly to a different RUNNING agent', () => {
    vi.setSystemTime(0)
    renderPanel({ subagent: makeSubagent({ id: 'agent-a', toolUseId: 'tool-a', startedAt: 0 }) })

    // Two ticks land (t=1000, t=2000); real time is now 2500 but the
    // component's own `nowMs` sits at 2000 until the next tick at t=3000 —
    // an inherent, harmless 1s-granularity gap for the SAME agent.
    act(() => {
      vi.advanceTimersByTime(2500)
    })

    // `openSubagent` replaces the slot in one `set()` call — `subagentPanel`
    // goes directly from one agent to another and never passes through
    // null — so this reproduces that swap without an intervening close.
    // Agent B has ALSO been running since t=0, exactly like agent A, so a
    // correct immediate reset and a stale `nowMs` disagree on its elapsed
    // reading by a clean, non-zero amount (2.5s vs 2.0s) rather than both
    // collapsing to the same clamped-at-zero value a "just started" agent
    // would have produced either way.
    act(() => {
      useOrbital.setState((s) => ({
        subagentPanel: s.subagentPanel && {
          ...s.subagentPanel,
          subagent: makeSubagent({ id: 'agent-b', toolUseId: 'tool-b', startedAt: 0 }),
          messages: [],
          droppedCount: 0,
        },
      }))
    })

    // Correct: the swap reset `nowMs` to the true current time (2500ms),
    // giving agent B a fresh 2.5s reading. The bug would still show "2.0s"
    // — agent A's stale, unreset `nowMs` carried straight over.
    expect(screen.getByText('2.5s')).toBeInTheDocument()
    expect(screen.queryByText('2.0s')).not.toBeInTheDocument()
  })
})

/**
 * C1, the whole-branch review's first Critical, and the one lifecycle test
 * the spec asked for that nothing performed ("freeze on `task_notification`",
 * spec § 11).
 *
 * Every other test in this file — and in `detail.test.tsx` / `app.test.tsx`
 * — SEEDS an already-ended agent. That is the one path on which the frozen
 * states were reachable: `openSubagent` stored the `Subagent` by value, once,
 * and `applySessionsEvent` replaces `sessions[id]` wholesale, so the live
 * `state`/`status` landed on a new object the panel did not hold. A panel
 * opened on a running moon stayed RUNNING forever — blinking dot, clock
 * still counting, and no "dismiss moon" control, since that is gated on
 * `state === 'ended'`.
 *
 * So this drives the TRANSITION, which is the only thing that can fail for a
 * reason other than someone editing the value it asserts.
 */
describe('the agent ending under an open panel (C1)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** The `sessions` upsert a `task_notification` produces, as the WS delivers
   * it: a brand new `Subagent` object inside a brand new `ApiSession`. */
  function endTheAgent(ended: Subagent) {
    act(() => {
      useOrbital.getState().applySessionsEvent({
        event: 'upsert',
        session: makeSession({ subagents: [ended] }),
      })
    })
  }

  it('switches the badge, freezes elapsed and reveals the dismiss control', () => {
    vi.setSystemTime(0)
    const running = makeSubagent({ id: 'agent-1', state: 'working', startedAt: 0 })
    const { container } = renderPanel({
      subagent: running,
      messages: [
        { id: 'm1', role: 'assistant', text: 'done', timestamp: new Date(3000).toISOString() },
      ],
    })

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(container.querySelector('[data-task-state="running"]')).toBeInTheDocument()
    expect(screen.getByText('5.0s')).toBeInTheDocument()
    expect(screen.queryByText('dismiss moon')).not.toBeInTheDocument()

    endTheAgent(makeSubagent({ id: 'agent-1', state: 'ended', status: 'completed', startedAt: 0 }))

    expect(container.querySelector('[data-task-state="completed"]')).toBeInTheDocument()
    // Frozen at the last message's own timestamp, not at whatever the clock
    // read when the notification landed.
    expect(screen.getByText('3.0s')).toBeInTheDocument()
    expect(screen.getByText('dismiss moon')).toBeInTheDocument()

    // And it stays frozen: the ticking interval is gone with the state.
    act(() => {
      vi.setSystemTime(60_000)
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByText('3.0s')).toBeInTheDocument()
  })

  it('reads the live status, not the one the panel was opened with', () => {
    const running = makeSubagent({ id: 'agent-1', state: 'working' })
    const { container } = renderPanel({ subagent: running })

    endTheAgent(makeSubagent({ id: 'agent-1', state: 'ended', status: 'failed' }))

    expect(container.querySelector('[data-task-state="failed"]')).toBeInTheDocument()
  })

  it('falls back to the stored snapshot when the session no longer carries the agent', () => {
    // The server-restarted shape: `loadInitial` repopulates `sessions` with
    // `subagents: []`. The header must still name the agent the user opened
    // rather than blanking — what turns this into STREAM LOST is `found`,
    // written by the refetch `resyncAfterReconnect` now performs.
    const { container } = renderPanel({
      subagent: makeSubagent({ state: 'working', name: 'Run the eslint and jest suites' }),
      sessionSubagents: [],
    })

    expect(screen.getByText('Run the eslint and jest suites')).toBeInTheDocument()
    expect(container.querySelector('[data-task-state="running"]')).toBeInTheDocument()
  })
})

describe('dismissal (task 9 brief § 3)', () => {
  it('shows "dismiss moon" only once the agent has ended', () => {
    renderPanel({ subagent: makeSubagent({ state: 'working' }) })
    expect(screen.queryByText('dismiss moon')).not.toBeInTheDocument()
  })

  it('calls the API with the agent id (not the toolUseId) and does not close the panel itself', () => {
    renderPanel({
      subagent: makeSubagent({ id: 'agent-1', toolUseId: 'tool-1', state: 'ended', status: 'completed' }),
    })

    fireEvent.click(screen.getByText('dismiss moon'))

    expect(api.dismissSubagent).toHaveBeenCalledWith(SESSION_ID, 'agent-1')
    // No optimistic removal (task 9 brief § 3: "pick one and say which") —
    // the panel stays exactly as it was; only a real `sessions` republish
    // ever takes the moon off the map.
    expect(useOrbital.getState().subagentPanel).not.toBeNull()
  })
})

describe('⎋ closes the panel (task 9 brief item 9)', () => {
  it('closes through the shared escape layer, not a listener of its own', () => {
    renderPanel({ subagent: makeSubagent({ state: 'working' }) })
    expect(useOrbital.getState().subagentPanel).not.toBeNull()

    // Dispatched on `document`, exactly like `escapelayer.test.tsx`'s own
    // `pressEscape` — it propagates up to the shared capture-phase listener
    // on `window`, the way a real keystroke does.
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(useOrbital.getState().subagentPanel).toBeNull()
  })
})
