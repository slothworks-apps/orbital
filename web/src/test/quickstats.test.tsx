import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type {
  ApiSession,
  SessionStatsDetail,
  StatsRollup,
  StatsTurnSegment,
} from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { SessionStatsRow } from '../panels/SessionStatsRow'
import { slowestTurns, SLOWEST_TURN_COUNT, turnLabel } from '../stats/waterfall'
import { useOrbital } from '../store/store'

const SESSION_ID = '4b2f19c8-0000-4000-8000-000000000001'

function makeSession(patch: Partial<ApiSession> = {}): ApiSession {
  return {
    id: SESSION_ID,
    cwd: '/Users/t/work/orbital',
    title: 'refactor map layer',
    firstAt: new Date(2026, 8, 18, 13, 4).getTime(),
    lastAt: new Date(2026, 8, 18, 14, 41).getTime(),
    messageCount: 12,
    source: 'web',
    permissionMode: null,
    model: null,
    resolvedModel: 'claude-sonnet-4-6',
    tagIds: [],
    status: 'idle',
    subagents: [],
    ...patch,
  }
}

function rollup(patch: Partial<StatsRollup> = {}): StatsRollup {
  return {
    humanWaitMs: 0,
    humanBreakdown: {},
    permissionBreakdown: {},
    permissionTimed: true,
    apiMs: 600_000,
    localToolMs: 120_000,
    mcpMs: 0,
    subagentMs: 0,
    turns: 3,
    inputTokens: 200_000,
    outputTokens: 40_000,
    cacheReadTokens: 800_000,
    cacheCreationTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    thinkingTokens: 0,
    subagentTokens: 0,
    subagentUsage: {},
    toolCalls: 4,
    toolErrors: 0,
    toolBreakdown: {},
    findings: [],
    ...patch,
  }
}

function turn(uuid: string, apiMs: number, tools: StatsTurnSegment['tools'] = []): StatsTurnSegment {
  return {
    requestId: `req-${uuid}`,
    uuid,
    startTs: 0,
    apiMs,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    tools,
  }
}

function tool(name: string, ms: number): StatsTurnSegment['tools'][number] {
  return { name, kind: 'local', ms, isError: false, resultChars: 0, useId: `use-${name}-${ms}` }
}

function detail(patch: Partial<SessionStatsDetail> = {}): SessionStatsDetail {
  return {
    session: {
      id: SESSION_ID,
      title: 'refactor map layer',
      projectDir: '-Users-t-work-orbital',
      model: null,
      resolvedModel: 'claude-sonnet-4-6',
      firstAt: new Date(2026, 8, 18, 13, 4).getTime(),
      lastAt: new Date(2026, 8, 18, 14, 41).getTime(),
      turns: 3,
    },
    rollup: rollup(),
    cost: {
      uncachedInput: 21.4,
      cacheRead: 3.05,
      cacheWrite: 1.62,
      output: 1.53,
      mainTotal: 27.6,
      subagentTotal: 0,
      total: 27.6,
    },
    findings: [],
    turns: [turn('uuid-a', 30_000), turn('uuid-b', 90_000), turn('uuid-c', 10_000)],
    ...patch,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null }, transcripts: {} }))
})

// ---------------------------------------------------------------------------
// The trigger row (canvas 10g)
// ---------------------------------------------------------------------------

