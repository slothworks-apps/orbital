import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import { modelNameForId } from '../lib/models'
import { SESSION_PARAM } from '../lib/sessionUrl'
import type { ApiSession, OrbitalModel, SessionStatsDetail } from '../lib/types'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { PageBar } from '../ui/PageBar'
import { FindingCard } from './FindingCard'
import { PANEL_CLASS, PANEL_LABEL_CLASS, TIME_CATEGORIES, TRACK_COLOR } from './constants'
import { findingTurnUuid, withSession } from './findingCopy'
import {
  formatCostAmount,
  formatPercent,
  formatSessionSpan,
  formatStatsDuration,
  formatTokens,
  splitTokens,
} from './format'
import { projectLabeller } from './projects'
import { busyMsOf, spanOf } from './rollup'
import { Scroller } from './Scroller'
import { STATS_PATH, readTurnParam, sessionStatsPath } from './route'
import { StatsShell } from './StatsShell'
import { TurnWaterfall, type WaterfallFocus } from './TurnWaterfall'

/**
 * `/stats/session/<id>` — canvas 10b. One session: where its time went, what
 * it cost, what the rules found and the turn it happened on.
 *
 * One request feeds the page, the same way the dashboard is fed by one: the
 * endpoint recomputes the turn timeline from the transcript on demand, so a
 * second read could answer from a transcript that has grown in between.
 */
