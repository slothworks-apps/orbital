import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../lib/api'
import type { ApiSession, SessionStatsDetail } from '../lib/types'
import { TIME_CATEGORIES, TRACK_COLOR } from '../stats/constants'
import { formatCost, formatStatsDuration } from '../stats/format'
import { QuickStatsDialog } from '../stats/QuickStatsDialog'
import { busyMsOf, spanOf } from '../stats/rollup'
import { useOrbital } from '../store/store'
import { StatsGlyph, UtilityButton } from '../ui/UtilityButton'
import { openToolUse } from './Transcript'

/**
 * The detail panel's stats readout (canvas 10g, the variant that ships): busy
 * time, cost and the four-colour split, legible without opening anything, and
 * the way in to the quick dialog (10f) when the split raises a question.
 *
 * It is a readout FIRST — a row, not a tab, because the detail panel is the
 * transcript and a tab would hide it.
 *
 * `Feature - Header gauges` then gave it a second shape and an off switch.
 * Both live here rather than in two components because everything that is
 * hard about this — which session the dialog is open for, when the stored
 * stats are re-read, when the dialog polls — is the same in both, and only
 * the last twenty lines differ.
 */

/**
 * Which shape the readout takes, from the `header_session_stats` setting
 * (canvas `Feature - Header gauges` 11c):
 *
 * - `bar` — the strip at the foot of the header, flush with the context
 *   gauge above it (11b variant A).
 * - `button` — one 24px icon in the header's utility strip, with no readout
 *   at all; every number is behind the dialog it opens.
 */
export type StatsRowVariant = 'bar' | 'button'

/**
 * How often the dialog re-reads a live session while it is open. The row
 * outside it is driven by the server's `stats` event, but the dialog draws the
 * turn timeline, which is derived per request and is not part of the stored
 * row the event announces — so the one surface that shows it polls for it, for
 * as long as it is open and no longer.
 */
export const QUICK_STATS_REFRESH_MS = 10_000

/**
 * How long a `stats` event waits for its neighbours before the row acts on it.
 * Two cadences can rewrite one session's rollup within a few milliseconds —
 * the live recompute and the indexer's pass — and each read costs a whole
 * transcript reparse, so the second one is worth waiting for.
 */
const STATS_RELOAD_COALESCE_MS = 250

/** What the row reads with nothing to report yet (10g: "session stats · —"). */
const NO_VALUE = '—'

/**
 * The session's stored stats.
 *
 * Read once when the panel opens the session, then only when `reloadKey`
 * moves: the server announces every `session_stats` write on the session's own
 * topic and the store counts them (ADR
 * `the-stats-row-reads-when-the-stats-are-written`). Nothing else re-reads —
 * a turn starting or ending does not rewrite the stored row, and a read that
 * returns what is already on screen is a transcript reparse spent on nothing.
 *
 * Previous numbers stay on screen across a re-read: the row must not empty and
 * refill itself under the reader.
 */
function useSessionStats(
  id: string | null,
  reloadKey: number,
  pollMs: number | null,
  timeline: boolean
): SessionStatsDetail | null {
  const [detail, setDetail] = useState<SessionStatsDetail | null>(null)
  /** Discards a response for a session (or a request) that has since been superseded. */
  const request = useRef(0)
  const loadedId = useRef<string | null>(null)

  const load = useCallback(() => {
    if (id === null) return
    const token = (request.current += 1)
    api
      // The row itself never draws the timeline, so it reads without it; only
      // while the dialog is open does the read pay for the turn waterfall it
      // needs (ADR `the-stats-row-reads-when-the-stats-are-written`).
      .sessionStats(id, { timeline })
      .then((next) => {
        // A body without a rollup is not a session's stats. The row is the one
        // stats surface on a screen that is not about stats, so it shows its
        // empty state rather than taking the panel down with it.
        if (token === request.current && next?.rollup !== undefined) setDetail(next)
      })
      .catch(() => {
        // A session the stats index has never seen 404s. That is the same
        // state as one with no turns yet — the row already says so, and a
        // readout is not worth an error toast over the panel.
      })
  }, [id, timeline])

  useEffect(() => {
    // A session the row has not read yet has nothing on screen to protect, so
    // it reads at once; a re-read of the same session waits out the burst.
    if (loadedId.current !== id) {
      loadedId.current = id
      setDetail(null)
      load()
      return
    }
    const timer = setTimeout(load, STATS_RELOAD_COALESCE_MS)
    return () => clearTimeout(timer)
  }, [id, reloadKey, load])

  useEffect(() => {
    if (pollMs === null) return
    const timer = setInterval(load, pollMs)
    return () => clearInterval(timer)
  }, [pollMs, load])

  return detail
}

/**
 * Everything the readout knows about one session, for whichever surface
 * draws it: the row, the strip's icon, or the header's ⋯ menu (canvas
 * `Feature - Header actions` 23c form 4, whose stats row carries the numbers
 * inline) — and the dialog they all open.
 */
