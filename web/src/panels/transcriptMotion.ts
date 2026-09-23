/**
 * How the transcript moves: the scroll that follows a new message, and which
 * rows count as having just arrived.
 *
 * Split out of `Transcript.tsx` because none of it is rendering — it is
 * arithmetic and one rAF loop, and it is where the interesting edge cases
 * live (a scroll target that moves while it is being animated to; telling an
 * appended row apart from one that merely scrolled into the window).
 */

/** Minimal shape `isNearBottom` needs from a scroll container — lets tests
 * inject fixture values, since jsdom never computes real scroll metrics. */
export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** True when the bottom of the scrollable content is within `threshold`
 * pixels of the current scroll position. */
export function isNearBottom(el: ScrollMetrics, threshold = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
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

export interface Scroller {
  /** Ease (or, per the rules above, jump) to the bottom of the content. */
  toBottom(options?: { instant?: boolean }): void
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
