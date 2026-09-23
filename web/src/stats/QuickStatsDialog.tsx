import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SessionStatsDetail } from '../lib/types'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import { usePresence } from '../ui/usePresence'
import {
  EXITING,
  MODAL_CLOSED,
  MODAL_ENTER_DURATION,
  MODAL_ENTER_MS,
  MODAL_EXIT_DURATION,
  MODAL_EXIT_MS,
  MODAL_OPEN,
  MODAL_TRANSITION,
  SCRIM_CLOSED,
  SCRIM_OPEN,
} from '../ui/motion'
import { SEVERITY_STYLES, TIME_CATEGORIES, TRACK_COLOR } from './constants'
import { findingCopy, findingTurnUuid, withSession } from './findingCopy'
import { formatCostAmount, formatPercent, formatStatsDuration, splitTokens } from './format'
import { busyMsOf, spanOf } from './rollup'
import { sessionStatsPath } from './route'
import { MIN_SEGMENT_PX, slowestTurns, turnLabel } from './waterfall'

/**
 * The quick-stats dialog (canvas 10f), opened from the detail panel's readout
 * row and from nowhere else — 10e's "detail panel → stats": 584px, centred,
 * over a 4px-blurred scrim, Esc or ✕ closing it back to the row it came from.
 *
 * It answers one question — where did this session's time and money go — and
 * hands everything longer to `/stats/session/<id>`. It therefore holds no
 * request of its own: the row has already read the session, and passes what it
 * read down, so opening the dialog costs nothing and the two can never show
 * different numbers.
 *
 * Built on `createPortal` + `useEscapeLayer` + `usePresence` rather than on
 * `ui/Dialog`, for the reason the file viewer and the lightbox are: 10f is its
 * own surface (its own scrim, radius, header and ✕), not the form-dialog
 * chrome `Dialog` transcribes from artboards 1d/5b.
 */

/** 10f's SLOWEST TURNS rows, as percentages of the track they share.
 *
 * The widest row is drawn a little short of the full track and each phase is
 * parted from the next by a hairline, both read off 10f's own T07 — a row that
 * ran edge to edge would read as a bar that had been capped. */
const SLOWEST_TRACK_FILL_PCT = 94
const SLOWEST_SEGMENT_GAP_PCT = 1

/** The category whose time the † caveat is about (10e: local tool time
 * includes the wait on a permission prompt). */
const CAVEAT_FIELD = 'localToolMs'

const CAVEAT_INK = '#ffbb7b'

export interface QuickStatsDialogProps {
  open: boolean
  detail: SessionStatsDetail
  /**
   * The session's name as the panel has it. Not `detail.session.title`: a
   * rename lands in the panel immediately and in a re-read of the stats
   * whenever the next one happens, and the two headings must agree.
   */
  title: string
  /** A session still running: its last turn is the one in flight (10e). */
  live: boolean
  onClose: () => void
}

