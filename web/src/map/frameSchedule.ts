/**
 * The map's frame budget (spec 2026-09-24-map-frame-budget-design): the
 * canvas draws only while something moves, and then at most N frames a
 * second, N set by the window's focus and the two `map_fps_*` settings.
 *
 * Pure — no React, three or DOM imports. The scheduler takes its clock and
 * its `requestAnimationFrame` as arguments, so the cap is unit-tested against
 * a fake display (`test/frameschedule.test.ts`); `FrameBudget.tsx` wires it to
 * r3f.
 */

/** `map_fps_focused`: the cap while the window has focus. */
export const MAP_FPS_FOCUSED_DEFAULT = 60
export const MAP_FPS_FOCUSED_MIN = 15
export const MAP_FPS_FOCUSED_MAX = 120
export const MAP_FPS_FOCUSED_STEP = 15

/** `map_fps_background`: the cap while it does not; the minimum pauses the map. */
export const MAP_FPS_BACKGROUND_DEFAULT = 30
export const MAP_FPS_BACKGROUND_MIN = 0
export const MAP_FPS_BACKGROUND_MAX = 60
export const MAP_FPS_BACKGROUND_STEP = 5

export interface MapFps {
  focused: number
  background: number
}

/**
 * Longest step any frame advances time by. A frame this far apart only comes
 * from a lower cap than any the settings offer, a hitch, or a pause the
 * scheduler did not see coming — in every case, catching up the whole gap
 * would make things jump.
 */
export const MAX_FRAME_DELTA_SEC = 0.25

/**
 * How early a display refresh may land and still count as due. Refreshes
 * jitter by a fraction of a millisecond; without the slack a cap equal to
 * the refresh rate would miss every other one.
 */
export const FRAME_TOLERANCE_MS = 2

/** A stored cap, parsed, clamped to its range and snapped to its step; missing or unparsable is `fallback`. */
function parseFps(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  step: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  const snapped = min + Math.round((n - min) / step) * step
  return Math.min(max, Math.max(min, snapped))
}

/** Both caps as the map applies them. */
export function parseMapFps(settings: Record<string, string>): MapFps {
  return {
    focused: parseFps(
      settings.map_fps_focused,
      MAP_FPS_FOCUSED_DEFAULT,
      MAP_FPS_FOCUSED_MIN,
      MAP_FPS_FOCUSED_MAX,
      MAP_FPS_FOCUSED_STEP,
    ),
    background: parseFps(
      settings.map_fps_background,
      MAP_FPS_BACKGROUND_DEFAULT,
      MAP_FPS_BACKGROUND_MIN,
      MAP_FPS_BACKGROUND_MAX,
      MAP_FPS_BACKGROUND_STEP,
    ),
  }
}

/** The cap in force right now, in frames a second; 0 draws nothing. A hidden window draws nothing whatever the settings say. */
export function frameCap(fps: MapFps, window: { focused: boolean; hidden: boolean }): number {
  if (window.hidden) return 0
  return window.focused ? fps.focused : fps.background
}

/** Whether a refresh at `now` may draw, given the next frame is due at `due` (both ms). */
export function isDue(now: number, due: number): boolean {
  return now >= due - FRAME_TOLERANCE_MS
}

/**
 * When the frame after one drawn at `now` is due. Stays on the grid while
 * frames keep up with it, so a cap that does not divide the refresh rate
 * still averages out to the cap. Starts a new grid after a gap, or after a
 * frame drawn early (one r3f drew on its own, for a prop change) — the cap
 * counts from the latest frame either way.
 */
export function nextDue(due: number, now: number, intervalMs: number): number {
  if (now - due > intervalMs || now < due - FRAME_TOLERANCE_MS) return now + intervalMs
  return due + intervalMs
}

/**
 * How far a frame advances time. A frame that continues motion gets the real
 * gap, up to MAX_FRAME_DELTA_SEC. A frame after the map stood still (or was
 * paused) gets at most one frame at the default focused cap: the real gap
 * there is however long nothing moved, and handing it to a tween that has
 * just started would finish that tween in one step.
 */
export function frameDelta(rawSec: number, continued: boolean): number {
  const delta = Math.max(0, rawSec)
  return Math.min(delta, continued ? MAX_FRAME_DELTA_SEC : 1 / MAP_FPS_FOCUSED_DEFAULT)
}

export interface FrameSchedulerDeps {
  now: () => number
  requestFrame: (tick: (now: number) => void) => number
  cancelFrame: (handle: number) => void
}

/**
 * Decides when the map draws. Every frame is bracketed by `beginFrame` /
 * `endFrame`; in between, anything still moving calls `markMoving`. A frame
 * that ended with something moving asks for the next one, and a display
 * refresh draws it (`draw`) only once the cap allows. Input, prop changes and
 * a window coming back call `request` for a single frame, under the same cap.
 */
export class FrameScheduler {
  /** Draws one frame synchronously; bound by the canvas. Nothing draws until it is. */
  draw: ((now: number) => void) | null = null
  private cap = MAP_FPS_FOCUSED_DEFAULT
  private due = -Infinity
  private handle = 0
  private moving = false
  private lastMoving = false
  private delta = 0
  /** The refresh timestamp of the frame this scheduler is drawing, so the grid runs on refresh time. */
  private drawingAt: number | null = null

  private readonly deps: FrameSchedulerDeps

  constructor(deps: FrameSchedulerDeps) {
    this.deps = deps
  }

  /** The cap in force; a raised cap or an unpaused map picks up where motion left off. */
  setCap(cap: number): void {
    if (cap === this.cap) return
    this.cap = cap
    if (cap <= 0) this.stop()
    else this.request()
  }

  get currentCap(): number {
    return this.cap
  }

  /** Asks for one frame, as soon as the cap allows. */
  request(): void {
    if (this.handle !== 0 || this.cap <= 0 || !this.draw) return
    this.handle = this.deps.requestFrame(this.tick)
  }

  /** Paused: the next frame, whenever it comes, starts from rest rather than catching up. */
  private stop(): void {
    if (this.handle !== 0) this.deps.cancelFrame(this.handle)
    this.handle = 0
    this.lastMoving = false
  }

  private tick = (now: number): void => {
    this.handle = 0
    if (this.cap <= 0 || !this.draw) return
    if (!isDue(now, this.due)) {
      this.handle = this.deps.requestFrame(this.tick)
      return
    }
    this.drawingAt = now
    try {
      this.draw(now)
    } finally {
      this.drawingAt = null
    }
  }

  /** Opens a frame: moves the grid on and works out the frame's time step from r3f's raw one. */
  beginFrame(rawDeltaSec: number): void {
    const now = this.drawingAt ?? this.deps.now()
    this.delta = frameDelta(rawDeltaSec, this.lastMoving)
    this.due = this.cap > 0 ? nextDue(this.due, now, 1000 / this.cap) : now
    this.moving = false
  }

  /** The current frame's time step, seconds — what every frame callback advances by. */
  get frameDelta(): number {
    return this.delta
  }

  markMoving(): void {
    this.moving = true
  }

  /** Closes a frame: anything still moving asks for the next one. */
  endFrame(): void {
    this.lastMoving = this.moving
    if (this.moving) this.request()
  }

  dispose(): void {
    this.stop()
    this.draw = null
  }
}
