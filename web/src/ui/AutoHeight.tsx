import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { EASE_CURVE, HEIGHT_MS } from './motion'
import { prefersReducedMotion } from './usePresence'

/**
 * A box whose height follows its content with a transition instead of a snap:
 * a list arriving, a state line growing to two, a block appearing. CSS cannot
 * transition `height: auto`, so the content is measured with a
 * `ResizeObserver` and the box is given that height in pixels.
 *
 * The first measurement lands without a transition — the box opens at its
 * size rather than growing from nothing. Under `prefers-reduced-motion` every
 * change lands at once, as `usePresence` does for the dialogs.
 *
 * `scroll` makes the box the scroller when a parent caps it (a dialog that
 * never outgrows the viewport): it may shrink below its content in a flex
 * column and scrolls inside. While a height change is running it clips
 * instead, so a scrollbar does not flash for the length of the transition.
 *
 * Content that hangs outside the box (a dropdown) must be portalled: the box
 * clips — see "An overlay dies inside an `overflow: hidden`" in web/CLAUDE.md.
 */
export function AutoHeight({
  children,
  scroll = false,
  className,
}: {
  children: ReactNode
  scroll?: boolean
  /** Layout-only (flex, margin). */
  className?: string
}) {
  const innerRef = useRef<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const [animating, setAnimating] = useState(false)
  const measured = useRef(false)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)

  useLayoutEffect(() => {
    const inner = innerRef.current
    if (!inner || typeof ResizeObserver === 'undefined') return
    let last: number | null = null
    const observer = new ResizeObserver((entries) => {
      // The layout size, rounded up. Not `offsetHeight`, which rounds 399.4px
      // down into a 399px box that then overflows by a fraction and draws a
      // scrollbar with nothing to scroll; and not `getBoundingClientRect`,
      // which is scaled by the dialog's entrance (.97) and would be read once,
      // mid-animation, and kept — a transform never fires the observer again.
      const next = Math.ceil(entries[entries.length - 1]?.contentRect.height ?? inner.offsetHeight)
      if (next === last) return
      if (last !== null && !prefersReducedMotion()) {
        setAnimating(true)
        if (settle.current !== null) clearTimeout(settle.current)
        // `transitionend` does not fire when a transition is interrupted or
        // never starts; the timer is what always ends the clip.
        settle.current = setTimeout(() => setAnimating(false), HEIGHT_MS + 40)
      }
      measured.current = last !== null
      last = next
      setHeight(next)
    })
    observer.observe(inner)
    return () => {
      observer.disconnect()
      if (settle.current !== null) clearTimeout(settle.current)
    }
  }, [])

  const transition = measured.current && !prefersReducedMotion() ? `height ${HEIGHT_MS}ms ${EASE_CURVE}` : 'none'

  return (
    <div
      className={[scroll ? 'min-h-0 shrink' : '', className ?? ''].filter(Boolean).join(' ')}
      style={{
        height: height ?? 'auto',
        transition,
        overflowX: 'hidden',
        overflowY: scroll && !animating ? 'auto' : 'hidden',
      }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  )
}
