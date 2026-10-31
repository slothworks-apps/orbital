import { MenuOutcome, useMenuOutcomeKey } from '../menu/MenuOutcome'
import { GateCard, useGateCardKey } from './GateCard'
import { LimitNotice, useLimitNoticeKey } from './LimitNotice'
import type { SlotKeyProps, SlotProps } from './slot'
import { NoticeRow } from '../../panels/NoticeRow'
import { useOrbital } from '../../store/store'

/**
 * What ends the session's transcript, in this order: the live notice of
 * something no message shows, a Stop hook running (spec
 * 2026-10-31-message-beats-stop-hook-design), the harness gate's card
 * (T1.1), the limit wait's notice (T5.1), the ⋯ sheet's ✓ line after End or
 * Clear (T4.1), and while the Mac sleeps the 9b divider where the data ends.
 * Each piece draws nothing when it has nothing to say.
 */
export function TranscriptTail(props: SlotProps) {
  const liveNotice = useOrbital((s) => (props.session.status === 'working' ? s.liveNotices[props.session.id] : undefined))
  return (
    <>
      {/* Not from the last sync: while the Mac sleeps, nothing is known to run. */}
      {liveNotice && !props.offline && <NoticeRow message={liveNotice} />}
      <GateCard {...props} />
      <LimitNotice {...props} />
      <MenuOutcome {...props} />
      {props.offline && (
        // Where the data ends while the Mac sleeps (9b offline).
        <div className="my-4 flex items-center gap-3 font-mono fs-10 tracking-[0.14em] text-ink-900/70">
          <span className="h-px flex-1 bg-line/14" />
          <span>NOTHING NEWER · MAC ASLEEP</span>
          <span className="h-px flex-1 bg-line/14" />
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
  const notice = useOrbital((s) =>
    props.session?.status === 'working' && !props.offline ? s.liveNotices[props.session.id]?.id : undefined,
  )
  return [props.offline ? 'offline' : 'live', notice ?? '-', gate ?? '-', limit ?? '-', outcome ?? '-'].join('|')
}
