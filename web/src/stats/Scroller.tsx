import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/**
 * A scroll region that says when there is more below it: the canvas's fade
 * over the last few pixels (10a, drawn on the findings feed and reused by the
 * capped leaderboard under Ruling 16).
 *
 * The fade is measured, not permanent — a list that fits shows nothing, and a
 * list scrolled to its end stops claiming a remainder it no longer has.
 */
export function Scroller({
  className,
  wrapperClassName,
  style,
  children,
}: {
  /** Layout of the scrolling element itself (its flow, gaps, max height). */
  className?: string
  /** Layout of the positioned wrapper the fade is pinned to. */
  wrapperClassName?: string
  style?: CSSProperties
  children: ReactNode
}) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const [atEnd, setAtEnd] = useState(true)

  const measure = () => {
    const el = scroller.current
    if (el) setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 1)
  }
  // On mount and whenever the content changes, not only when someone scrolls.
  useEffect(measure, [children])

  return (
    <div className={`relative min-h-0 ${wrapperClassName ?? ''}`}>
      <div
        ref={scroller}
        onScroll={measure}
        style={style}
        className={`overflow-y-auto ${className ?? ''}`}
      >
        {children}
      </div>
      {!atEnd && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-[linear-gradient(180deg,transparent,rgba(10,15,26,.95)_78%)]" />
      )}
    </div>
  )
}