export interface StatsReadout {
  /** The stored stats, or null below one measured turn (nothing to open). */
  stats: SessionStatsDetail | null
  busyMs: number
  /** Busy time and cost ("2h 22m · $167.30"), or null while there is nothing to show. */
  summary: string | null
  /** A running turn with no tool call open: the agent is inside an API call. */
  inApiCall: boolean
  /** What the row's split is drawn against (see the row). */
  denominator: number
  /** Whether the quick dialog is open for this session. */
  open: boolean
  /** Open the quick dialog. Does nothing while there is nothing to show. */
  show: () => void
  /** The quick dialog itself — render it once, wherever the readout is used. */
  dialog: ReactNode
}

/**
 * The readout's state, for one session or for none (`null`: the header has
 * no stats button, so nothing is read).
 */
export function useStatsReadout(session: ApiSession | null): StatsReadout {
  const sessionId = session?.id ?? null
  // WHICH session the dialog is open for, not a bare flag. The panel swaps
  // sessions under this component — it is never remounted per session — so a
  // flag would stay true across the swap and show the outgoing session's
  // numbers under the incoming one's name until something cleared it.
  // Comparing against the row's own session makes it false in the very render
  // that switched, which is also what starts the dialog's exit.
  const [openFor, setOpenFor] = useState<string | null>(null)
  const open = sessionId !== null && openFor === sessionId
  /** The last numbers there were — what an exiting dialog goes on drawing. */
  const shownStats = useRef<SessionStatsDetail | null>(null)

  // And the name itself is dropped, once it is no longer this row's session.
  // The comparison above is not enough on its own: it answers "is it open
  // NOW", while the name it is answering about outlives the visit, so a
  // remembered one comes back true on the return trip (A → B → A) and raises
  // a dialog nobody asked for a second time.
  useEffect(() => {
    if (openFor !== null && openFor !== sessionId) setOpenFor(null)
  }, [openFor, sessionId])

  // "Numbers still moving" (10g): a session with a turn in flight.
  const live = session?.status === 'working'
  // Bumped by the `stats` event on this session's topic — the server has
  // rewritten the row this reads.
  const revision = useOrbital((s) => (sessionId !== null ? (s.statsRevision[sessionId] ?? 0) : 0))
  const detail = useSessionStats(
    sessionId,
    revision,
    open && live ? QUICK_STATS_REFRESH_MS : null,
    // The timeline is the dialog's alone: opening it re-reads with the
    // waterfall, closing it drops back to the rollup-only read.
    open
  )

  // The dot of 10g's live state: the agent is inside an API call right now,
  // which is a running turn with no tool call open. Read off the transcript
  // the panel is already streaming — the same pairing the stop confirm uses to
  // name the call it would discard.
  const messages = useOrbital((s) => (sessionId !== null ? s.transcripts[sessionId] : undefined))
  const inApiCall = useMemo(
    () => live && openToolUse(messages ?? []) === undefined,
    [live, messages]
  )

  // Below one turn there is nothing measured to show, and nothing for the
  // dialog to open on to (spec § Edge cases) — which is also what the row
  // shows for the moment between the panel opening and the numbers landing.
  const stats = detail !== null && detail.rollup.turns >= 1 ? detail : null
  const busyMs = stats !== null ? busyMsOf(stats.rollup) : 0

  const elapsedMs = stats !== null ? spanOf(stats.session, busyMs).elapsedMs : null
  // A live session's bar does not fill the track (10g): while the session
  // runs, the split is drawn against the wall clock, so what is left of it
  // reads as the idle it is. Busy can exceed the clock when tools overlap, and
  // the bar then fills rather than overflowing.
  const denominator = live && elapsedMs !== null ? Math.max(busyMs, elapsedMs) : busyMs

  // The dialog keeps the numbers it was opened on until it has finished
  // fading out, the way the panel keeps its outgoing session — otherwise
  // switching sessions cuts its exit short by taking its data away.
  if (stats !== null) shownStats.current = stats
  const dialogStats = stats ?? shownStats.current
  const dialog = session !== null && dialogStats !== null && (
    <QuickStatsDialog
      open={open}
      detail={dialogStats}
      title={session.title}
      live={live}
      onClose={() => setOpenFor(null)}
    />
  )

  return {
    stats,
    busyMs,
    summary: stats !== null ? `${formatStatsDuration(busyMs)} · ${formatCost(stats.cost.total)}` : null,
    inApiCall,
    denominator,
    open,
    show: () => {
      if (sessionId !== null && stats !== null) setOpenFor(sessionId)
    },
    dialog,
  }
}

/**
 * The readout as one 24px icon in the header's utility strip (canvas
 * `Feature - Header gauges` 11c). The button only — the caller renders
 * `readout.dialog` once, which lets the header's ⋯ menu open the same dialog
 * while this button is folded away.
 */
