import { useState } from 'react'
import { useNow } from '../../lib/useNow'
import { useOrbital } from '../../store/store'
import { CLOCK_TICK_MS } from '../constants'
import { ContextSheet } from '../limits/ContextSheet'
import { contextReading, readoutLines, ringGradient } from '../limits/context'
import type { SlotProps } from './slot'

/** Canvas 10k: the ring's stroke, cut out of a filled disc. */
const RING_MASK = 'radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px))'

/**
 * Header row 1, after the title: "used / window" and its ring, tapping into
 * the context sheet (spec 2026-10-05-mobile-next § 5; canvas 10k, 10l). It
 * changes per turn without animating. Absent for a terminal session, whose
 * context is never measured (spec § 8 Decision 1).
 */
export function ContextReadout({ session, offline }: SlotProps) {
  const models = useOrbital((s) => s.models)
  const learned = useOrbital((s) => s.contextWindows)
  const [open, setOpen] = useState(false)
  const now = useNow(open, CLOCK_TICK_MS)
  const reading = contextReading(session, models, learned)
  if (!reading) return null

  const lines = readoutLines(reading)
  const ring = ringGradient(reading)

  return (
    <>
      <button
        type="button"
        aria-label="Context used"
        onClick={() => setOpen(true)}
        // canvas 10k: dimmed while the Mac sleeps — the number is the last sync's.
        className={['flex h-11 shrink-0 items-center gap-[7px] px-1', offline ? 'opacity-70' : ''].join(' ')}
      >
        <span className="flex flex-col items-end font-mono leading-[1.2]">
          <span className="text-[11px] text-text-bright">{lines.used}</span>
          {lines.window && <span className="text-[9.5px] text-[rgba(160,190,225,.55)]">{lines.window}</span>}
        </span>
        {ring && (
          <span
            aria-hidden
            className="block h-[18px] w-[18px] rounded-full"
            style={{ background: ring, WebkitMask: RING_MASK, mask: RING_MASK }}
          />
        )}
      </button>
      {open && (
        <ContextSheet session={session} reading={reading} models={models} now={now} onDismiss={() => setOpen(false)} />
      )}
    </>
  )
}
