/**
 * The scenario "director": steps a demo through a short script of beats on a
 * timer, in a loop, until the visitor does something (spec
 * 2026-10-08-landing-site-design § Scenarios).
 *
 * The rules live in `stepDirector`, a pure function the tests drive tick by
 * tick; `runDirector` only wires it to a timer, the visitor's input and the
 * reduced-motion preference.
 */

/** Where the script stands. `beat` indexes the script; `elapsed` counts ticks spent in it. */
export interface DirectorState {
  beat: number
  elapsed: number
  /** The visitor took over. Nothing advances again for this page view. */
  stopped: boolean
}

export type DirectorInput = { kind: 'tick'; reducedMotion: boolean } | { kind: 'interaction' }

export const INITIAL_DIRECTOR: DirectorState = { beat: 0, elapsed: 0, stopped: false }

/**
 * One step. `durations[i]` is how many ticks beat `i` holds before the next
 * one; after the last beat the script starts over at the first.
 *
 * - The first interaction stops the director for good: from then on the demo
 *   does only what the visitor does.
 * - Under reduced motion a tick changes nothing — the demo holds its first
 *   frame rather than moving on its own. It resumes if the preference is
 *   lifted, since nothing was interrupted.
 */
export function stepDirector(
  durations: readonly number[],
  state: DirectorState,
  input: DirectorInput,
): DirectorState {
  if (state.stopped) return state
  if (input.kind === 'interaction') return { ...state, stopped: true }
  if (input.reducedMotion || durations.length === 0) return state
  const elapsed = state.elapsed + 1
  if (elapsed < Math.max(1, durations[state.beat])) return { ...state, elapsed }
  return { beat: (state.beat + 1) % durations.length, elapsed: 0, stopped: false }
}

/**
 * The events that count as the visitor taking over. Not `wheel`: a wheel
 * over a demo is most often the visitor scrolling the website past it, and
 * the map demo hands every wheel on to the page (`map/main.tsx`).
 */
export const INTERACTION_EVENTS = ['pointerdown', 'keydown'] as const

/**
 * Runs a script on `window`'s clock. `onBeat` is called with each new beat
 * (not with the first one: the page renders that itself). Returns a stop
 * function for teardown.
 */
export function runDirector(opts: {
  durations: readonly number[]
  tickMs: number
  onBeat: (beat: number) => void
  target?: Window
}): () => void {
  const target = opts.target ?? window
  const reduced = target.matchMedia('(prefers-reduced-motion: reduce)')
  let state = INITIAL_DIRECTOR

  const timer = target.setInterval(() => {
    const next = stepDirector(opts.durations, state, { kind: 'tick', reducedMotion: reduced.matches })
    const moved = next.beat !== state.beat
    state = next
    if (moved) opts.onBeat(next.beat)
  }, opts.tickMs)

  const stop = () => {
    target.clearInterval(timer)
    for (const type of INTERACTION_EVENTS) target.removeEventListener(type, onInteraction, true)
  }
  const onInteraction = () => {
    state = stepDirector(opts.durations, state, { kind: 'interaction' })
    stop()
  }
  // Capture, so a component that stops propagation still counts as touched.
  for (const type of INTERACTION_EVENTS) target.addEventListener(type, onInteraction, { capture: true, passive: true })
  return stop
}