export function QuickStatsDialog({ open, detail, title, live, onClose }: QuickStatsDialogProps) {
  useEscapeLayer(open, onClose)
  // Held mounted through the close transition, like every other modal surface.
  const { mounted, state } = usePresence(open, MODAL_ENTER_MS, MODAL_EXIT_MS)

  const surfaceRef = useRef<HTMLDivElement | null>(null)

  // Focus returns to whatever opened the dialog (10e: "Esc or ✕ closes it and
  // returns focus to the tab") — captured as this effect runs and restored by
  // its cleanup, the same shape the file viewer uses.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => opener?.focus()
  }, [open])

  // And moves into the dialog once the surface exists. Its own effect keyed on
  // `mounted`, because the render that opens the dialog has no surface yet:
  // `usePresence` mounts it on the commit after, and an effect keyed on `open`
  // alone would only ever see a null ref.
  useEffect(() => {
    if (open && mounted) surfaceRef.current?.focus()
  }, [open, mounted])

  if (!mounted) return null

  const entered = state === 'entered'
  const duration = state === 'exiting' ? MODAL_EXIT_DURATION : MODAL_ENTER_DURATION

  const { session, rollup, cost } = detail
  const busyMs = busyMsOf(rollup)
  const { elapsedMs, idleMs } = spanOf(session, busyMs)
  const inputTotal = rollup.inputTokens + rollup.cacheReadTokens + rollup.cacheCreationTokens
  const tokens = splitTokens(inputTotal + rollup.outputTokens)

  return createPortal(
    <EscapeBoundary>
      <div
        data-state={state}
        // Still painted on the way out, but no longer a surface that takes
        // clicks or focus — see EXITING in `ui/motion`.
        inert={state === 'exiting' || undefined}
        onClick={onClose}
        // 10e: backdrop rgba(2,4,9,.58) + 4px blur.
        className={[
          'orbital-no-drag fixed inset-0 z-50 grid place-items-center bg-[rgba(2,4,9,.58)] p-6 backdrop-blur-[4px]',
          MODAL_TRANSITION,
          duration,
          entered ? SCRIM_OPEN : SCRIM_CLOSED,
          state === 'exiting' ? EXITING : '',
        ].join(' ')}
      >
        <div
          ref={surfaceRef}
          role="dialog"
          aria-modal="true"
          aria-label={`Session stats — ${title}`}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          style={{
            boxShadow: '0 40px 120px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.07)',
          }}
          // 10f: 584 wide, radius 16, 1px rgba(150,205,255,.2) over the glass.
          className={[
            'flex max-h-full w-[584px] max-w-full flex-col overflow-hidden rounded-2xl border',
            'border-[rgba(150,205,255,.2)] bg-[linear-gradient(180deg,rgba(16,22,38,.94),rgba(8,12,22,.96))]',
            'font-sans text-text-bright outline-none backdrop-blur-[28px]',
            MODAL_TRANSITION,
            duration,
            entered ? MODAL_OPEN : MODAL_CLOSED,
          ].join(' ')}
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-[rgba(150,205,255,.1)] px-6 pb-4 pt-5">
            <span
              aria-hidden
              className="block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{
                background: 'oklch(80% .13 210)',
                boxShadow: '0 0 10px oklch(80% .13 210 / .7)',
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] tracking-[0.2em] text-[oklch(85%_.12_205_/_.8)]">
                SESSION STATS
              </div>
              <div className="mt-1 truncate text-[17px] font-bold tracking-[-0.01em]">{title}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close session stats"
              className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[7px] border border-[rgba(150,205,255,.14)] text-[13px] text-[rgba(200,220,245,.7)] transition-colors hover:bg-white/5 hover:text-text-bright"
            >
              ✕
            </button>
          </header>

          <div className="flex min-h-0 flex-col gap-[18px] overflow-y-auto px-6 pb-5 pt-[18px]">
            <div className="flex gap-2.5">
              <Tile label="BUSY">{formatStatsDuration(busyMs)}</Tile>
              <Tile label="TOKENS" unit={tokens.unit}>
                {tokens.value}
              </Tile>
              <Tile label="COST" unit="$" unitLeading>
                {formatCostAmount(cost.total)}
              </Tile>
            </div>

            <TimeSplit busyMs={busyMs} elapsedMs={elapsedMs} idleMs={idleMs} rollup={rollup} />

            <SlowestTurns detail={detail} live={live} />

            {detail.findings.map((finding) => (
              // One finding per rule per session, so the rule is a stable key.
              <FindingRow key={finding.rule} finding={finding} detail={detail} />
            ))}

            <div className="flex items-center gap-3">
              <div className="flex-1 font-mono text-[10px] leading-[1.5] text-[rgba(160,190,225,.55)]">
                <span style={{ color: CAVEAT_INK }}>†</span> tool time includes permission-prompt
                waits
              </div>
              {/* A real link (10e "full stats → navigates to /stats/session/<id>"),
                  so the browser owns the navigation and ⌘-click opens a tab. */}
              <a
                href={sessionStatsPath(session.id)}
                className="shrink-0 rounded-[9px] bg-[oklch(85%_.12_205)] px-3.5 py-2 font-mono text-[11px] font-bold text-[#03111a] no-underline"
              >
                full stats →
              </a>
            </div>
          </div>
        </div>
      </div>
    </EscapeBoundary>,
    document.body
  )
}

