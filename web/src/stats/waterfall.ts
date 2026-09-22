import type { StatsTurnSegment } from '../lib/types'
import { TIME_CATEGORIES } from './constants'
import { formatToolName } from './format'

/**
 * The geometry of one turn lane, from canvas 10e's "waterfall lane" row and
 * 10b's own lanes. Kept out of the component because it is the only part of
 * the waterfall that can be wrong in a way looking at it would not reveal:
 * a scale, a clamp and an ordering.
 *
 * The track is a fixed width for a fixed span — it is a ruler, not a bar, so
 * two lanes on different pages still mean the same thing. That is also why it
 * does not stretch with the window the way the dashboard's panels do.
 */

/** 10e: lane height 14 · radius 3 · row gap 10 · label col 74 · duration col 78 · track 640 = 5m · min segment 3px. */
export const LANE_HEIGHT = 14
export const LANE_RADIUS = 3
export const LANE_ROW_GAP = 10
export const LANE_LABEL_WIDTH = 74
export const LANE_DURATION_WIDTH = 78
export const TRACK_WIDTH = 640
export const TRACK_SPAN_MS = 5 * 60_000
export const MIN_SEGMENT_PX = 3

/** The gap 10b leaves between two segments of one lane, so they read as two. */
export const SEGMENT_GAP_PX = 2

/** 10b's page: "showing turns 1–9 of 44". */
export const TURNS_PER_PAGE = 9

/** Milliseconds per pixel of track — the scale every lane is drawn at. */
const PX_PER_MS = TRACK_WIDTH / TRACK_SPAN_MS

export type TurnOrder = 'longest' | 'chronological'

export interface LaneSegment {
  /** Stable across a re-render and unique within its lane. */
  key: string
  /** What the hover label names it: "API wait", or the tool as the rest of stats prints it. */
  label: string
  color: string
  ms: number
  isError: boolean
  /** Offset from the left edge of the track, in px. */
  left: number
  width: number
}

export interface Lane {
  turn: StatsTurnSegment
  /** Chronological position, 0-based — the number the lane is labelled with, whatever the sort. */
  index: number
  /** API wait plus every tool call. Can exceed the turn's elapsed time: tool calls run in parallel. */
  busyMs: number
  segments: LaneSegment[]
}

const API_CATEGORY = TIME_CATEGORIES[0]

function colorOf(kind: StatsTurnSegment['tools'][number]['kind']): string {
  const field = kind === 'mcp' ? 'mcpMs' : kind === 'subagent' ? 'subagentMs' : 'localToolMs'
  return TIME_CATEGORIES.find((c) => c.field === field)?.color ?? API_CATEGORY.color
}

/** One measured phase of a turn, before any geometry is put on it. */
interface Phase {
  key: string
  label: string
  color: string
  ms: number
  isError: boolean
}

/**
 * The turn's phases in the order they ran: the API wait it opened with, then
 * its tool calls as they were dispatched. Shared by the drilldown's lanes and
 * the quick dialog's rows, which draw them at different scales but must never
 * disagree about what happened.
 */
function phasesOf(turn: StatsTurnSegment): Phase[] {
  return [
    { key: 'api', label: API_CATEGORY.label, color: API_CATEGORY.color, ms: turn.apiMs, isError: false },
    ...turn.tools.map((tool, i) => ({
      // `useId` is unique per transcript, but a malformed entry can repeat
      // it; the position keeps the key unique regardless.
      key: `${i}-${tool.useId}`,
      label: formatToolName(tool.name),
      color: colorOf(tool.kind),
      ms: tool.ms,
      isError: tool.isError,
    })),
  ]
}

function busyOf(phases: readonly Phase[]): number {
  return phases.reduce((total, phase) => total + Math.max(0, phase.ms), 0)
}

/**
 * One turn as it is drawn: the API wait it opened with, then its tool calls in
 * the order they were dispatched.
 *
 * The transcript gives one API-wait span per turn and no wall-clock offset per
 * tool, so the lane is laid out end to end rather than at true offsets — the
 * widths are measured, the order is real, the gaps between them are not.
 *
 * Two clamps, both from 10e: a phase that measured something never draws
 * thinner than `MIN_SEGMENT_PX` (a 40 ms tool call would otherwise be
 * invisible), and nothing is drawn past the end of the track. A lane longer
 * than the track's span therefore fills it; the duration column is what says
 * by how much it overran.
 */
