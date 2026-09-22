import { useEffect, useMemo, useRef, useState } from 'react'
import type { StatsTurnSegment } from '../lib/types'
import { PANEL_CLASS, PANEL_LABEL_CLASS, TIME_CATEGORIES } from './constants'
import { formatStatsDuration } from './format'
import {
  LANE_DURATION_WIDTH,
  LANE_HEIGHT,
  LANE_LABEL_WIDTH,
  LANE_RADIUS,
  LANE_ROW_GAP,
  TRACK_WIDTH,
  TURNS_PER_PAGE,
  lanesOf,
  orderLanes,
  pageBounds,
  turnLabel,
  type Lane,
  type LaneSegment,
  type TurnOrder,
} from './waterfall'

/**
 * TURN WATERFALL (canvas 10b): one lane per turn, the API wait it opened with
 * and then the tools it ran, on a fixed 5-minute ruler.
 *
 * The geometry is in `waterfall.ts`; this file is the canvas's chrome around
 * it — the ruler, the legend, the hover label, the page footer and the
 * permission caveat.
 */

/**
 * The lane track is drawn a notch quieter than the bar track the tiles and the
 * leaderboard share (10e's `TRACK_COLOR`): 10b stacks nine of these, and at
 * that density .07 reads as nine filled bars. Same value as the row hover, so
 * a hovered row and its track merge exactly as 10b draws them.
 */
const LANE_TRACK_COLOR = 'rgba(150,205,255,.05)'

/** A tool that failed is ringed rather than recoloured — the lane keeps saying which category it was (10b, T06). */
const ERROR_RING = '0 0 0 1px #ff8a7a'

const MINUTES = [0, 1, 2, 3, 4, 5]

/** Where a minute label sits on the ruler; the last is pulled inside so it does not hang past the track (10b: 626). */
function tickLeft(minute: number): number {
  const step = TRACK_WIDTH / (MINUTES.length - 1)
  return minute === MINUTES.length - 1 ? TRACK_WIDTH - 14 : minute * step
}

export interface WaterfallFocus {
  /** The turn's transcript uuid. */
  uuid: string
  /** Bumped per request, so asking for the same turn twice scrolls to it twice. */
  seq: number
}

