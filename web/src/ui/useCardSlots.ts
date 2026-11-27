import { useLayoutEffect, useRef, useState } from 'react'
import { modelCardSlots } from '../lib/models'

/**
 * How many model cards a row holds, Other included (`modelCardSlots`, canvas
 * 72c): the row is measured, and again whenever it resizes. Until it has
 * been — and in jsdom, which measures nothing — `fallbackWidth` stands in.
 * `drawn` re-measures once the row exists: it is drawn only while the
 * catalog has rows.
 */
export function useCardSlots(drawn: boolean, fallbackWidth: number) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next !== undefined) setWidth(next)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [drawn])
  return { ref, slots: modelCardSlots(width > 0 ? width : fallbackWidth) }
}