export function laneOf(turn: StatsTurnSegment, index: number): Lane {
  const phases = phasesOf(turn)

  const segments: LaneSegment[] = []
  let left = 0

  for (const phase of phases) {
    if (phase.ms <= 0) continue
    if (left >= TRACK_WIDTH) continue

    const width = Math.min(
      Math.max(MIN_SEGMENT_PX, Math.round(phase.ms * PX_PER_MS)),
      TRACK_WIDTH - left
    )
    segments.push({ ...phase, left, width })
    left += width + SEGMENT_GAP_PX
  }

  return { turn, index, busyMs: busyOf(phases), segments }
}

/** Every turn of the session as a lane, in the order the session ran them. */
export function lanesOf(turns: readonly StatsTurnSegment[]): Lane[] {
  return turns.map(laneOf)
}

/**
 * 10b's toggle. "Longest first" ranks by the time the turn actually cost, ties
 * keeping their chronological order so the list is stable between renders.
 * Neither order renumbers a lane — `index` is where the turn sits in the
 * session, which is what a finding points at and what the label prints.
 */
export function orderLanes(lanes: readonly Lane[], order: TurnOrder): Lane[] {
  if (order === 'chronological') return [...lanes]
  return [...lanes].sort((a, b) => b.busyMs - a.busyMs || a.index - b.index)
}

export interface PageBounds {
  /** The requested page, pulled back inside the list. */
  page: number
  start: number
  /** Exclusive, and never past the count. */
  end: number
  pageCount: number
}

/**
 * The slice one page shows. An empty session still has one (empty) page, so
 * the footer has a page to name rather than reading "page 1 of 0".
 */
export function pageBounds(count: number, page: number, size: number = TURNS_PER_PAGE): PageBounds {
  const pageCount = Math.max(1, Math.ceil(count / size))
  const clamped = Math.min(Math.max(0, page), pageCount - 1)
  const start = clamped * size
  return { page: clamped, start, end: Math.min(count, start + size), pageCount }
}

/** `T01`, `T44` — the lane's chronological place, padded to the canvas's two digits. */
export function turnLabel(index: number): string {
  return `T${String(index + 1).padStart(2, '0')}`
}

/** How many turns the quick dialog's SLOWEST TURNS block lists (10f). */
export const SLOWEST_TURN_COUNT = 3

export interface SlowestPhase {
  key: string
  label: string
  color: string
  ms: number
  /** Of the slowest listed turn's busy time — 1 for the phase that fills it. */
  share: number
}

export interface SlowestTurn {
  /** Chronological position, 0-based: what `turnLabel` prints and what a finding names. */
  index: number
  busyMs: number
  phases: SlowestPhase[]
}

/**
 * 10f's SLOWEST TURNS: the turns that cost the most, longest first, with every
 * phase measured against the slowest one of them — the rows share a single
 * ruler, so a row drawn half as long did take half as long. Its own scale
 * rather than the waterfall's fixed 5-minute track (`laneOf`): three rows in a
 * 584px dialog are a comparison between themselves, not a measurement against
 * the session's other forty.
 *
 * Turns that measured nothing are left out — a row of zero length is a row
 * that says nothing — and ties keep the order the session ran them in, so the
 * list is stable between refetches of a live session.
 */
export function slowestTurns(
  turns: readonly StatsTurnSegment[],
  limit: number = SLOWEST_TURN_COUNT
): SlowestTurn[] {
  const ranked = turns
    .map((turn, index) => {
      const phases = phasesOf(turn)
      return { index, phases, busyMs: busyOf(phases) }
    })
    .filter((turn) => turn.busyMs > 0)
    .sort((a, b) => b.busyMs - a.busyMs || a.index - b.index)
    .slice(0, limit)

  const longest = ranked[0]?.busyMs ?? 0

  return ranked.map(({ index, busyMs, phases }) => ({
    index,
    busyMs,
    phases: phases
      .filter((phase) => phase.ms > 0)
      .map(({ key, label, color, ms }) => ({ key, label, color, ms, share: ms / longest })),
  }))
}
