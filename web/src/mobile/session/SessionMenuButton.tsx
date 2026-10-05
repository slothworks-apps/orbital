import { useState } from 'react'
import { SessionMenuSheet } from '../menu/SessionMenuSheet'
import type { SlotProps } from './slot'

/**
 * Header row 1, last: the ⋯ that opens the session's sheet — rename, tag,
 * pin, clear, end (spec 2026-10-05-mobile-next § 4; canvas 10i, 10j). It
 * opens while the Mac sleeps too: the sheet then shows its items inert.
 */
export function SessionMenuButton({ session, offline }: SlotProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* canvas 10i: the header's ⋯, a tinted 44 px square. */}
      <button
        type="button"
        aria-label="More"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] bg-[rgba(150,205,255,.1)] text-[18px] text-text-bright"
      >
        ⋯
      </button>
      {open && <SessionMenuSheet session={session} offline={offline} onClose={() => setOpen(false)} />}
    </>
  )
}
