/**
 * How the transcript moves: the scroll that follows a new message, and which
 * rows count as having just arrived.
 *
 * Split out of `Transcript.tsx` because none of it is rendering — it is
 * arithmetic and one rAF loop, and it is where the interesting edge cases
 * live (a scroll target that moves while it is being animated to; telling an
 * appended row apart from one that merely scrolled into the window).
 */

/** Minimal shape `stuckAfterScroll` needs from a scroll container — lets tests
 * inject fixture values, since jsdom never computes real scroll metrics. */
export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Content hidden below the viewport past which a stuck transcript lets go
 * (canvas `Feature - Jump to bottom` 43e, Visibility). */
export const LET_GO_BELOW_PX = 64

/** Content hidden below the viewport under which a transcript that let go
 * sticks again (43e, Visibility). */
export const STICK_BELOW_PX = 24

/**
 * Whether the transcript follows new rows after the reader scrolled it to
 * `el`'s position. Two thresholds, not one: between them the answer is
 * whatever it already was, so a position hovering on a single line cannot
 * flip the jump-to-bottom indicator on and off with every pixel. The
 * indicator shows exactly when this is false, so it is never drawn over a
 * transcript that is at its bottom.
 */
export function stuckAfterScroll(stuck: boolean, el: ScrollMetrics): boolean {
  const below = el.scrollHeight - el.scrollTop - el.clientHeight
  return stuck ? below <= LET_GO_BELOW_PX : below < STICK_BELOW_PX
}

/**
 * Scroll offset that keeps the same content anchored under the viewport
 * after older content was prepended above it (which grows `scrollHeight`
 * out from under a `scrollTop` that hasn't moved, visually yanking
 * whatever the user was reading downward). Pure arithmetic, factored out
 * so it's testable without a real DOM: the container grew by
 * `newHeight - prevHeight` pixels, all of it above the old content, so
 * `scrollTop` needs to grow by exactly that much to keep the same pixel
 * under the viewport's top edge.
 */
export function compensatePrepend(prevHeight: number, newHeight: number, scrollTop: number): number {
  return scrollTop + (newHeight - prevHeight)
}

/**
 * Time for the scroller to cover half the distance still ahead of it. The
 * tail is asymptotic, so the number to feel for is the settle: a couple of
 * half-lives to be visually there.
 *
 * Deliberately a half-life rather than a total duration. The target moves —
 * content keeps growing underneath a scroll that is already running — and a
 * start/end/progress animation would have to restart (visibly re-easing)
 * every time it was retargeted. Exponential decay has no start to restart
 * from: it only ever reads where it is now and where it is headed, so a
 * retarget mid-flight is free and invisible.
 */
export const SCROLL_HALF_LIFE_MS = 90

/**
 * Distance, in viewport heights, past which the scroller stops animating and
 * simply jumps. Easing across several screens of transcript reads as the view
 * running away rather than as following along, and the intermediate content
 * flickering past is never anything the reader wanted to see.
 */
const INSTANT_ABOVE_VIEWPORTS = 1.5

/** Sub-pixel remainder at which the animation is over (see `approach`). */
const SNAP_EPSILON_PX = 0.5

/**
 * One frame of exponential approach, frame-rate independent: applying it
 * twice over `n` ms lands in the same place as once over `2n` ms, so the
 * scroll takes the same wall-clock time on a 30Hz display and a 144Hz one.
 *
 * Snaps once less than `SNAP_EPSILON_PX` remains — decay never actually
 * arrives, and without the snap the rAF loop would run forever on deltas too
 * small to see.
 */
export function approach(current: number, target: number, elapsedMs: number, halfLifeMs: number): number {
  const next = target + (current - target) * 2 ** (-elapsedMs / halfLifeMs)
  return Math.abs(target - next) < SNAP_EPSILON_PX ? target : next
}

/**
 * Duration of the reader's own jump back to the bottom, for a distance in
 * pixels (43e, Scroll). A jump is travel the reader asked for, not following
 * along, so it has a duration and an ease-out instead of `approach`'s decay.
 */
export function jumpDurationMs(distance: number): number {
  return Math.min(640, Math.max(320, 200 + distance * 0.18))
}

/** Past this many viewports a jump lands just short of the bottom first (43e). */
const JUMP_LAND_SHORT_ABOVE_VIEWPORTS = 2

/** How far short of the bottom that landing is, and the ease that finishes it (43e). */
const JUMP_LAND_SHORT_PX = 120
const JUMP_LAND_SHORT_MS = 240

export interface Scroller {
  /** Ease (or, per the rules above, jump) to the bottom of the content. */
  toBottom(options?: { instant?: boolean }): void
  /**
   * The reader's jump back to the bottom (the indicator, ⌘↓). Retargets like
   * `toBottom`: the bottom is re-read every frame, so rows arriving during
   * the jump are where it ends.
   */
  jump(): void
  /** True while the loop below owns `scrollTop` — see `Transcript`'s listener. */
  isAnimating(): boolean
  /** Hand `scrollTop` back to the user, leaving it wherever it got to. */
  cancel(): void
  /** Stop the loop and drop the listeners. */
  destroy(): void
}

