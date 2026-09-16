import { useEffect, useRef, useState } from 'react'

export type PresenceState = 'entering' | 'entered' | 'exiting'

export interface Presence {
  /** Keep rendering while true — stays true through the exit transition. */
  mounted: boolean
  /** Drives which set of transition classes to apply. */
  state: PresenceState
}

/** True when the user has asked the OS to reduce motion. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

/**
 * Keeps a surface mounted long enough to animate out.
 *
 * A component that renders `null` the instant `open` goes false can only ever
 * animate IN — React has already removed the node by the time the exit
 * transition would run. This holds the node for `exitMs`, reporting `exiting`
 * so the caller can swap in its closed styles, then unmounts.
 *
 * The enter pass needs the element painted in its closed state for one frame
 * before the open styles land, or the browser has nothing to interpolate from
 * and the transition is skipped — hence the double `requestAnimationFrame`.
 *
 * Under `prefers-reduced-motion` both passes collapse to a single frame: the
 * surface still appears and disappears, just without a hold the user would
 * read as lag.
 */
export function usePresence(open: boolean, enterMs: number, exitMs: number): Presence {
  const [mounted, setMounted] = useState(open)
  const [state, setState] = useState<PresenceState>(open ? 'entered' : 'exiting')
  /** Mirrors `mounted` for the effect, which must not read stale state or re-run on it. */
  const mountedRef = useRef(open)
  const frames = useRef<number[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const cancel = () => {
      frames.current.forEach(cancelAnimationFrame)
      frames.current = []
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
    // Re-arm from scratch on every change: reopening mid-close must not leave
    // the previous close's unmount timer running, or the surface would vanish
    // moments after coming back.
    cancel()

    const reduced = prefersReducedMotion()

    if (open) {
      mountedRef.current = true
      setMounted(true)
      if (reduced || enterMs <= 0) {
        setState('entered')
        return cancel
      }
      setState('entering')
      frames.current.push(
        requestAnimationFrame(() => {
          frames.current.push(requestAnimationFrame(() => setState('entered')))
        })
      )
      return cancel
    }

    setState('exiting')
    // Never animate out something that was never shown — on first render with
    // `open` false there is nothing on screen to transition.
    if (!mountedRef.current || reduced || exitMs <= 0) {
      mountedRef.current = false
      setMounted(false)
      return cancel
    }
    timer.current = setTimeout(() => {
      mountedRef.current = false
      setMounted(false)
    }, exitMs)
    return cancel
  }, [open, enterMs, exitMs])

  return { mounted, state }
}