/** 10f's three tiles: radius 12, padding 12/14, hero mono 24 with the unit at 15. */
function Tile({
  label,
  unit,
  unitLeading = false,
  children,
}: {
  label: string
  unit?: string
  unitLeading?: boolean
  children: ReactNode
}) {
  const unitSpan = unit ? (
    <span className="text-[15px] text-[rgba(200,225,255,.75)]">{unit}</span>
  ) : null
  return (
    <section
      aria-label={label}
      className="min-w-0 flex-1 rounded-xl border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-3.5 py-3"
    >
      <div className="font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">
        {label}
      </div>
      <div className="mt-[7px] truncate font-mono text-[24px] leading-none tracking-[-0.02em]">
        {unitLeading && unitSpan}
        {children}
        {!unitLeading && unitSpan}
      </div>
    </section>
  )
}

/**
 * TIME SPLIT (10f): the four categories as one bar and one row each. The bar
 * is a share of busy time, not of the clock — what the wall clock says is the
 * line above it, which is where `elapsed` and `idle` belong.
 */
function TimeSplit({
  busyMs,
  elapsedMs,
  idleMs,
  rollup,
}: {
  busyMs: number
  elapsedMs: number | null
  idleMs: number | null
  rollup: SessionStatsDetail['rollup']
}) {
  const share = (ms: number) => (busyMs > 0 ? ms / busyMs : 0)

  return (
    <section aria-label="Time split">
      <div className="flex items-baseline">
        <div className="font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">
          TIME SPLIT
        </div>
        <span className="flex-1" />
        <div className="font-mono text-[10px] text-[rgba(160,190,225,.45)]">
          {elapsedMs === null
            ? 'no measured span'
            : `${formatStatsDuration(elapsedMs)} elapsed${
                idleMs !== null && idleMs > 0 ? ` · ${formatStatsDuration(idleMs)} idle` : ''
              }`}
        </div>
      </div>

      <div
        className="mt-2.5 flex h-3 overflow-hidden rounded-[3px]"
        style={{ background: TRACK_COLOR }}
      >
        {TIME_CATEGORIES.map((category) => (
          <div
            key={category.field}
            style={{ width: `${share(rollup[category.field]) * 100}%`, background: category.color }}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-2 font-mono text-[11.5px]">
        {TIME_CATEGORIES.map((category) => (
          <div key={category.field} className="flex items-center gap-2.5">
            <span
              aria-hidden
              className="block h-[9px] w-[9px] shrink-0 rounded-[2px]"
              style={{ background: category.color }}
            />
            <span className="text-[rgba(200,225,255,.85)]">
              {category.label}
              {category.field === CAVEAT_FIELD && (
                <>
                  {' '}
                  <span style={{ color: CAVEAT_INK }}>†</span>
                </>
              )}
            </span>
            <span className="flex-1" />
            <span className="text-[rgba(160,190,225,.6)]">
              {formatPercent(share(rollup[category.field]))}
            </span>
            <span className="w-[70px] text-right">
              {formatStatsDuration(rollup[category.field])}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * SLOWEST TURNS (10f): the three turns that cost the most, on one shared
 * scale. A live session's current turn blinks while it runs (10e), the same
 * pulse every live thing in the app carries — and only when it is one of the
 * three, which is the only place this dialog draws a turn at all.
 *
 * The current turn is the last one the transcript has recorded. During the API
 * wait that opens a turn the transcript has not recorded it yet, so for those
 * seconds the pulse is on the turn before it. It is a sign of life, not a
 * measurement; the waterfall on `/stats/session/<id>` is where a turn is read.
 */
function SlowestTurns({ detail, live }: { detail: SessionStatsDetail; live: boolean }) {
  const turns = slowestTurns(detail.turns)
  if (turns.length === 0) return null

  const currentIndex = live ? detail.turns.length - 1 : -1

  return (
    <section aria-label="Slowest turns" className="border-t border-[rgba(150,205,255,.1)] pt-4">
      <div className="font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">
        SLOWEST TURNS
      </div>
      <div className="mt-2.5 flex flex-col gap-[7px] font-mono text-[11px]">
        {turns.map((turn) => {
          // The phases share the track LESS the hairline gaps between them, so a
          // busy turn's segments plus its gaps still land inside the track and
          // its last phase is not clipped by `overflow-hidden`. Drawing them
          // against the full fill overran a turn of eight or more phases (the
          // slowest turn's shares sum to the fill, and each gap is added on top).
          const gapBudget = Math.max(0, turn.phases.length - 1) * SLOWEST_SEGMENT_GAP_PCT
          const fill = SLOWEST_TRACK_FILL_PCT - gapBudget
          let left = 0
          return (
            <div
              key={turn.index}
              data-testid="slowest-turn"
              data-turn={turnLabel(turn.index)}
              className="flex items-center gap-2.5"
            >
              <span className="w-[30px] shrink-0 text-[rgba(160,190,225,.6)]">
                {turnLabel(turn.index)}
              </span>
              {/* The track is its own hue here, a step darker than the bars'
                  elsewhere in the dialog (10f). */}
              <span className="relative block h-2.5 flex-1 overflow-hidden rounded-[3px] bg-[rgba(150,205,255,.05)]">
                {turn.phases.map((phase) => {
                  const width = phase.share * fill
                  const style = { left: `${left}%`, width: `${width}%` }
                  left += width + SLOWEST_SEGMENT_GAP_PCT
                  return (
                    <span
                      key={phase.key}
                      // A phase that measured something is never thinner than
                      // the waterfall's floor, or a 40ms tool call would be
                      // invisible on a track this short.
                      style={{ ...style, minWidth: MIN_SEGMENT_PX, background: phase.color }}
                      className={`absolute top-0 block h-2.5 rounded-[3px] ${
                        turn.index === currentIndex ? 'orbital-pulse' : ''
                      }`}
                    />
                  )
                })}
              </span>
              <span className="w-[58px] shrink-0 text-right">
                {formatStatsDuration(turn.busyMs)}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * A finding as 10f draws it: one line, the severity's own chrome, and the turn
 * it blames as a link into the drilldown. The feed's card (10d) says more than
 * a dialog this size has room for — this is the same finding, at the size the
 * artboard gives it.
 *
 * The card is not itself a link: the only navigation it offers is the turn,
 * and an anchor inside an anchor is not a thing the DOM has.
 */
function FindingRow({
  finding,
  detail,
}: {
  finding: SessionStatsDetail['findings'][number]
  detail: SessionStatsDetail
}) {
  const style = SEVERITY_STYLES[finding.severity]
  const { headline } = findingCopy(withSession(finding, detail.session))
  const uuid = findingTurnUuid(finding.evidence)
  // A rule that names no turn, or one this transcript no longer holds, offers
  // no link rather than a guess (same rule as the drilldown's cards).
  const turnIndex = uuid === null ? -1 : detail.turns.findIndex((turn) => turn.uuid === uuid)

  return (
    <div
      className="flex items-center gap-2.5 rounded-[11px] border px-[13px] py-[11px]"
      style={{
        background: style.cardFill,
        borderColor: style.cardBorder,
        boxShadow: `inset 2px 0 0 ${style.stripe}`,
        opacity: style.opacity,
      }}
    >
      <span
        className="shrink-0 rounded-[5px] border px-[7px] py-0.5 font-mono text-[9px] tracking-[0.14em]"
        style={{ color: style.ink, background: style.chipFill, borderColor: style.chipBorder }}
      >
        {finding.severity.toUpperCase()}
      </span>
      <div className="flex-1 text-[12.5px] font-semibold leading-[1.35] text-pretty">{headline}</div>
      {turnIndex >= 0 && (
        <a
          href={sessionStatsPath(detail.session.id, uuid)}
          className="shrink-0 font-mono text-[10.5px] text-[#8fd8ff] no-underline"
        >
          turn {turnIndex + 1} ›
        </a>
      )}
    </div>
  )
}
