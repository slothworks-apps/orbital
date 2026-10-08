import { useEffect, useState } from 'react'
import { NOTICE_FADE_MS } from './motion'
import { prefersReducedMotion } from './usePresence'

/**
 * Which notice a host draws, and whether it is faded in (canvas `Feature -
 * Notice toast`: "The next one fades in in the same place: no slide"). The
 * first notice is simply there; one that goes fades out, and the next fades
 * in where it was. Under reduced motion every change is instant.
 */
export function useNoticeSwap<T extends { id: string }>(head: T | null): { shown: T | null; visible: boolean } {
  const [shown, setShown] = useState<T | null>(head)
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    if (head?.id === shown?.id) {
      if (visible) return
      // The next one, painted transparent for a frame first, or there is
      // nothing to fade from.
      let inner = 0
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setVisible(true))
      })
      return () => {
        cancelAnimationFrame(outer)
        cancelAnimationFrame(inner)
      }
    }
    if (!shown || prefersReducedMotion()) {
      setShown(head)
      setVisible(true)
      return
    }
    setVisible(false)
    const t = setTimeout(() => setShown(head), NOTICE_FADE_MS)
    return () => clearTimeout(t)
  }, [head, shown, visible])

  return { shown, visible }
}
