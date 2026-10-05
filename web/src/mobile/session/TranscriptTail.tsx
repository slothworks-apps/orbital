import { MenuOutcome, useMenuOutcomeKey } from '../menu/MenuOutcome'
import { GateCard, useGateCardKey } from './GateCard'
import { LimitNotice, useLimitNoticeKey } from './LimitNotice'
import type { SlotKeyProps, SlotProps } from './slot'

/**
 * What ends the session's transcript, in this order: the harness gate's card
 * (T1.1), the limit wait's notice (T5.1), the ⋯ sheet's ✓ line after End or
 * Clear (T4.1), and while the Mac sleeps the 9b divider where the data ends.
 * Each piece draws nothing when it has nothing to say.
 */
export function TranscriptTail(props: SlotProps) {
  return (
    <>
      <GateCard {...props} />
      <LimitNotice {...props} />
      <MenuOutcome {...props} />
      {props.offline && (
        // Where the data ends while the Mac sleeps (9b offline).
        <div className="my-4 flex items-center gap-3 font-mono text-[10px] tracking-[0.14em] text-text-muted">
          <span className="h-px flex-1 bg-panel-border" />
          <span>NOTHING NEWER · MAC ASLEEP</span>
          <span className="h-px flex-1 bg-panel-border" />
        </div>
      )}
    </>
  )
}

/**
 * The tail's `footerKey`: changes whenever any piece's content does, so a
 * reader sitting at the bottom is kept there as the card, the notice or the
 * ✓ line appears or changes.
 */
export function useTranscriptTailKey(props: SlotKeyProps): string {
  const gate = useGateCardKey(props)
  const limit = useLimitNoticeKey(props)
  const outcome = useMenuOutcomeKey(props)
  return [props.offline ? 'offline' : 'live', gate ?? '-', limit ?? '-', outcome ?? '-'].join('|')
}
