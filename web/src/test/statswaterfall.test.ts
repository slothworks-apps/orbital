import { describe, it, expect } from 'vitest'
import type { StatsTurnSegment } from '../lib/types'
import {
  MIN_SEGMENT_PX,
  SEGMENT_GAP_PX,
  TRACK_SPAN_MS,
  TRACK_WIDTH,
  TURNS_PER_PAGE,
  laneOf,
  orderLanes,
  pageBounds,
  turnLabel,
} from '../stats/waterfall'
import { findingTurnUuid } from '../stats/findingCopy'

const MINUTE = 60_000

function turn(patch: Partial<StatsTurnSegment> = {}): StatsTurnSegment {
  return {
    requestId: 'req-1',
    uuid: 'uuid-1',
    startTs: 0,
    apiMs: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    tools: [],
    ...patch,
  }
}

function tool(patch: Partial<StatsTurnSegment['tools'][number]> = {}) {
  return {
    name: 'Read',
    kind: 'local' as const,
    ms: 0,
    isError: false,
    resultChars: 0,
    useId: 'use-1',
    ...patch,
  }
}

describe('laneOf — the 10e scale', () => {
  it('draws a full-span lane across the whole track', () => {
    const lane = laneOf(turn({ apiMs: TRACK_SPAN_MS }), 0)
    expect(lane.segments).toHaveLength(1)
    expect(lane.segments[0].left).toBe(0)
    expect(lane.segments[0].width).toBe(TRACK_WIDTH)
  })

  it('scales a minute to its share of the track', () => {
    const lane = laneOf(turn({ apiMs: MINUTE }), 0)
    expect(lane.segments[0].width).toBe(Math.round(TRACK_WIDTH / 5))
  })

  it('clamps a segment too short to see up to the minimum, without moving the rest', () => {
    const lane = laneOf(turn({ apiMs: MINUTE, tools: [tool({ ms: 40 }), tool({ ms: MINUTE })] }), 0)
    const [api, blink, long] = lane.segments
    expect(blink.width).toBe(MIN_SEGMENT_PX)
    expect(blink.left).toBe(api.width + SEGMENT_GAP_PX)
    expect(long.left).toBe(blink.left + MIN_SEGMENT_PX + SEGMENT_GAP_PX)
  })

  it('draws nothing for a phase that measured no time', () => {
    const lane = laneOf(turn({ apiMs: 0, tools: [tool({ ms: 0 }), tool({ ms: 5_000 })] }), 0)
    expect(lane.segments.map((s) => s.ms)).toEqual([5_000])
  })

  it('keeps a lane longer than the track inside it, and still totals honestly', () => {
    const lane = laneOf(turn({ apiMs: 4 * MINUTE, tools: [tool({ ms: 4 * MINUTE })] }), 0)
    const last = lane.segments[lane.segments.length - 1]
    expect(last.left + last.width).toBe(TRACK_WIDTH)
    expect(lane.busyMs).toBe(8 * MINUTE)
  })

  it('drops a segment that starts past the end of the track', () => {
    const tools = Array.from({ length: 40 }, (_, i) => tool({ ms: 20_000, useId: `use-${i}` }))
    const lane = laneOf(turn({ apiMs: MINUTE, tools }), 0)
    expect(lane.segments.length).toBeLessThan(tools.length + 1)
    for (const segment of lane.segments) expect(segment.left + segment.width).toBeLessThanOrEqual(TRACK_WIDTH)
  })

  it('totals API wait and every tool, and starts with API wait', () => {
    const lane = laneOf(turn({ apiMs: 30_000, tools: [tool({ ms: 4_000 }), tool({ ms: 1_000 })] }), 0)
    expect(lane.busyMs).toBe(35_000)
    expect(lane.segments[0].label).toBe('API wait')
    expect(lane.segments[0].left).toBe(0)
  })

  it('carries the error flag of the tool it draws', () => {
    const lane = laneOf(turn({ tools: [tool({ ms: 1_000, isError: true })] }), 0)
    expect(lane.segments[0].isError).toBe(true)
  })
})

describe('orderLanes', () => {
  const lanes = [
    laneOf(turn({ requestId: 'a', apiMs: 10_000 }), 0),
    laneOf(turn({ requestId: 'b', apiMs: 90_000 }), 1),
    laneOf(turn({ requestId: 'c', apiMs: 10_000 }), 2),
  ]

  it('leaves chronological order alone', () => {
    expect(orderLanes(lanes, 'chronological').map((l) => l.turn.requestId)).toEqual(['a', 'b', 'c'])
  })

  it('puts the longest lane first and breaks ties chronologically', () => {
    expect(orderLanes(lanes, 'longest').map((l) => l.turn.requestId)).toEqual(['b', 'a', 'c'])
  })

  it('never renumbers a turn — the label is its place in the session', () => {
    expect(orderLanes(lanes, 'longest').map((l) => l.index)).toEqual([1, 0, 2])
  })

  it('leaves the array it was handed untouched', () => {
    orderLanes(lanes, 'longest')
    expect(lanes.map((l) => l.turn.requestId)).toEqual(['a', 'b', 'c'])
  })
})

describe('pageBounds', () => {
  it('opens on the first page of a full session', () => {
    expect(pageBounds(44, 0)).toEqual({ page: 0, start: 0, end: TURNS_PER_PAGE, pageCount: 5 })
  })

  it('stops the last page at the count, not at the page size', () => {
    expect(pageBounds(44, 4)).toEqual({ page: 4, start: 36, end: 44, pageCount: 5 })
  })

  it('pulls a page past the end back to the last one', () => {
    expect(pageBounds(44, 9).page).toBe(4)
  })

  it('pulls a negative page back to the first', () => {
    expect(pageBounds(44, -2).start).toBe(0)
  })

  it('reports one empty page for a session with no turns', () => {
    expect(pageBounds(0, 0)).toEqual({ page: 0, start: 0, end: 0, pageCount: 1 })
  })

  it('does not open a second page for exactly one page of turns', () => {
    expect(pageBounds(TURNS_PER_PAGE, 0).pageCount).toBe(1)
    expect(pageBounds(TURNS_PER_PAGE + 1, 0).pageCount).toBe(2)
  })
})

describe('turnLabel', () => {
  it('pads to the canvas width and counts from one', () => {
    expect(turnLabel(0)).toBe('T01')
    expect(turnLabel(43)).toBe('T44')
    expect(turnLabel(99)).toBe('T100')
  })
})

describe('findingTurnUuid', () => {
  it('reads the turn a rule blames, whichever key it used', () => {
    expect(findingTurnUuid({ firstTurnUuid: 'u-1' })).toBe('u-1')
    expect(findingTurnUuid({ turnUuid: 'u-2' })).toBe('u-2')
  })

  it('has nothing to point at for a rule that names no turn', () => {
    expect(findingTurnUuid({ tool: 'Bash' })).toBeNull()
    expect(findingTurnUuid({ firstTurnUuid: '' })).toBeNull()
  })
})
