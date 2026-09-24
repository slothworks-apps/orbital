import { describe, it, expect } from 'vitest'
import {
  FrameScheduler,
  MAP_FPS_BACKGROUND_DEFAULT,
  MAP_FPS_FOCUSED_DEFAULT,
  MAP_FPS_FOCUSED_MAX,
  MAX_FRAME_DELTA_SEC,
  frameCap,
  frameDelta,
  nextDue,
  parseMapFps,
} from '../map/frameSchedule'

describe('parseMapFps', () => {
  it('falls back to the defaults for missing, empty or unparsable values', () => {
    expect(parseMapFps({})).toEqual({
      focused: MAP_FPS_FOCUSED_DEFAULT,
      background: MAP_FPS_BACKGROUND_DEFAULT,
    })
    expect(parseMapFps({ map_fps_focused: '', map_fps_background: 'fast' })).toEqual({
      focused: MAP_FPS_FOCUSED_DEFAULT,
      background: MAP_FPS_BACKGROUND_DEFAULT,
    })
  })

  it('clamps to the range and snaps to the step', () => {
    expect(parseMapFps({ map_fps_focused: '1000', map_fps_background: '-5' })).toEqual({
      focused: MAP_FPS_FOCUSED_MAX,
      background: 0,
    })
    expect(parseMapFps({ map_fps_focused: '50', map_fps_background: '12' })).toEqual({
      focused: 45,
      background: 10,
    })
  })

  it('keeps an explicit 0 in the background: that is the pause, not a missing value', () => {
    expect(parseMapFps({ map_fps_background: '0' }).background).toBe(0)
  })
})

describe('frameCap', () => {
  const fps = { focused: 90, background: 20 }
  it('picks the cap by focus, and draws nothing while hidden', () => {
    expect(frameCap(fps, { focused: true, hidden: false })).toBe(90)
    expect(frameCap(fps, { focused: false, hidden: false })).toBe(20)
    expect(frameCap(fps, { focused: true, hidden: true })).toBe(0)
  })
})

describe('frameDelta', () => {
  it('passes a continuing frame its real step, up to the ceiling', () => {
    expect(frameDelta(1 / 30, true)).toBeCloseTo(1 / 30)
    expect(frameDelta(12, true)).toBe(MAX_FRAME_DELTA_SEC)
  })

  it('gives the first frame after a standstill one frame, not the whole gap', () => {
    expect(frameDelta(12, false)).toBeCloseTo(1 / MAP_FPS_FOCUSED_DEFAULT)
    expect(frameDelta(-1, false)).toBe(0)
  })
})

describe('nextDue', () => {
  it('stays on the grid while frames keep up, and restarts it after a gap or an early frame', () => {
    expect(nextDue(100, 101, 20)).toBe(120)
    expect(nextDue(100, 500, 20)).toBe(520)
    expect(nextDue(100, 50, 20)).toBe(70)
  })
})

/**
 * A fake display: refreshes every `refreshMs` (with optional jitter), runs
 * whatever requested a frame, and counts the frames the scheduler draws.
 * `moving(frameIndex)` says whether the scene still moves after that frame.
 */
