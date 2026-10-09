import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** The gap between the tapped line and the bubble, and the bubble's margin from the screen's edges. */
const GAP_PX = 6
const EDGE_PX = 8

/**
 * A line the phone cuts short — the session's title, its project · branch —
 * made tappable: a tap shows the whole of `text` in a bubble under it, and
 * the next tap anywhere puts it away. A line that is not cut does nothing.
 *
 * The phone has no hover, so this is its tooltip. `cut` says the caller
 * already shortened the words (`fitWhere`'s middle cut); an ellipsis drawn by
 * CSS is measured at the tap.
 */
export function FullTextTip({
  text,
  cut = false,
  mono = false,
  className = '',
  children,
}: {
  text: string
  cut?: boolean
  mono?: boolean
  /** Layout-only passthrough. */
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!at) return
    const close = (e: Event) => {
      // A tap on the line itself is the button's to toggle.
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      setAt(null)
    }
    const closeNow = () => setAt(null)
    document.addEventListener('pointerdown', close, true)
    window.addEventListener('resize', closeNow)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      window.removeEventListener('resize', closeNow)
    }
  }, [at])

  function toggle() {
    const el = ref.current
    if (!el) return
    if (at) {
      setAt(null)
      return
    }
    if (!cut && !overflows(el)) return
    const rect = el.getBoundingClientRect()
    setAt({ top: rect.bottom + GAP_PX, left: Math.max(EDGE_PX, rect.left) })
  }

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-expanded={at !== null}
        onClick={toggle}
        className={['min-w-0 text-left', className].join(' ')}
      >
        {children}
      </button>
      {at &&
        createPortal(
          <div
            role="tooltip"
            className={[
              'fixed z-50 rounded-[8px] border border-[rgba(150,205,255,.2)] bg-[rgba(10,16,28,.97)] px-2.5 py-1.5 text-text-bright shadow-[0_6px_24px_rgba(0,0,0,.5)] [overflow-wrap:anywhere]',
              mono ? 'font-mono text-[11.5px]' : 'text-[13.5px]',
            ].join(' ')}
            style={{ top: at.top, left: at.left, maxWidth: `calc(100vw - ${at.left + EDGE_PX}px)` }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  )
}

/** Whether CSS cut the line or anything in it short. */
function overflows(root: HTMLElement): boolean {
  return [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].some((el) => el.scrollWidth > el.clientWidth + 1)
}
