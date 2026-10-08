import { useEffect, useRef, type ReactNode } from 'react'
import { PausableTimer } from '../lib/pausableTimer'

/**
 * The shell of a notice at the top centre of the map (canvas `Feature -
 * Notifications off` 1a, 1b, 1d): a mono label, ×, and whatever the notice
 * says and offers underneath. Never a modal and never a system notification;
 * it blocks nothing outside its own box. Where it sits, one at a time, and its
 * fade on the way out are `MapNoticeHost`'s; this is only the card.
 *
 * `autoCloseMs` closes it after that long, the countdown paused while the
 * pointer is over it (1b: "stays 8 s, paused on hover"). Changing it restarts
 * the countdown, so a notice that moves to a confirming state passes the
 * time only then.
 */
export function MapNotice({
  label,
  closeLabel,
  onClose,
  autoCloseMs,
  children,
}: {
  /** The mono header, e.g. `NOTIFICATIONS · OFF`. */
  label: string
  /** What × says to a screen reader and on hover. */
  closeLabel: string
  onClose: () => void
  autoCloseMs?: number
  children: ReactNode
}) {
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  const timer = useRef<PausableTimer | null>(null)
  // Turn on is clicked with the pointer on the card, so the countdown it
  // starts begins paused, and runs once the pointer leaves.
  const hovered = useRef(false)

  useEffect(() => {
    if (autoCloseMs === undefined) return
    const t = new PausableTimer(autoCloseMs, () => close.current())
    timer.current = t
    if (!hovered.current) t.resume()
    return () => {
      t.cancel()
      timer.current = null
    }
  }, [autoCloseMs])

  return (
    // 1a: 540 wide, 16/14/16/20 padding, 12 radius, the .16 hairline over a
    // near-opaque fill, its drop shadow and top glint, a 12 px blur.
    <div
      role="status"
      aria-label={label}
      onMouseEnter={() => {
        hovered.current = true
        timer.current?.pause()
      }}
      onMouseLeave={() => {
        hovered.current = false
        timer.current?.resume()
      }}
      className="flex w-[540px] max-w-full flex-col gap-2.5 rounded-[12px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] pb-4 pl-5 pr-3.5 pt-4 shadow-[0_18px_50px_rgba(0,0,0,.55),inset_0_1px_0_rgba(255,255,255,.05)] backdrop-blur-[12px]"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.65)]">{label}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
          className="grid h-7 w-7 place-items-center rounded-[7px] text-[16px] text-[rgba(160,190,225,.65)] transition-colors hover:bg-[rgba(150,205,255,.08)] hover:text-text-bright"
        >
          ×
        </button>
      </div>
      {children}
    </div>
  )
}