/** True when the user has asked the OS to reduce motion. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

/**
 * Drives a scroll container's `scrollTop` toward the bottom of its content.
 *
 * Why this exists rather than `el.scrollTo({ behavior: 'smooth' })`: a native
 * smooth scroll fires `scroll` events at every intermediate position, and the
 * transcript's listener reads those to decide whether the reader is still at
 * the bottom. Mid-flight the answer is "no" — the animation has not arrived
 * yet — so the container would un-stick itself halfway through its own scroll
 * and the NEXT message would fail to follow. `isAnimating()` is the flag that
 * makes the listener ignore positions this loop produced. The native API
 * offers no such signal, nor any way to retarget a running scroll at content
 * that is still growing.
 *
 * Any real scroll input (wheel, touch, keyboard) cancels immediately: the
 * reader reaching for the scrollbar always outranks the animation.
 */
export function createScroller(el: HTMLElement): Scroller {
  let frame: number | null = null
  let last = 0

  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
  }

  const step = (now: number) => {
    const elapsed = now - last
    last = now
    const target = el.scrollHeight - el.clientHeight
    const next = approach(el.scrollTop, target, elapsed, SCROLL_HALF_LIFE_MS)
    el.scrollTop = next
    // Re-read the target every frame instead of closing over it: a message
    // landing mid-scroll has already moved the bottom by the time we get here.
    if (next === target) {
      stop()
      return
    }
    frame = requestAnimationFrame(step)
  }

  const onUserScroll = () => stop()

  el.addEventListener('wheel', onUserScroll, { passive: true })
  el.addEventListener('touchstart', onUserScroll, { passive: true })
  el.addEventListener('keydown', onUserScroll)

  return {
    toBottom(options) {
      const target = el.scrollHeight - el.clientHeight
      const distance = target - el.scrollTop
      if (distance <= 0) {
        stop()
        return
      }
      if (
        options?.instant ||
        prefersReducedMotion() ||
        distance > el.clientHeight * INSTANT_ABOVE_VIEWPORTS
      ) {
        stop()
        el.scrollTop = target
        return
      }
      if (frame !== null) return // already on its way; the loop retargets itself
      last = performance.now()
      frame = requestAnimationFrame(step)
    },
    jump() {
      stop()
      const target = () => el.scrollHeight - el.clientHeight
      let from = el.scrollTop
      const distance = target() - from
      if (distance <= 1 || prefersReducedMotion()) {
        el.scrollTop = target()
        return
      }
      let duration = jumpDurationMs(distance)
      if (distance > JUMP_LAND_SHORT_ABOVE_VIEWPORTS * el.clientHeight) {
        el.scrollTop = target() - JUMP_LAND_SHORT_PX
        from = el.scrollTop
        duration = JUMP_LAND_SHORT_MS
      }
      const start = performance.now()
      const travel = (now: number) => {
        const t = Math.min(1, (now - start) / duration)
        const eased = 1 - (1 - t) ** 3
        el.scrollTop = from + (target() - from) * eased
        if (t < 1) frame = requestAnimationFrame(travel)
        else {
          el.scrollTop = target()
          frame = null
        }
      }
      frame = requestAnimationFrame(travel)
    },
    isAnimating: () => frame !== null,
    cancel: stop,
    destroy() {
      stop()
      el.removeEventListener('wheel', onUserScroll)
      el.removeEventListener('touchstart', onUserScroll)
      el.removeEventListener('keydown', onUserScroll)
    },
  }
}

/**
 * The rows that just arrived at the bottom — the trailing run of keys that
 * were not in the previous render.
 *
 * Only a trailing run counts, and that is the whole point. Paging older history
 * prepends a page of keys that are every bit as new to this component, and
 * lighting those up would flash a screenful of history the reader asked to
 * see, not to be shown. Walking back from the end stops at the first
 * already-known key, so a prepend contributes nothing and a prepend landing
 * in the same render as an append still animates only the append.
 *
 * `prev` of `null` means this session has never rendered. Its whole backlog
 * is new and none of it arrived — that is a different thing from a session
 * that rendered empty and has now received its first message, which is an
 * arrival and does animate.
 */
export function enteringKeys(prev: readonly string[] | null, next: readonly string[]): string[] {
  if (prev === null) return []
  const known = new Set(prev)
  let start = next.length
  while (start > 0 && !known.has(next[start - 1])) start -= 1
  return next.slice(start)
}

/**
 * The jump-to-bottom indicator (spec 2026-10-04-transcript-jump-to-bottom-design).
 *
 * - `hidden` — the transcript is at its bottom and follows new rows.
 * - `above` — the reader has scrolled away from the bottom.
 * - `new` — scrolled away, and rows have arrived below since.
 *
 * Deliberately no count: `why-orbital` rules out counters that pile up, so
 * "something arrived" is all the indicator knows.
 */
export type BottomIndicator = 'hidden' | 'above' | 'new'

/**
 * What can happen to the indicator. `bottom` and `away` are the stick flag
 * changing (a scroll, a fold, a click back, a send); `arrived` is rows
 * entering at the bottom while the transcript is not stuck; `reset` is a
 * session or subagent switch, which lands at the bottom anyway.
 */
export type BottomEvent = 'bottom' | 'away' | 'arrived' | 'reset'

export function nextBottomIndicator(state: BottomIndicator, event: BottomEvent): BottomIndicator {
  switch (event) {
    case 'bottom':
    case 'reset':
      return 'hidden'
    case 'away':
      // Scrolling around above the bottom does not forget what arrived.
      return state === 'new' ? 'new' : 'above'
    case 'arrived':
      return 'new'
  }
}
