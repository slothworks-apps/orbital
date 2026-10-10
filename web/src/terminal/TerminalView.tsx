import { useEffect, useLayoutEffect, useRef } from 'react'
import { runtimeFor, type TerminalLook } from './runtime'
import { useTerminals } from './store'

/**
 * Where one tab's terminal is drawn. The terminal itself is not this
 * component's: it lives in `runtime` for as long as its session is selected,
 * and this only lends it a place on the page — so a tab switched away from
 * and back to has its scrollback and cursor exactly as it left them.
 *
 * Its size follows the element's (the fit addon), and every change of it goes
 * to the shell as a resize.
 */
export default function TerminalView({ id, look }: { id: string; look: TerminalLook }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const lookRef = useRef(look)
  lookRef.current = look

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const runtime = runtimeFor(id, lookRef.current)
    runtime.attach(el)
    let frame = 0
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => runtime.refit())
          })
    observer?.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      runtime.detach()
    }
  }, [id])

  useEffect(() => {
    runtimeFor(id, look).setLook(look)
  }, [id, look])

  // A focus asked for this tab — a new tab, ⌃`, ⌘1–9 — lands once it is on
  // the page, and only once.
  const focusRequest = useTerminals((s) => (s.focusRequest?.id === id ? s.focusRequest : null))
  useEffect(() => {
    if (!focusRequest) return
    runtimeFor(id, lookRef.current).focus()
    useTerminals.setState((s) => (s.focusRequest?.seq === focusRequest.seq ? { focusRequest: null } : s))
  }, [id, focusRequest])

  return <div ref={ref} className="h-full min-h-0 w-full" />
}