export function TurnWaterfall({
  turns,
  focus,
}: {
  turns: StatsTurnSegment[]
  /** The turn to page to, highlight and scroll into view — from `?turn=` or a finding. */
  focus: WaterfallFocus | null
}) {
  // 10b draws "longest first" as the active sort: the drilldown is opened to
  // find out where the time went, and that is the answer in one screen.
  const [order, setOrder] = useState<TurnOrder>('longest')
  const [page, setPage] = useState(0)
  const [hovered, setHovered] = useState<{ lane: number; segment: string } | null>(null)
  const laneRefs = useRef(new Map<string, HTMLDivElement>())

  const ordered = useMemo(() => orderLanes(lanesOf(turns), order), [turns, order])
  const bounds = pageBounds(ordered.length, page)
  const visible = ordered.slice(bounds.start, bounds.end)

  // A focused turn is only on screen once its page is; the scroll therefore
  // waits for the render that page change causes.
  useEffect(() => {
    if (focus === null) return
    const position = ordered.findIndex((lane) => lane.turn.uuid === focus.uuid)
    if (position < 0) return
    setPage(Math.floor(position / TURNS_PER_PAGE))
  }, [focus, ordered])

  useEffect(() => {
    if (focus === null) return
    // Not implemented in jsdom, and absent in no browser this app runs in.
    laneRefs.current.get(focus.uuid)?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [focus, bounds.page])

  return (
    <section
      aria-label="Turn waterfall"
      className={`${PANEL_CLASS} flex min-w-0 flex-1 flex-col px-5 pb-3.5 pt-4`}
    >
      <div className="flex items-baseline gap-[14px]">
        <div className={PANEL_LABEL_CLASS}>TURN WATERFALL</div>
        <span className="flex-1" />
        <div className="flex gap-[14px] font-mono text-[10px] text-[rgba(160,190,225,.7)]">
          {TIME_CATEGORIES.map((category) => (
            <span key={category.field} className="flex items-center gap-[5px]">
              <span
                className="block h-[7px] w-[7px] rounded-[2px]"
                style={{ background: category.color }}
              />
              {category.label}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-[14px] min-w-0 overflow-x-auto">
        <Ruler />

        {ordered.length === 0 ? (
          <div className="pt-3 font-mono text-[11.5px] text-[rgba(160,190,225,.6)]">
            no turns measured in this transcript
          </div>
        ) : (
          <div
            className="mt-2.5 flex flex-col"
            style={{ gap: LANE_ROW_GAP }}
            onMouseLeave={() => setHovered(null)}
          >
            {visible.map((lane) => (
              <LaneRow
                key={lane.index}
                lane={lane}
                focused={focus !== null && focus.uuid === lane.turn.uuid}
                hovered={hovered}
                onHover={setHovered}
                register={(el) => {
                  if (el) laneRefs.current.set(lane.turn.uuid, el)
                  else laneRefs.current.delete(lane.turn.uuid)
                }}
              />
            ))}
          </div>
        )}
      </div>

      {ordered.length > 0 && (
        <div className="mt-[14px] flex items-center gap-[14px] border-t border-[rgba(150,205,255,.08)] pt-3 font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">
          showing turns {bounds.start + 1}–{bounds.end} of {ordered.length}
          {bounds.pageCount > 1 && (
            <span className="flex items-center gap-[14px]">
              <PagerButton
                label="‹ prev"
                disabled={bounds.page === 0}
                onClick={() => setPage(bounds.page - 1)}
              />
              <PagerButton
                label="next ›"
                disabled={bounds.page === bounds.pageCount - 1}
                onClick={() => setPage(bounds.page + 1)}
              />
            </span>
          )}
          <span className="flex-1" />
          <OrderButton label="longest first" active={order === 'longest'} onClick={() => setOrder('longest')} />
          <OrderButton
            label="chronological"
            active={order === 'chronological'}
            onClick={() => setOrder('chronological')}
          />
        </div>
      )}

      <span className="flex-1" />
      <PermissionCaveat />
    </section>
  )
}

/** The 0s–5m ruler every lane is drawn against, over the same three columns as a lane. */
function Ruler() {
  return (
    <>
      <div className="flex items-center gap-[14px] font-mono text-[9.5px] text-[rgba(160,190,225,.4)]">
        <span className="block" style={{ width: LANE_LABEL_WIDTH }} />
        <span className="relative block h-[11px]" style={{ width: TRACK_WIDTH }}>
          {MINUTES.map((minute) => (
            <span key={minute} className="absolute top-0" style={{ left: tickLeft(minute) }}>
              {minute === 0 ? '0s' : `${minute}m`}
            </span>
          ))}
        </span>
        <span className="block" style={{ width: LANE_DURATION_WIDTH }} />
      </div>
      <div className="mt-1 flex gap-[14px]">
        <span className="block" style={{ width: LANE_LABEL_WIDTH }} />
        <span
          className="block h-px bg-[rgba(150,205,255,.14)]"
          style={{ width: TRACK_WIDTH }}
        />
        <span className="block" style={{ width: LANE_DURATION_WIDTH }} />
      </div>
    </>
  )
}

function LaneRow({
  lane,
  focused,
  hovered,
  onHover,
  register,
}: {
  lane: Lane
  focused: boolean
  hovered: { lane: number; segment: string } | null
  onHover: (target: { lane: number; segment: string } | null) => void
  register: (el: HTMLDivElement | null) => void
}) {
  const active = focused || hovered?.lane === lane.index

  return (
    <div
      ref={register}
      // The row's own padding is cancelled by an equal negative margin, so a
      // lit row grows a background without moving the lane above it (10b).
      className="-my-[5px] flex items-center gap-[14px] rounded-md py-[5px]"
      style={{ background: active ? 'rgba(150,205,255,.05)' : undefined }}
    >
      <span
        className={`block font-mono text-[10.5px] ${
          active ? 'text-text-soft' : 'text-[rgba(160,190,225,.6)]'
        }`}
        style={{ width: LANE_LABEL_WIDTH }}
      >
        {turnLabel(lane.index)}
      </span>

      <span
        className="relative block"
        style={{
          width: TRACK_WIDTH,
          height: LANE_HEIGHT,
          borderRadius: LANE_RADIUS,
          background: LANE_TRACK_COLOR,
        }}
      >
        {lane.segments.map((segment) => (
          <Segment
            key={segment.key}
            segment={segment}
            labelled={hovered?.lane === lane.index && hovered.segment === segment.key}
            onHover={(on) => onHover(on ? { lane: lane.index, segment: segment.key } : null)}
          />
        ))}
      </span>

      <span
        className="block text-right font-mono text-[11px] text-text-bright"
        style={{ width: LANE_DURATION_WIDTH }}
      >
        {formatStatsDuration(lane.busyMs)}
      </span>
    </div>
  )
}

function Segment({
  segment,
  labelled,
  onHover,
}: {
  segment: LaneSegment
  labelled: boolean
  onHover: (on: boolean) => void
}) {
  return (
    <>
      <span
        // A graphic with a name, not a decorated div: `aria-label` on a bare
        // span is ignored, and the duration is the only thing a segment says.
        role="img"
        aria-label={`${segment.label} ${formatStatsDuration(segment.ms)}`}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        className="absolute top-0 block"
        style={{
          left: segment.left,
          width: segment.width,
          height: LANE_HEIGHT,
          borderRadius: LANE_RADIUS,
          background: segment.color,
          boxShadow: segment.isError ? ERROR_RING : undefined,
        }}
      />
      {labelled && (
        // Pinned to the segment's left edge (10e "hover waterfall lane"), which
        // is what ties the label to the segment when a lane holds several.
        <span
          role="tooltip"
          className="pointer-events-none absolute z-10 whitespace-nowrap rounded-md border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] px-[7px] py-[3px] font-mono text-[10px] text-text-bright"
          style={{ left: segment.left, top: -26 }}
        >
          {segment.label} · {formatStatsDuration(segment.ms)}
        </span>
      )}
    </>
  )
}

function OrderButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`cursor-pointer font-mono text-[10.5px] ${
        active ? 'text-[#8fd8ff]' : 'text-[rgba(160,190,225,.6)]'
      }`}
    >
      {label}
    </button>
  )
}

function PagerButton({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`font-mono text-[10.5px] ${
        disabled ? 'text-[rgba(160,190,225,.28)]' : 'cursor-pointer text-[#8fd8ff]'
      }`}
    >
      {label}
    </button>
  )
}

/**
 * 10b's permission footnote, always on screen.
 *
 * The canvas's copy ends with a sentence saying which lanes are marked †.
 * Nothing in the transcript records that a permission prompt was shown, so no
 * lane can carry the mark honestly and the sentence is dropped (controller
 * ruling). The rest of the caveat is true of every lane, which is why it is
 * stated once here rather than per lane.
 */
function PermissionCaveat() {
  return (
    <div className="flex gap-[9px] rounded-[10px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-[13px] py-[11px]">
      <span className="font-mono text-[11px] text-[#ffbb7b]">†</span>
      <div className="text-[11.5px] leading-[1.55] text-pretty text-[rgba(160,190,225,.75)]">
        Tool time in terminal sessions includes time spent waiting for you to answer a permission
        prompt — Orbital cannot separate the two from the transcript. Treat local-tool totals in{' '}
        <span className="font-mono">plan</span> and <span className="font-mono">acceptEdits</span>{' '}
        sessions as an upper bound.
      </div>
    </div>
  )
}
