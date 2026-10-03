import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { SessionStatsDetail, StatsRollup, StatsTurnSegment } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { StatsPage } from '../stats/StatsPage'
import { TURNS_PER_PAGE } from '../stats/waterfall'

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

function turn(uuid: string, apiMs: number): StatsTurnSegment {
  return {
    requestId: `req-${uuid}`,
    uuid,
    startTs: 0,
    apiMs,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    tools: [],
  }
}

function detail(patch: Partial<SessionStatsDetail> = {}): SessionStatsDetail {
  return {
    session: {
      id: '4b2f19c8-0000-4000-8000-000000000001',
      title: 'refactor map layer',
      projectDir: '-Users-t-work-orbital',
      model: 'sonnet',
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
  window.history.replaceState(null, '', '/stats/session/4b2f19c8-0000-4000-8000-000000000001')
  vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/Users/t/work/orbital', lastModel: null, lastAt: null }])
  vi.mocked(api.listModels).mockResolvedValue({ models: [], contextWindows: {} })
  vi.mocked(api.getSettings).mockResolvedValue({})
})

const route = { kind: 'session', id: '4b2f19c8-0000-4000-8000-000000000001' } as const

describe('SessionDrilldown', () => {
  it('reads the session the path names', async () => {
    vi.mocked(api.sessionStats).mockResolvedValue(detail())

    render(<StatsPage route={route} />)

    await screen.findByRole('heading', { name: 'refactor map layer' })
    // The drilldown draws the waterfall, so it asks for the on-demand timeline.
    expect(api.sessionStats).toHaveBeenCalledWith(route.id, { timeline: true })
  })

  it('offers the turn a finding blames, counted in the session, not in the sort', async () => {
    vi.mocked(api.sessionStats).mockResolvedValue(
      detail({
        findings: [
          { rule: 'obese-tool-result', severity: 'warning', evidence: { turnUuid: 'uuid-c' } },
        ],
      })
    )

    render(<StatsPage route={route} />)

    // Third turn chronologically, and the shortest — the waterfall opens
    // longest-first, and the label must not follow that order.
    expect(await screen.findByRole('button', { name: /jump to turn 3/ })).toBeInTheDocument()
  })

  it('offers no jump for a finding naming a turn this transcript no longer holds', async () => {
    vi.mocked(api.sessionStats).mockResolvedValue(
      detail({
        findings: [
          { rule: 'cache-burn', severity: 'critical', evidence: { firstTurnUuid: 'uuid-gone' } },
        ],
      })
    )

    render(<StatsPage route={route} />)

    await screen.findByText(/Prompt cache invalidated/)
    expect(screen.queryByRole('button', { name: /jump to turn/ })).not.toBeInTheDocument()
  })

  it('pages the waterfall and stops at both ends', async () => {
    const turns = Array.from({ length: TURNS_PER_PAGE + 3 }, (_, i) =>
      turn(`uuid-${i}`, (i + 1) * 1_000)
    )
    vi.mocked(api.sessionStats).mockResolvedValue(detail({ turns }))

    render(<StatsPage route={route} />)

    await screen.findByText(`showing turns 1–${TURNS_PER_PAGE} of ${turns.length}`)
    expect(screen.getByRole('button', { name: '‹ prev' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'next ›' }))

    expect(
      screen.getByText(`showing turns ${TURNS_PER_PAGE + 1}–${turns.length} of ${turns.length}`)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'next ›' })).toBeDisabled()
  })

  it('says so when the transcript yielded no timeline, instead of an empty panel', async () => {
    vi.mocked(api.sessionStats).mockResolvedValue(detail({ turns: [] }))

    render(<StatsPage route={route} />)

    expect(await screen.findByText('no turns measured in this transcript')).toBeInTheDocument()
  })
})
