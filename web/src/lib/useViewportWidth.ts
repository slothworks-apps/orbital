import { useEffect, useState } from 'react'

/**
 * The window's inner width, followed through every resize. The one source of
 * the viewport width for anything that renders from it: `window.innerWidth`
 * is neither React nor store state, so a component that reads it during
 * render only notices a resize when something unrelated re-renders it.
 *
 * A drag-resize fires `resize` many times a frame; the width is committed at
 * most once per animation frame, and the frame reads the latest value, so
 * the last resize of a burst is never lost.
 */
export function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    let frame: number | null = null
    const onResize = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        setWidth(window.innerWidth)
      })
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])
  return width
}
