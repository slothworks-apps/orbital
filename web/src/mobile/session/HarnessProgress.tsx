import { useState } from 'react'
import { createPortal } from 'react-dom'
import { isReadOnly } from '../../lib/types'
import { progress } from '../harness/gate'
import { SEGMENT_INK, StepsSheet } from '../harness/StepsSheet'
import { useHarness } from '../harness/useHarness'
import type { SlotProps } from './slot'

/**
 * Header row 2, after the state: the harness's step segments and "4/7 ▸",
 * tapping into the steps sheet (spec 2026-10-05-mobile-next § 1; canvas
 * 10b). Reads before the harness arrives from the snapshot's `harnessStep`;
 * the sheet opens once the harness is held. Still, like the gate.
 */
export function HarnessProgress({ session }: SlotProps) {
  const { harness, events } = useHarness(session.id)
  const [open, setOpen] = useState(false)
  if (isReadOnly(session)) return null
  const reading = progress(harness, events, session)
  if (!reading) return null

  return (
    <>
      <button
        type="button"
        aria-label={`Harness steps, ${reading.count}`}
        disabled={!harness}
        onClick={() => setOpen(true)}
        className="flex h-11 shrink-0 items-center gap-[7px] px-2 font-mono text-[10.5px] text-[rgba(200,220,245,.8)]"
      >
        {/* Canvas 10b: 5 × 10 px segments, 2 px apart. */}
        <span aria-hidden className="flex gap-0.5">
          {reading.tones.map((tone, i) => (
            <span key={i} className="block h-2.5 w-[5px] rounded-[1.5px]" style={{ background: SEGMENT_INK[tone] }} />
          ))}
        </span>
        {reading.count}
        <span aria-hidden className="text-[9px] text-[rgba(160,190,225,.6)]">
          ▸
        </span>
      </button>
      {open &&
        harness &&
        // Out of the header: a fixed sheet inside a clipped or transformed ancestor is cut away.
        createPortal(
          <StepsSheet sessionId={session.id} harness={harness} events={events} onDismiss={() => setOpen(false)} />,
          document.body,
        )}
    </>
  )
}
