import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import type { ApiSession, SessionStatsDetail } from '../lib/types'
import { TIME_CATEGORIES, TRACK_COLOR } from '../stats/constants'
import { formatCost, formatStatsDuration } from '../stats/format'
import { QuickStatsDialog } from '../stats/QuickStatsDialog'
import { busyMsOf, spanOf } from '../stats/rollup'
import { useOrbital } from '../store/store'
import { openToolUse } from './Transcript'

/**
 * The detail panel's stats readout (canvas 10g, the variant that ships): busy
 * time, cost and the four-colour split, legible without opening anything, and
 * the way in to the quick dialog (10f) when the split raises a question.
 *
 * It is a readout FIRST — a row, not a tab, because the detail panel is the
 * transcript and a tab would hide it.
 */

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
  id: string,
  reloadKey: number,
  pollMs: number | null,
  timeline: boolean
): SessionStatsDetail | null {
  const [detail, setDetail] = useState<SessionStatsDetail | null>(null)
  /** Discards a response for a session (or a request) that has since been superseded. */
  const request = useRef(0)
  const loadedId = useRef<string | null>(null)

  const load = useCallback(() => {
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

export function SessionStatsRow({
  session,
  className,
}: {
  session: ApiSession
  /** Layout only — where the row sits in the panel. */
  className?: string
}) {
  // WHICH session the dialog is open for, not a bare flag. The panel swaps
  // sessions under this component — it is never remounted per session — so a
  // flag would stay true across the swap and show the outgoing session's
  // numbers under the incoming one's name until something cleared it.
  // Comparing against the row's own session makes it false in the very render
  // that switched, which is also what starts the dialog's exit.
  const [openFor, setOpenFor] = useState<string | null>(null)
  const open = openFor === session.id
  /** The last numbers there were — what an exiting dialog goes on drawing. */
  const shownStats = useRef<SessionStatsDetail | null>(null)

  // And the name itself is dropped, once it is no longer this row's session.
  // The comparison above is not enough on its own: it answers "is it open
  // NOW", while the name it is answering about outlives the visit, so a
  // remembered one comes back true on the return trip (A → B → A) and raises
  // a dialog nobody asked for a second time.
  useEffect(() => {
    if (openFor !== null && openFor !== session.id) setOpenFor(null)
  }, [openFor, session.id])

  // "Numbers still moving" (10g): a session with a turn in flight.
  const live = session.status === 'working'
  // Bumped by the `stats` event on this session's topic — the server has
  // rewritten the row this reads.
  const revision = useOrbital((s) => s.statsRevision[session.id] ?? 0)
  const detail = useSessionStats(
    session.id,
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
  const messages = useOrbital((s) => s.transcripts[session.id])
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

  const content = (
    <>
      <div className="flex items-center gap-2.5 font-mono text-[10.5px] text-[#e8eef8]">
        session stats
        <span className="flex-1" />
        {stats !== null ? (
          <span className="text-[rgba(200,225,255,.8)] group-hover:text-[rgba(200,225,255,.9)] group-focus-visible:text-[rgba(200,225,255,.9)]">
            {formatStatsDuration(busyMs)} · {formatCost(stats.cost.total)}
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

  // 10g's shell: the panel's own chip. Its note says "1px rgba(150,205,255,.14),
  // no fill" while the chip it is written under is drawn over rgba(4,8,16,.4);
  // the drawing ships, as it does for the row's height.
  const shell = `block w-full rounded-[11px] border px-[13px] py-[11px] text-left ${className ?? ''}`
  const resting = 'border-[rgba(150,205,255,.14)] bg-[rgba(4,8,16,.4)]'

  // The dialog keeps the numbers it was opened on until it has finished
  // fading out, the way the panel keeps its outgoing session — otherwise
  // switching sessions cuts its exit short by taking its data away.
  if (stats !== null) shownStats.current = stats
  const dialogStats = stats ?? shownStats.current
  const dialog = dialogStats !== null && (
    <QuickStatsDialog
      open={open}
      detail={dialogStats}
      title={session.title}
      live={live}
      onClose={() => setOpenFor(null)}
    />
  )

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
        onClick={() => setOpenFor(session.id)}
        // Hover and focus are one state (10g: "focus ring = hover border"),
        // which is also what makes the row legible as one tab stop.
        className={[
          'group cursor-pointer transition-[background-color,border-color,box-shadow] duration-[120ms]',
          shell,
          resting,
          'hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.14)] hover:shadow-[0_0_22px_rgba(89,228,243,.1)]',
          'focus-visible:border-[rgba(150,205,255,.3)] focus-visible:bg-[rgba(150,205,255,.14)] focus-visible:shadow-[0_0_22px_rgba(89,228,243,.1)] focus-visible:outline-none',
        ].join(' ')}
      >
        {content}
      </button>
      {dialog}
    </>
  )
}