export function SessionDrilldown({ id }: { id: string }) {
  const [detail, setDetail] = useState<SessionStatsDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [projects, setProjects] = useState<Array<{ cwd: string }>>([])
  const [models, setModels] = useState<OrbitalModel[]>([])

  // The turn to open on, from a finding the user clicked on the dashboard
  // (10e "click finding"). `seq` makes a repeat of the same request a new
  // request, so "jump to turn" scrolls again after the user has scrolled off.
  const [focus, setFocus] = useState<WaterfallFocus | null>(() => {
    const uuid = readTurnParam()
    return uuid === null ? null : { uuid, seq: 0 }
  })

  useEffect(() => {
    setDetail(null)
    api
      // The drilldown is the page that draws the waterfall, so it is one of the
      // two callers that pays for the on-demand timeline.
      .sessionStats(id, { timeline: true })
      .then((data) => {
        setDetail(data)
        setError(null)
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message || 'request failed' : String(err))
      })
  }, [id])

  useEffect(() => {
    void api.listProjects().then(setProjects).catch(() => setProjects([]))
    void api.listModels().then((r) => setModels(r.models)).catch(() => setModels([]))
  }, [])

  // The session's own row, for the bar only: its tag, path and status (25c).
  // The stats endpoint carries none of the three. A session Orbital does not
  // know leaves the bar with its crumbs and esc.
  const [session, setSession] = useState<ApiSession | null>(null)
  useEffect(() => {
    let live = true
    api.getSession(id).then(
      (data) => {
        if (live) setSession(data?.session ?? null)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [id])

  const jumpToTurn = useCallback(
    (uuid: string) => {
      setFocus((current) => ({ uuid, seq: (current?.seq ?? 0) + 1 }))
      // Replaced, not pushed: the highlight is where the page is, not a step
      // the user took — Back belongs to the feed they came from.
      window.history.replaceState(null, '', sessionStatsPath(id, uuid))
    },
    [id]
  )

  // ORBITAL / STATS / <session>; right, path · status chip · esc (canvas
  // `Feature - Page headers` 25c). Until the stats answer, the crumb reads
  // the head of the uuid, as the meta line does.
  const bar = (
    <PageBar
      route={{ page: 'drilldown', title: detail?.session.title ?? session?.title ?? id.slice(0, 8) }}
      surface="sky"
      session={session}
      onCrumb={{ stats: backToFindings }}
    />
  )

  return (
    <StatsShell sky="session" bar={bar}>
      {error !== null && (
        <div className="rounded-[14px] border border-[rgba(255,138,122,.35)] bg-[rgba(4,8,16,.45)] px-[14px] py-3 font-mono text-[11.5px] text-[#ff8a7a]">
          session stats unavailable — {error}
        </div>
      )}

      {detail === null && error === null && (
        <div className="flex flex-1 items-center justify-center font-mono text-[11.5px] text-[rgba(160,190,225,.5)]">
          reading the transcript…
        </div>
      )}

      {detail !== null && (
        <ErrorBoundary label="Session stats">
          <SessionMeta
            detail={detail}
            projectLabel={projectLabeller(projects)(detail.session.projectDir)}
            modelName={modelNameForId(
              // The transcript's own id is what was actually billed; the
              // requested one (`opus[1m]`) is the fallback for a session the
              // indexer has not resolved yet.
              detail.session.resolvedModel ?? detail.session.model ?? '',
              models
            )}
          />
          <SessionTiles detail={detail} />

          <div className="flex min-h-0 flex-1 gap-8">
            <div className="flex min-w-0 flex-col" style={{ flex: '880 1 0' }}>
              <TurnWaterfall turns={detail.turns} focus={focus} />
            </div>
            <div className="flex min-w-0 flex-col gap-4" style={{ flex: '448 1 0' }}>
              <SessionFindings detail={detail} onJump={jumpToTurn} />
              <MoneyPanel cost={detail.cost} />
            </div>
          </div>
        </ErrorBoundary>
      )}
    </StatsShell>
  )
}

/**
 * The way up, by the STATS crumb or ⌘[ (canvas `Feature - Page headers` 25c).
 * When the feed is the previous entry it goes back through history, which is
 * what restores the scroll position the user left it at (10e "click
 * finding"); otherwise it loads `/stats`. The crumb stays a real link, so a
 * ⌘-click still opens the feed in a tab of its own.
 */
function backToFindings(): void {
  const referrer = document.referrer
  const fromFeed =
    referrer !== '' &&
    new URL(referrer).origin === window.location.origin &&
    new URL(referrer).pathname === STATS_PATH
  if (fromFeed) window.history.back()
  else window.location.assign(STATS_PATH)
}

function SessionMeta({
  detail,
  projectLabel,
  modelName,
}: {
  detail: SessionStatsDetail
  projectLabel: string | null
  modelName: string
}) {
  const { session } = detail
  // The waterfall's footer counts the lanes it drew (`detail.turns.length`);
  // the header must say the same number, not the stored rollup's `turns`, which
  // the live recompute leaves up to ten turns stale. When the timeline came
  // back empty (an unreadable transcript) there is nothing to count, so the
  // stored figure stands in, marked as the rolled-up one it is.
  const turnsLabel =
    detail.turns.length > 0
      ? `${detail.turns.length} turns`
      : `${session.turns} turns (rolled up)`
  const meta = [
    projectLabel,
    // The head of the uuid, as every transcript filename and the canvas print it.
    session.id.slice(0, 8),
    modelName || null,
    formatSessionSpan(session.firstAt, session.lastAt),
    turnsLabel,
  ].filter((part): part is string => part !== null && part !== '')

  return (
    <div className="flex items-end gap-[14px]">
      <span
        className="mb-1.5 block h-[11px] w-[11px] rounded-full"
        style={{
          background: 'oklch(80% .13 210)',
          boxShadow: '0 0 10px oklch(80% .13 210 / .7)',
        }}
      />
      <div className="min-w-0">
        <h1 className="truncate text-[21px] font-bold tracking-[-0.01em]">{session.title}</h1>
        <div className="mt-[5px] truncate font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
          {meta.join(' · ')}
        </div>
      </div>
      <span className="flex-1" />
      {/* Leaves /stats for the map, which owns the transcript (ADR
          `selected-session-lives-in-the-url-query`). */}
      <a
        href={`/?${SESSION_PARAM}=${encodeURIComponent(session.id)}`}
        className="rounded-lg border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.5)] px-[13px] py-[7px] font-mono text-[11px] text-text-soft no-underline"
      >
        open transcript
      </a>
    </div>
  )
}

/** 10b's tile row: busy of elapsed, tokens, cost, and the four-way split. */
function SessionTiles({ detail }: { detail: SessionStatsDetail }) {
  const { rollup, cost, session } = detail
  const busyMs = busyMsOf(rollup)
  const { elapsedMs, idleMs } = spanOf(session, busyMs)

  const inputTotal = rollup.inputTokens + rollup.cacheReadTokens + rollup.cacheCreationTokens
  const tokens = splitTokens(inputTotal + rollup.outputTokens)
  const cachedRatio = inputTotal > 0 ? rollup.cacheReadTokens / inputTotal : null
  const share = (ms: number) => (busyMs > 0 ? ms / busyMs : 0)

  return (
    <div className="flex gap-3">
      <Tile label="BUSY TIME" weight={214}>
        <Hero value={formatStatsDuration(busyMs)} />
        <SubLine>
          {elapsedMs === null ? 'no measured span' : `of ${formatStatsDuration(elapsedMs)} elapsed`}
          {idleMs !== null && idleMs > 0 && ` · ${formatStatsDuration(idleMs)} idle`}
        </SubLine>
      </Tile>

      <Tile label="TOKENS" weight={214}>
        <Hero value={tokens.value} unit={tokens.unit} />
        <SubLine>
          out {formatTokens(rollup.outputTokens)}
          {cachedRatio !== null && ` · cached ${formatPercent(cachedRatio)}`}
        </SubLine>
      </Tile>

      {/* The cost tile is the one 10b borders in the critical hue: uncached
          input is what a drilldown is usually opened to explain. */}
      <Tile label="COST" weight={214} border="rgba(255,138,122,.3)">
        <Hero value={formatCostAmount(cost.total)} unit="$" unitLeading />
        <SubLine tone="#ff8a7a">${formatCostAmount(cost.uncachedInput)} uncached input</SubLine>
      </Tile>

      <Tile label="SPLIT" weight={634}>
        <div
          className="mt-2.5 flex h-2.5 overflow-hidden rounded-[3px]"
          style={{ background: TRACK_COLOR }}
        >
          {TIME_CATEGORIES.map((category) => (
            <div
              key={category.field}
              style={{ width: `${share(rollup[category.field]) * 100}%`, background: category.color }}
            />
          ))}
        </div>
        <div className="mt-[9px] flex flex-wrap gap-4 font-mono text-[10.5px] text-[rgba(160,190,225,.8)]">
          {TIME_CATEGORIES.map((category) => (
            <span key={category.field} className="flex items-center gap-1.5">
              <span
                className="block h-2 w-2 rounded-[2px]"
                style={{ background: category.color }}
              />
              {formatStatsDuration(rollup[category.field])}
            </span>
          ))}
        </div>
      </Tile>
    </div>
  )
}

function Tile({
  label,
  weight,
  border,
  children,
}: {
  label: string
  weight: number
  border?: string
  children: ReactNode
}) {
  return (
    <section
      aria-label={label}
      // 10b's own widths (214 / 214 / 214 / 634 over its 1360 content column)
      // as weights, so the row keeps the proportions at any window size.
      style={{ flex: `${weight} 1 0`, borderColor: border }}
      className={`${PANEL_CLASS} min-w-0 px-4 py-3.5`}
    >
      <div className={PANEL_LABEL_CLASS}>{label}</div>
      {children}
    </section>
  )
}

/** 10b's hero numeral: mono 30/1 at −.02em, the unit at 19 and .75 alpha — smaller than 10a's, which has three tiles to 10b's four. */
function Hero({
  value,
  unit,
  unitLeading = false,
}: {
  value: string
  unit?: string
  unitLeading?: boolean
}) {
  const unitSpan = unit ? (
    <span className="text-[19px] text-[rgba(200,225,255,.75)]">{unit}</span>
  ) : null
  return (
    <div className="mt-2 font-mono text-[30px] leading-none tracking-[-0.02em] text-text-bright">
      {unitLeading && unitSpan}
      {value}
      {!unitLeading && unitSpan}
    </div>
  )
}

function SubLine({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <div
      className="mt-[7px] font-mono text-[10.5px]"
      style={{ color: tone ?? 'rgba(160,190,225,.6)' }}
    >
      {children}
    </div>
  )
}

/**
 * FINDINGS IN THIS SESSION (10b): the same cards as the feed, in their
 * drilldown form — the page is already inside the session, so a card offers
 * the turn it blames instead of a link to where the reader already is.
 */
function SessionFindings({
  detail,
  onJump,
}: {
  detail: SessionStatsDetail
  onJump: (uuid: string) => void
}) {
  const turnIndexOf = (uuid: string | null): number | null => {
    if (uuid === null) return null
    const index = detail.turns.findIndex((turn) => turn.uuid === uuid)
    return index < 0 ? null : index
  }

  return (
    <section
      aria-label="Findings in this session"
      className={`${PANEL_CLASS} flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden px-[18px] py-4`}
    >
      <div className="flex items-baseline">
        <div className={PANEL_LABEL_CLASS}>FINDINGS IN THIS SESSION</div>
        <span className="flex-1" />
        <div className="font-mono text-[10px] text-[rgba(160,190,225,.45)]">
          {detail.findings.length}
        </div>
      </div>

      {detail.findings.length === 0 ? (
        <>
          <div className="font-mono text-[11px] leading-[1.55] text-[rgba(160,190,225,.6)]">
            nothing to report in this session
          </div>
          <span className="flex-1" />
        </>
      ) : (
        // A session fires at most one finding per rule, but three rules and a
        // long headline already outgrow 10b's panel — the same measured fade
        // the feed uses keeps the cadence line below in place.
        <Scroller wrapperClassName="flex-1" className="flex h-full flex-col gap-2.5 pr-1">
          {detail.findings.map((finding) => {
            const uuid = findingTurnUuid(finding.evidence)
            const turnIndex = turnIndexOf(uuid)
            return (
              <FindingCard
                // One finding per rule per session (the server keeps the worst).
                key={finding.rule}
                finding={withSession(finding, detail.session)}
                projectLabel={null}
                // A rule that names no turn, or names one this transcript no
                // longer holds, offers nothing to jump to rather than a guess.
                jump={
                  uuid !== null && turnIndex !== null
                    ? { turnIndex, onJump: () => onJump(uuid) }
                    : undefined
                }
              />
            )
          })}
        </Scroller>
      )}

      <div className="font-mono text-[10.5px] leading-[1.55] text-[rgba(160,190,225,.5)]">
        Rules run over the stored transcript when the session ends, and every 10 turns while it is
        live.
      </div>
    </section>
  )
}

/** The four priced lines of 10b's WHERE THE MONEY WENT, plus what subagents added. */
const COST_ROWS: Array<{ label: string; field: keyof SessionStatsDetail['cost']; color: string }> = [
  { label: 'uncached input', field: 'uncachedInput', color: '#ff8a7a' },
  { label: 'cache read', field: 'cacheRead', color: '#59e4f3' },
  { label: 'cache write', field: 'cacheWrite', color: '#59e4f3' },
  { label: 'output', field: 'output', color: '#b18cff' },
  // Priced from the subagents' own usage, so it is not part of the four above
  // and would otherwise be a gap between the rows and the total.
  { label: 'subagents', field: 'subagentTotal', color: '#67e0a3' },
]

function MoneyPanel({ cost }: { cost: SessionStatsDetail['cost'] }) {
  const rows = COST_ROWS.filter((row) => row.field !== 'subagentTotal' || cost.subagentTotal > 0)

  return (
    <section aria-label="Where the money went" className={`${PANEL_CLASS} px-[18px] py-4`}>
      <div className={PANEL_LABEL_CLASS}>WHERE THE MONEY WENT</div>
      <div className="mt-3 flex flex-col gap-[11px] font-mono text-[11.5px] text-text-bright">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-3">
            <span className="w-[132px] shrink-0 text-[rgba(160,190,225,.75)]">{row.label}</span>
            <span
              className="block h-[5px] flex-1 rounded-[3px]"
              style={{ background: TRACK_COLOR }}
            >
              <span
                className="block h-[5px] rounded-[3px]"
                style={{
                  width: `${cost.total > 0 ? (cost[row.field] / cost.total) * 100 : 0}%`,
                  background: row.color,
                }}
              />
            </span>
            <span className="w-[58px] shrink-0 text-right">${formatCostAmount(cost[row.field])}</span>
          </div>
        ))}
        <div className="mt-[3px] flex items-baseline border-t border-[rgba(150,205,255,.1)] pt-2.5">
          <span className="text-[rgba(160,190,225,.75)]">total</span>
          <span className="flex-1" />
          <span className="text-[17px]">${formatCostAmount(cost.total)}</span>
        </div>
      </div>
    </section>
  )
}
