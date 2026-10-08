import type { ReactNode } from 'react'

/**
 * The notice toast's card on the desktop (canvas `Feature - Notice toast` 1a,
 * 1c): a mono label, ×, the message, and its actions on one row at the right
 * end. Never a modal and never a system notification; it blocks nothing
 * outside its own box and nothing makes it go by itself. Where it sits, the
 * dots above it and the fade between messages are `MapNoticeHost`'s.
 */
export function MapNotice({
  label,
  closeLabel = "Dismiss. This message won't come back",
  onClose,
  actions,
  children,
}: {
  /** The mono header, e.g. `NOTIFICATIONS · OFF`. */
  label: string
  /** What × says to a screen reader. */
  closeLabel?: string
  onClose: () => void
  /** The buttons, secondary first: the row ends with the primary. */
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    // 1a: 540 wide, 14/14/14/20 padding, 12 radius, the .16 hairline over a
    // near-opaque fill, its drop shadow and top glint, a 12 px blur.
    <div
      role="status"
      aria-label={label}
      className="flex w-full flex-col gap-2.5 rounded-[12px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] py-3.5 pl-5 pr-3.5 text-left shadow-[0_18px_50px_rgba(0,0,0,.55),inset_0_1px_0_rgba(255,255,255,.05)] backdrop-blur-[12px]"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1 font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.65)]">{label}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title="Dismiss · won't show again"
          className="grid h-7 w-7 place-items-center rounded-[7px] text-[16px] text-[rgba(160,190,225,.65)] transition-colors hover:bg-[rgba(150,205,255,.08)] hover:text-text-bright"
        >
          ×
        </button>
      </div>
      {children}
      {actions && <div className="flex items-center justify-end gap-1.5 pr-1.5 pt-0.5">{actions}</div>}
    </div>
  )
}

/** A message's sentence (1a): 14 px at 1.5, 10 px clear of the right edge. */
export function MapNoticeText({ children }: { children: ReactNode }) {
  return <p className="pr-2.5 text-[14px] leading-[1.5] text-[rgba(214,226,242,.94)] [text-wrap:pretty]">{children}</p>
}