describe('SessionStatsRow', () => {
  it('reads the session out and offers the dialog', async () => {
    vi.mocked(api.sessionStats).mockResolvedValue(detail())

    render(<SessionStatsRow session={makeSession()} />)

    const row = await screen.findByRole('button', { name: /session stats/ })
    // 12m busy (10m API + 2m local tools) and the priced total.
    expect(row).toHaveTextContent('12m 00s')
    expect(row).toHaveTextContent('$27.60')
    // The row draws only the rollup and cost, so its read never asks for the
    // timeline reparse (ADR `the-stats-row-reads-when-the-stats-are-written`).
    expect(api.sessionStats).toHaveBeenCalledWith(SESSION_ID, { timeline: false })
  })

  it('reads without the timeline for the row, and with it once the dialog opens', async () => {
    vi.mocked(api.sessionStats).mockResolvedValue(detail())

    render(<SessionStatsRow session={makeSession()} />)
    const row = await screen.findByRole('button', { name: /session stats/ })
    expect(api.sessionStats).toHaveBeenCalledWith(SESSION_ID, { timeline: false })
    expect(api.sessionStats).not.toHaveBeenCalledWith(SESSION_ID, { timeline: true })

    // Opening the dialog — the one surface that draws the waterfall — is what
    // pays for the timeline.
    fireEvent.click(row)
    await waitFor(() =>
      expect(api.sessionStats).toHaveBeenCalledWith(SESSION_ID, { timeline: true })
    )
  })

  it('has nothing to show and no way in below one turn', async () => {
    vi.mocked(api.sessionStats).mockResolvedValue(
      detail({ rollup: rollup({ turns: 0, apiMs: 0, localToolMs: 0 }), turns: [] })
    )

    render(<SessionStatsRow session={makeSession()} />)

    await waitFor(() => expect(api.sessionStats).toHaveBeenCalled())
    expect(screen.getByText('session stats')).toBeInTheDocument()
    expect(await screen.findByText('—')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('re-reads when the server says this session\'s stats were rewritten', async () => {
    vi.mocked(api.sessionStats).mockResolvedValue(detail())

    render(<SessionStatsRow session={makeSession()} />)
    await screen.findByRole('button', { name: /session stats/ })
    expect(api.sessionStats).toHaveBeenCalledTimes(1)

    act(() => {
      useOrbital.getState().applySessionEvent(SESSION_ID, { event: 'stats' })
    })

    await waitFor(() => expect(api.sessionStats).toHaveBeenCalledTimes(2))
  })

  it('does not re-read when the session merely starts or finishes a turn', async () => {
    vi.mocked(api.sessionStats).mockResolvedValue(detail())

    const { rerender } = render(<SessionStatsRow session={makeSession()} />)
    await screen.findByRole('button', { name: /session stats/ })

    rerender(<SessionStatsRow session={makeSession({ status: 'working' })} />)
    rerender(<SessionStatsRow session={makeSession({ status: 'idle' })} />)

    // The rollup is not rewritten at a turn boundary — the server says when it
    // is (ADR `the-stats-row-reads-when-the-stats-are-written`).
    await waitFor(() => expect(screen.getByRole('button', { name: /session stats/ })).toBeVisible())
    expect(api.sessionStats).toHaveBeenCalledTimes(1)
  })

  it('shows the em dash until the numbers land, without becoming a button', () => {
    // A promise that never settles: the fetch window the row has to sit through.
    vi.mocked(api.sessionStats).mockReturnValue(new Promise(() => {}))

    render(<SessionStatsRow session={makeSession()} />)

    expect(screen.getByText('session stats')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Button-only mode (canvas `Feature - Header gauges` 11c)
// ---------------------------------------------------------------------------

describe('SessionStatsRow — button variant', () => {
  it('drops the readout and carries the numbers in its name instead', async () => {
    vi.mocked(api.sessionStats).mockResolvedValue(detail())

    render(<SessionStatsRow session={makeSession()} variant="button" />)

    const button = await screen.findByRole('button', {
      name: 'Session stats — 12m 00s, $27.60',
    })
    // Nothing is read out in the header: the whole point of the mode is the
    // 42px it gives back to the transcript.
    expect(button).toHaveTextContent('')
    expect(screen.queryByText('session stats')).not.toBeInTheDocument()
  })

  it('opens the same dialog the strip does', async () => {
    vi.mocked(api.sessionStats).mockResolvedValue(detail())

    render(<SessionStatsRow session={makeSession()} variant="button" />)
    fireEvent.click(await screen.findByRole('button', { name: /Session stats/ }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('$27.60')
    // Opening it is what buys the timeline read (ADR
    // `the-stats-row-reads-when-the-stats-are-written`) — the icon itself
    // needs no more than the strip did.
    expect(api.sessionStats).toHaveBeenCalledWith(SESSION_ID, { timeline: false })
    await waitFor(() =>
      expect(api.sessionStats).toHaveBeenCalledWith(SESSION_ID, { timeline: true })
    )
  })

  it('is not clickable with nothing measured yet (11c, NO DATA)', () => {
    vi.mocked(api.sessionStats).mockReturnValue(new Promise(() => {}))

    render(<SessionStatsRow session={makeSession()} variant="button" />)

    const button = screen.getByRole('button', { name: 'Session stats' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// The quick dialog (canvas 10f / 10e "detail panel → stats")
// ---------------------------------------------------------------------------

describe('QuickStatsDialog', () => {
  async function openDialog(patch: Partial<SessionStatsDetail> = {}) {
    vi.mocked(api.sessionStats).mockResolvedValue(detail(patch))
    const view = render(<SessionStatsRow session={makeSession()} />)
    const row = await screen.findByRole('button', { name: /session stats/ })
    fireEvent.click(row)
    await screen.findByRole('dialog')
    return { row, rerender: view.rerender }
  }

  it('closes on Escape', async () => {
    await openDialog()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes on ✕', async () => {
    await openDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Close session stats' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes when the panel moves to another session, and does not re-open', async () => {
    const { rerender } = await openDialog()
    const other = makeSession({ id: 'other-session', title: 'other' })
    vi.mocked(api.sessionStats).mockResolvedValue(
      detail({ session: { ...detail().session, id: other.id, title: other.title } })
    )

    rerender(<SessionStatsRow session={other} />)

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // The other session's numbers land here; a dialog nobody asked for must
    // not come up with them.
    await screen.findByRole('button', { name: /session stats/ })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    // And back again. The panel keeps this component across the whole trip,
    // so an open dialog remembered from the first visit would come up here.
    vi.mocked(api.sessionStats).mockResolvedValue(detail())
    rerender(<SessionStatsRow session={makeSession()} />)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /12m 00s/ })).toBeInTheDocument()
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names the three slowest turns and links on to the full stats', async () => {
    await openDialog()

    // 90s, 30s, 10s — longest first, labelled by chronological position.
    const rows = screen.getAllByTestId('slowest-turn')
    expect(rows.map((r) => r.getAttribute('data-turn'))).toEqual(['T02', 'T01', 'T03'])
    expect(screen.getByRole('link', { name: /full stats/ })).toHaveAttribute(
      'href',
      `/stats/session/${SESSION_ID}`
    )
  })

  it('keeps every phase of a many-phase turn inside the track, tail and all', async () => {
    // API wait plus eight tool calls — nine phases on one row. The widest turn's
    // shares sum to the track fill, so with a gap added after each phase the
    // last segment used to run past 100% and be swallowed by overflow-hidden.
    const busy = turn(
      'busy',
      10_000,
      Array.from({ length: 8 }, (_, i) => tool(`t${i}`, 10_000))
    )
    await openDialog({ turns: [busy, turn('b', 2_000), turn('c', 1_000)] })

    const row = screen
      .getAllByTestId('slowest-turn')
      .find((r) => r.getAttribute('data-turn') === turnLabel(0))
    expect(row).toBeDefined()
    const segments = Array.from(row!.querySelectorAll<HTMLElement>('span')).filter(
      (s) => s.style.left.endsWith('%') && s.style.width.endsWith('%')
    )
    expect(segments).toHaveLength(9)
    for (const seg of segments) {
      const right = parseFloat(seg.style.left) + parseFloat(seg.style.width)
      expect(right).toBeLessThanOrEqual(100)
    }
  })

  it('offers the turn a finding blames, counted in the session', async () => {
    await openDialog({
      findings: [
        { rule: 'obese-tool-result', severity: 'warning', evidence: { turnUuid: 'uuid-c' } },
      ],
    })

    const link = screen.getByRole('link', { name: /turn 3/ })
    expect(link).toHaveAttribute('href', `/stats/session/${SESSION_ID}?turn=uuid-c`)
  })
})

// ---------------------------------------------------------------------------
// Slowest-turn selection (the pure part)
// ---------------------------------------------------------------------------

describe('slowestTurns', () => {
  it('ranks by the time the turn cost, longest first', () => {
    const picked = slowestTurns([
      turn('a', 10_000, [tool('Read', 5_000)]),
      turn('b', 90_000),
      turn('c', 40_000),
      turn('d', 1_000),
    ])

    expect(picked.map((t) => t.index)).toEqual([1, 2, 0])
    expect(picked.map((t) => t.busyMs)).toEqual([90_000, 40_000, 15_000])
    expect(picked).toHaveLength(SLOWEST_TURN_COUNT)
  })

  it('keeps ties in the order the session ran them', () => {
    const picked = slowestTurns([turn('a', 5_000), turn('b', 5_000), turn('c', 5_000)])

    expect(picked.map((t) => t.index)).toEqual([0, 1, 2])
    expect(picked.map((t) => turnLabel(t.index))).toEqual(['T01', 'T02', 'T03'])
  })

  it('leaves out turns that measured nothing', () => {
    const picked = slowestTurns([turn('a', 0), turn('b', 8_000), turn('c', 0)])

    expect(picked.map((t) => t.index)).toEqual([1])
  })

  it('scales every phase against the slowest turn, so the rows share one ruler', () => {
    const picked = slowestTurns([
      turn('a', 100_000, [tool('Read', 100_000)]),
      turn('b', 50_000),
    ])

    expect(picked[0].phases.map((p) => p.share)).toEqual([0.5, 0.5])
    expect(picked[1].phases.map((p) => p.share)).toEqual([0.25])
  })

  it('has nothing to rank in a session with no turns', () => {
    expect(slowestTurns([])).toEqual([])
  })
})
