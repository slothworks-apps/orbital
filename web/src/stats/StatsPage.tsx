import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { OrbitalModel, StatsOverview } from '../lib/types'
import { NEW_SESSION_PARAM } from '../lib/sessionUrl'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { BusyPerDayChart } from './BusyPerDayChart'
import { CacheRatioChart } from './CacheRatioChart'
import { FindingsFeed } from './FindingsFeed'
import { StatsEmpty } from './StatsEmpty'
import { StatsFilterBar } from './StatsFilterBar'
import { StatsShell, StatsHeader } from './StatsShell'
import { StatsTiles } from './StatsTiles'
import { SessionDrilldown } from './SessionDrilldown'
import { ToolLeaderboard } from './ToolLeaderboard'
import { readStatsFilters, statsUrl, type StatsFilters } from './filters'
import { projectLabeller } from './projects'
import type { StatsRoute } from './route'
import { fillDaySeries } from './series'

/**
 * `/stats` — the two stats screens, mounted INSTEAD of `App` (see `main.tsx`),
 * the same way `/sandbox` is. Their own screen, not a panel over the map: they
 * open no WebSocket and load no session state, so they cost nothing while the
 * map is the thing being used, and a broken map cannot take the stats down
 * with it.
 *
 * The drilldown is a sibling rather than a section of the dashboard: it reads
 * a different endpoint, and the dashboard's window request has no business
 * running while one session is being read.
 */
export function StatsPage({ route }: { route: StatsRoute }) {
  if (route.kind === 'session') return <SessionDrilldown id={route.id} />
  return <StatsDashboard />
}

/**
 * The dashboard of canvas 10a. One request feeds every panel: the filters
 * apply to all of them, and two requests could answer from two different
 * windows.
 */
function StatsDashboard() {
  const [filters, setFilters] = useState<StatsFilters>(() => readStatsFilters())
  const [overview, setOverview] = useState<StatsOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [projects, setProjects] = useState<Array<{ cwd: string }>>([])
  const [models, setModels] = useState<OrbitalModel[]>([])

  // Only the newest request may write: filters can change faster than the
  // server answers, and an older response landing last would show a window
  // nobody is looking at.
  const requestSeq = useRef(0)

  useEffect(() => {
    const seq = ++requestSeq.current
    api
      .statsOverview(filters)
      .then((data) => {
        if (requestSeq.current !== seq) return
        setOverview(data)
        setError(null)
      })
      .catch((err: unknown) => {
        if (requestSeq.current !== seq) return
        // Shown on the page rather than pushed through `lib/errors`: that
        // helper posts a toast into the store, and this screen renders no
        // toast surface (the map owns it).
        setError(err instanceof ApiError ? err.message || 'request failed' : String(err))
      })
  }, [filters])

  useEffect(() => {
    void api.listProjects().then(setProjects).catch(() => setProjects([]))
    void api.listModels().then((r) => setModels(r.models)).catch(() => setModels([]))
  }, [])

  // Filters live in the URL (10e): a filtered dashboard survives a reload and
  // can be pasted. Pushed rather than replaced, so Back undoes a filter change
  // the way it undoes any other step.
  const applyFilters = useCallback((next: StatsFilters) => {
    setFilters(next)
    window.history.pushState(null, '', statsUrl(next))
  }, [])

  useEffect(() => {
    const onPopState = () => setFilters(readStatsFilters())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const projectLabel = projectLabeller(projects)
  // The empty state is its own artboard, sky included: 10c lights one soft
  // radial behind the middle of the page, where the unmeasured planet sits,
  // instead of 10a's two off-centre washes behind panels that are not there.
  const empty = overview !== null && overview.sessionCount === 0

  return (
    <StatsShell sky={empty ? 'empty' : 'dashboard'}>
      <StatsHeader crumb="/ STATS" actions={<DashboardNav />} />

      <StatsFilterBar
        filters={filters}
        projects={projects}
        models={models}
        summary={
          overview === null
            ? null
            : {
                sessionCount: overview.sessionCount,
                windowStart: overview.windowStart,
                windowEnd: overview.windowEnd,
              }
        }
        onChange={applyFilters}
      />

      {error !== null && (
        <div className="rounded-[14px] border border-[rgba(255,138,122,.35)] bg-[rgba(4,8,16,.45)] px-[14px] py-3 font-mono text-[11.5px] text-[#ff8a7a]">
          stats unavailable — {error}
        </div>
      )}

      {overview === null && error === null && (
        <div className="flex flex-1 items-center justify-center font-mono text-[11.5px] text-[rgba(160,190,225,.5)]">
          reading transcripts…
        </div>
      )}

      {overview !== null &&
        (overview.sessionCount === 0 ? (
          <StatsEmpty onStartSession={() => window.location.assign(`/?${NEW_SESSION_PARAM}=1`)} />
        ) : (
          <ErrorBoundary label="Stats">
            <Dashboard overview={overview} projectLabel={projectLabel} />
          </ErrorBoundary>
        ))}
    </StatsShell>
  )
}

/** 10a's right-hand header pair, the second half of which this screen is. */
function DashboardNav() {
  return (
    <nav className="flex items-center gap-[18px] font-mono text-[11px] tracking-[0.08em]">
      {/* A real link, not a router push: `/` mounts `App`, which this screen
          deliberately does not have loaded. */}
      <a href="/" className="text-[rgba(160,190,225,.6)] no-underline hover:text-text-soft">
        MAP
      </a>
      <span className="border-b border-accent pb-[3px] text-text-bright">STATS</span>
    </nav>
  )
}

/**
 * The 10a grid: a left column of charts and a right column of findings, in
 * the canvas's own 880 / 448 proportion over its 1360px content width.
 */
function Dashboard({
  overview,
  projectLabel,
}: {
  overview: StatsOverview
  projectLabel: (projectDir: string | null) => string | null
}) {
  const days = fillDaySeries(overview.daySeries, overview.windowStart, overview.windowEnd)

  return (
    <div className="flex flex-1 flex-col gap-4">
      <StatsTiles
        totals={overview.totals}
        costDeltaPct={overview.costDeltaPct}
        window={overview.filters.window}
      />

      <div className="flex min-h-0 flex-1 gap-8">
        <div className="flex min-w-0 flex-col gap-4" style={{ flex: '880 1 0' }}>
          <BusyPerDayChart days={days} />
          <CacheRatioChart series={overview.cacheRatioSeries} ratio={overview.totals.cachedRatio} />
          <ToolLeaderboard leaderboard={overview.toolLeaderboard} totals={overview.totals} />
        </div>
        <div className="flex min-w-0 flex-col" style={{ flex: '448 1 0' }}>
          <FindingsFeed
            findings={overview.findings}
            sessionCount={overview.sessionCount}
            projectLabel={projectLabel}
          />
        </div>
      </div>
    </div>
  )
}
