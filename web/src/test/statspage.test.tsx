import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { StatsOverview, StatsTotals } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { StatsPage } from '../stats/StatsPage'
import { installKeyListener } from '../lib/commands'
import { MAP_PATH } from '../lib/pageCrumbs'
import { stubLocationAssign } from './stubLocationAssign'

const totals: StatsTotals = {
  inputTokens: 400_000,
  outputTokens: 100_000,
  cacheReadTokens: 600_000,
  cacheCreationTokens: 0,
  cachedRatio: 0.6,
  apiMs: 3_600_000,
  localToolMs: 600_000,
  mcpMs: 300_000,
  subagentMs: 0,
  busyMs: 4_500_000,
  humanWaitMs: 0,
  questionCount: 0,
  planCount: 0,
  permissionCount: 0,
  timedSessionCount: 0,
  wallClockMs: 9_000_000,
  costTotal: 12.5,
  costPerSession: 2.5,
  sessionCount: 5,
}

function overview(patch: Partial<StatsOverview> = {}): StatsOverview {
  return {
    filters: { window: '7d', project: null, model: null },
    sessionCount: 5,
    windowStart: Date.UTC(2026, 8, 14),
    windowEnd: Date.UTC(2026, 8, 20),
    totals,
    previousTotals: null,
    costDeltaPct: 18.4,
    daySeries: [
      {
        day: '2026-09-18',
        apiMs: 3_600_000,
        localToolMs: 600_000,
        mcpMs: 300_000,
        subagentMs: 0,
        busyMs: 4_500_000,
        humanWaitMs: 0,
      },
    ],
    cacheRatioSeries: [{ day: '2026-09-18', ratio: 0.6 }],
    toolLeaderboard: {
      slowest: [
        {
          tool: 'mcp__sentry__search_issues',
          isMcp: true,
          calls: 62,
          errors: 0,
          ms: 300_000,
          p50Ms: 11_300,
          resultChars: 40_000,
        },
      ],
      mostExpensive: [],
      human: [],
    },
    findings: [
      {
        rule: 'error-loop',
        severity: 'critical',
        sessionId: 'sess-1',
        title: 'fix flaky suite',
        projectDir: '-Users-t-work-api',
        when: Date.UTC(2026, 8, 19, 21, 36),
        evidence: { tool: 'Bash', count: 9 },
      },
    ],
    ...patch,
  }
}

beforeEach(() => {
  window.history.replaceState(null, '', '/stats')
  vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/Users/t/work/api', lastModel: null }])
  vi.mocked(api.listModels).mockResolvedValue({ models: [], contextWindows: {} })
  vi.mocked(api.getSettings).mockResolvedValue({})
})

describe('StatsPage', () => {
  it('asks the endpoint for the window the URL names', async () => {
    window.history.replaceState(null, '', '/stats?window=30d&project=-Users-t-work-api')
    vi.mocked(api.statsOverview).mockResolvedValue(overview())

    render(<StatsPage route={{ kind: 'dashboard' }} />)

    await waitFor(() =>
      expect(api.statsOverview).toHaveBeenCalledWith({
        window: '30d',
        project: '-Users-t-work-api',
        model: null,
      })
    )
  })

  it('writes a filter change into the URL and re-reads the window', async () => {
    vi.mocked(api.statsOverview).mockResolvedValue(overview())
    render(<StatsPage route={{ kind: 'dashboard' }} />)
    await screen.findByLabelText('Findings')

    fireEvent.click(screen.getByRole('button', { name: '24h' }))

    await waitFor(() =>
      expect(api.statsOverview).toHaveBeenLastCalledWith({
        window: '24h',
        project: null,
        model: null,
      })
    )
    expect(window.location.search).toBe('?window=24h')
  })

  it('shows the empty state instead of zeroed charts when the window measured nothing', async () => {
    vi.mocked(api.statsOverview).mockResolvedValue(
      overview({ sessionCount: 0, findings: [], daySeries: [], cacheRatioSeries: [] })
    )

    render(<StatsPage route={{ kind: 'dashboard' }} />)

    expect(await screen.findByText('Nothing measured yet')).toBeInTheDocument()
    expect(screen.queryByLabelText('Findings')).not.toBeInTheDocument()
    // Controller ruling: the CTA is "start a session", alone.
    expect(screen.getByRole('button', { name: 'start a session' })).toBeInTheDocument()
    expect(screen.queryByText(/import past transcripts/i)).not.toBeInTheDocument()
  })

  it('links a finding to its session drilldown', async () => {
    vi.mocked(api.statsOverview).mockResolvedValue(overview())

    render(<StatsPage route={{ kind: 'dashboard' }} />)

    const card = await screen.findByRole('link', { name: /Same failing Bash call retried 9/ })
    expect(card).toHaveAttribute('href', '/stats/session/sess-1')
  })

  it('carries the turn a finding blames into the drilldown URL', async () => {
    vi.mocked(api.statsOverview).mockResolvedValue(
      overview({
        findings: [
          {
            rule: 'cache-burn',
            severity: 'critical',
            sessionId: 'sess-1',
            title: 'fix flaky suite',
            projectDir: '-Users-t-work-api',
            when: Date.UTC(2026, 8, 19, 21, 36),
            evidence: { turnsAffected: 31, totalTurns: 44, firstTurnUuid: 'uuid-12' },
          },
        ],
      })
    )

    render(<StatsPage route={{ kind: 'dashboard' }} />)

    const card = await screen.findByRole('link', { name: /Prompt cache invalidated/ })
    expect(card).toHaveAttribute('href', '/stats/session/sess-1?turn=uuid-12')
  })

  it('stays put on ⌘2, since it is already the stats page, while ⌘1 still leaves for the map', async () => {
    vi.mocked(api.statsOverview).mockResolvedValue(overview())
    const uninstall = installKeyListener()
    const { assign, restore } = stubLocationAssign()
    try {
      render(<StatsPage route={{ kind: 'dashboard' }} />)
      await screen.findByLabelText('Findings')

      fireEvent.keyDown(window, { key: '2', code: 'Digit2', metaKey: true })
      expect(assign).not.toHaveBeenCalled()

      fireEvent.keyDown(window, { key: '1', code: 'Digit1', metaKey: true })
      expect(assign).toHaveBeenCalledWith(MAP_PATH)
    } finally {
      restore()
      uninstall()
    }
  })
})
