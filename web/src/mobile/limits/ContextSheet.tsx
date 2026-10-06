import { formatContextWindow } from '../../lib/format'
import { sessionModelLabel } from '../../lib/models'
import type { ApiSession, OrbitalModel } from '../../lib/types'
import { asOfLabel } from '../format'
import { BottomSheet } from '../ui'
import { CONTEXT_INK, CONTEXT_TRACK, sheetHeadline, type ContextReading } from './context'

/**
 * Canvas 10l "CONTEXT SHEET · ON TAP": read-only facts about the session's
 * context. Nothing here acts — Clear lives in ⋯, and compacting is not a
 * phone action (spec 2026-10-05-mobile-next § 5).
 */
export function ContextSheet({
  session,
  reading,
  models,
  now,
  onDismiss,
}: {
  session: ApiSession
  reading: ContextReading
  models: OrbitalModel[]
  now: number
  onDismiss: () => void
}) {
  const headline = sheetHeadline(reading)
  const meta = [
    sessionModelLabel(session, models),
    reading.window !== null ? `${formatContextWindow(reading.window)} window` : null,
    // Measured at the last turn, which is the session's last activity.
    session.lastAt !== null ? asOfLabel(session.lastAt, now) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  // canvas 10l: the sheet's text sits 16 px in, the shell's 10 plus this block's 6.
  return (
    <BottomSheet label="Context" onDismiss={onDismiss}>
      <div className="px-1.5">
        <div className="font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">CONTEXT</div>
        <div className="mt-2 flex items-baseline gap-1.5 font-mono">
          <span className="text-[22px] text-text-bright">{headline.used}</span>
          <span className="text-[11px] text-[rgba(160,190,225,.6)]">{headline.rest}</span>
        </div>
        {reading.window !== null && (
          <div className="mt-2.5 h-1.5 rounded-[3px]" style={{ background: CONTEXT_TRACK }}>
            <div
              className="h-full rounded-[3px]"
              style={{ width: `${(reading.fill ?? 0) * 100}%`, background: CONTEXT_INK[reading.level] }}
            />
          </div>
        )}
        <div className="mt-2.5 text-[12px] leading-[1.5] text-pretty text-[rgba(160,190,225,.75)]">
          Grows with every turn. Near the window, Claude Code compacts the conversation on its own.
        </div>
        <div className="mt-2 font-mono text-[10px] text-[rgba(160,190,225,.5)]">{meta}</div>
      </div>
    </BottomSheet>
  )
}