function runDisplay(opts: {
  refreshHz: number
  cap: number
  seconds: number
  jitterMs?: number
  moving?: (frame: number) => boolean
  atRefresh?: (refresh: number, scheduler: FrameScheduler) => void
}) {
  const refreshMs = 1000 / opts.refreshHz
  let now = 0
  let pending: Array<{ id: number; cb: (t: number) => void }> = []
  let nextId = 1
  const scheduler = new FrameScheduler({
    now: () => now,
    requestFrame: (cb) => {
      const id = nextId++
      pending.push({ id, cb })
      return id
    },
    cancelFrame: (id) => {
      pending = pending.filter((p) => p.id !== id)
    },
  })
  const drawn: number[] = []
  const deltas: number[] = []
  let lastDraw = 0
  scheduler.draw = (t) => {
    scheduler.beginFrame((t - lastDraw) / 1000)
    lastDraw = t
    drawn.push(t)
    deltas.push(scheduler.frameDelta)
    if (opts.moving?.(drawn.length - 1) ?? true) scheduler.markMoving()
    scheduler.endFrame()
  }
  scheduler.setCap(opts.cap)
  scheduler.request()
  const refreshes = Math.round(opts.seconds * opts.refreshHz)
  for (let i = 1; i <= refreshes; i++) {
    // Alternating jitter, so no refresh drifts further than one jitter off the grid.
    now = i * refreshMs + (opts.jitterMs ? (i % 2 ? -opts.jitterMs : opts.jitterMs) : 0)
    opts.atRefresh?.(i, scheduler)
    const run = pending
    pending = []
    for (const p of run) p.cb(now)
  }
  return { drawn, deltas, scheduler }
}

describe('FrameScheduler', () => {
  it('draws at the cap on a faster display', () => {
    expect(runDisplay({ refreshHz: 120, cap: 60, seconds: 2 }).drawn.length).toBeCloseTo(120, -1)
    expect(runDisplay({ refreshHz: 120, cap: 30, seconds: 2 }).drawn.length).toBeCloseTo(60, -1)
  })

  it('draws every refresh when the cap equals the refresh rate, even with jitter', () => {
    const { drawn } = runDisplay({ refreshHz: 60, cap: 60, seconds: 2, jitterMs: 0.8 })
    expect(drawn.length).toBeGreaterThanOrEqual(119)
  })

  it('averages out to a cap that does not divide the refresh rate', () => {
    const { drawn } = runDisplay({ refreshHz: 120, cap: 90, seconds: 2 })
    expect(drawn.length).toBeGreaterThan(170)
    expect(drawn.length).toBeLessThanOrEqual(181)
  })

  it('never draws faster than the display', () => {
    expect(runDisplay({ refreshHz: 60, cap: 120, seconds: 1 }).drawn.length).toBe(60)
  })

  it('stops drawing once nothing moves', () => {
    const { drawn } = runDisplay({
      refreshHz: 60,
      cap: 60,
      seconds: 1,
      moving: (frame) => frame < 4,
    })
    expect(drawn.length).toBe(5)
  })

  it('draws nothing at a cap of 0, and resumes when the cap comes back', () => {
    const paused = runDisplay({ refreshHz: 60, cap: 0, seconds: 1 })
    expect(paused.drawn.length).toBe(0)
    // Paused for the middle second of three: a second's worth of frames is missing.
    const resumed = runDisplay({
      refreshHz: 60,
      cap: 60,
      seconds: 3,
      atRefresh: (i, scheduler) => {
        if (i === 61) scheduler.setCap(0)
        if (i === 121) scheduler.setCap(60)
      },
    })
    expect(resumed.drawn.length).toBeGreaterThanOrEqual(119)
    expect(resumed.drawn.length).toBeLessThanOrEqual(121)
    expect(resumed.drawn.some((t) => t > 1010 && t < 1990)).toBe(false)
    // The first frame back starts from rest instead of catching up the pause.
    const firstBack = resumed.drawn.findIndex((t) => t >= 1990)
    expect(resumed.deltas[firstBack]).toBeCloseTo(1 / MAP_FPS_FOCUSED_DEFAULT)
  })

  it('hands continuing frames their real step, so motion keeps wall-clock time at any cap', () => {
    const { deltas } = runDisplay({ refreshHz: 120, cap: 30, seconds: 1 })
    const total = deltas.slice(1).reduce((a, b) => a + b, 0)
    // Every frame after the first advances by its real gap: the sum is the
    // wall-clock time between the first and the last frame.
    expect(total).toBeGreaterThan(0.9)
    expect(Math.max(...deltas.slice(1))).toBeCloseTo(1 / 30, 2)
  })
})