export function SessionStatsButton({
  readout,
  className,
}: {
  readout: StatsReadout
  /** Layout only. */
  className?: string
}) {
  const { stats, busyMs, inApiCall, open, show } = readout
  // 11c: the numbers leave the header, so the name of the control has to
  // carry them — for the pointer (native `title`, which is what the
  // artboard asks for) and for a screen reader alike.
  const label =
    stats !== null
      ? `Session stats — ${formatStatsDuration(busyMs)}, ${formatCost(stats.cost.total)}`
      : 'Session stats'
  return (
    <UtilityButton
      data-session-stats-button
      aria-label={label}
      title={label}
      // 11c's DIALOG OPEN state is the strip's own active fill, and
      // NO DATA is simply a button with nothing to open.
      active={open}
      disabled={stats === null}
      onClick={show}
      className={`relative ${className ?? ''}`}
    >
      <StatsGlyph />
      {/* 11c's LIVE dot. The artboard draws it 5px, inset 4px, on a 32px
          state swatch; the strip's button is 24px, so it keeps the
          proportion rather than the literal — any bigger and it collides
          with the glyph's tallest bar. */}
      {inApiCall && (
        <span
          aria-hidden
          className="orbital-pulse absolute top-[3px] right-[3px] block h-1 w-1 rounded-full"
          style={{ background: TIME_CATEGORIES[0].color }}
        />
      )}
    </UtilityButton>
  )
}

export function SessionStatsRow({
  session,
  variant = 'bar',
  className,
}: {
  session: ApiSession
  variant?: StatsRowVariant
  /** Layout only — where the row sits in the panel. */
  className?: string
}) {
  const readout = useStatsReadout(session)
  const { stats, summary, inApiCall, denominator, show, dialog } = readout

  if (variant === 'button') {
    return (
      <>
        <SessionStatsButton readout={readout} className={className} />
        {dialog}
      </>
    )
  }

  const content = (
    <>
      <div className="flex items-center gap-2.5 font-mono text-[10.5px] text-[#e8eef8]">
        session stats
        <span className="flex-1" />
        {summary !== null ? (
          <span className="text-[rgba(200,225,255,.8)] group-hover:text-[rgba(200,225,255,.9)] group-focus-visible:text-[rgba(200,225,255,.9)]">
            {summary}
          </span>
        ) : (
          <span className="text-[rgba(200,225,255,.8)]">{NO_VALUE}</span>
        )}
        {inApiCall && (
          <span
            aria-hidden
            className="orbital-pulse block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: TIME_CATEGORIES[0].color }}
          />
        )}
        {/* No chevron on a row that does not open anything. */}
        {stats !== null && (
          <span
            aria-hidden
            className="text-[rgba(160,190,225,.6)] group-hover:text-[#8fd8ff] group-focus-visible:text-[#8fd8ff]"
          >
            ›
          </span>
        )}
      </div>
      <div
        className="mt-[9px] flex h-1.5 overflow-hidden rounded-[2px]"
        style={{ background: TRACK_COLOR }}
      >
        {stats !== null &&
          TIME_CATEGORIES.map((category) => (
            <div
              key={category.field}
              style={{
                width: `${denominator > 0 ? (stats.rollup[category.field] / denominator) * 100 : 0}%`,
                background: category.color,
              }}
            />
          ))}
      </div>
    </>
  )

  // The shell is `Feature - Header gauges` 11b variant A, which replaced
  // 10g's chip: the chip's 13px padding and 1px border were what made this
  // bar 28px narrower than the context gauge directly above it, and two
  // nearly-equal widths read as a broken grid rather than as two objects. So
  // the box goes and a hairline takes over the job of separating the strip
  // from the gauge — both bars now run to the header's own padding.
  const shell = `block w-full border-t pt-[13px] text-left ${className ?? ''}`
  const resting = 'border-[rgba(150,205,255,.1)]'

  if (stats === null) {
    return (
      <>
        <div data-session-stats-row className={`${shell} ${resting}`}>
          {content}
        </div>
        {dialog}
      </>
    )
  }

  return (
    <>
      <button
        type="button"
        data-session-stats-row
        onClick={show}
        // Hover and focus are one state (10g: "focus ring = hover border"),
        // which is also what makes the row legible as one tab stop. With the
        // chip gone there is no box left to fill, so the press cue is the
        // hairline lifting, plus the chevron the content already brightens
        // (11b, A: "hover lifts the hairline + chevron").
        className={[
          'group cursor-pointer transition-[border-color] duration-[120ms]',
          shell,
          resting,
          'hover:border-[rgba(150,205,255,.22)]',
          'focus-visible:border-[rgba(150,205,255,.22)] focus-visible:outline-none',
        ].join(' ')}
      >
        {content}
      </button>
      {dialog}
    </>
  )
}

