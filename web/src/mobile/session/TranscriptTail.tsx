import { MenuOutcome, useMenuOutcomeKey } from '../menu/MenuOutcome'
import { SecondaryButton } from '../ui'
import { GateCard, useGateCardKey } from './GateCard'
import { LimitNotice, useLimitNoticeKey } from './LimitNotice'
import type { SlotKeyProps, SlotProps } from './slot'
import { HoldGlyph, HookWaitCaption, hookRowFade, hookRowOf, useHookRow, waitedFor } from '../../panels/HookNotice'
import { stateColor } from '../../lib/stateStyle'
import { waitingBehind } from '../../lib/hookWait'
import type { ChatMessage } from '../../lib/types'
import { useOrbital } from '../../store/store'

/**
 * What ends the session's transcript, in this order: the harness gate's card
 * (T1.1), the limit wait's notice (T5.1), the ⋯ sheet's ✓ line after End or
 * Clear (T4.1), and while the Mac sleeps the 9b divider where the data ends.
 * Each piece draws nothing when it has nothing to say. The live row of a
 * running hook is not here: it sits above the messages waiting behind it
 * (`useLiveHookRow`).
 */
export function TranscriptTail(props: SlotProps) {
  return (
    <>
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

/** The live notice the phone draws: only while the session works, and not from the last sync while the Mac sleeps. */
function useLiveNotice(props: SlotKeyProps): ChatMessage | undefined {
  return useOrbital((s) =>
    props.session?.status === 'working' && !props.offline ? s.liveNotices[props.session.id] : undefined,
  )
}

/**
 * The transcript's live row and the caption under the messages that wait
 * behind it (canvas `Feature - Stop hook` 1a, 1g), for `TranscriptView`.
 */
export function useLiveHookRow(props: SlotKeyProps) {
  const notice = useLiveNotice(props)
  return {
    liveRow: props.session ? <PhoneHookNotice sessionId={props.session.id} message={notice} /> : undefined,
    isWaiting: waitingBehind(notice),
    waitCaption: notice ? (count: number) => <HookWaitCaption hook={waitedFor(notice)} count={count} phone /> : undefined,
  }
}

/** 1d PHONE PROPOSED: the WORKING colour at 35% over a 6% fill, as on the Mac. */
const WORKING = stateColor('working')
const ROW_TINT = {
  borderColor: `color-mix(in oklab, ${WORKING} 35%, transparent)`,
  background: `color-mix(in oklab, ${WORKING} 6%, transparent)`,
}

/**
 * The phone's live hook row (1d PHONE PROPOSED): 37 px, its sentence free to
 * wrap to two lines once a message waits, the tool but no command. Cancel,
 * on a Stop hook's row only, interrupts the session: the Mac takes that for
 * the hooks' cancel, as the desktop's Cancel does.
 */
function PhoneHookNotice({ sessionId, message }: { sessionId: string; message: ChatMessage | undefined }) {
  const live = useHookRow(sessionId, message, (err: unknown) =>
    // Said on the composer's line, like every request of this phone.
    useOrbital.setState({ toast: { kind: 'error', message: err instanceof Error ? err.message : String(err) } }),
  )
  if (!live.row) return null
  const { hook, lead, cancellable } = hookRowOf(live.row)
  return (
    <div
      data-hook-notice
      inert={live.leaving || undefined}
      className={['flex items-center gap-2.5 rounded-[12px] border py-[7px] pl-3 pr-1.5', hookRowFade(live.visible, live.leaving)].join(' ')}
      style={ROW_TINT}
    >
      <span className="grid w-[10px] flex-none place-items-center" style={{ color: WORKING }}>
        <HoldGlyph phone />
      </span>
      <span className="min-w-0 flex-1 fs-14 font-semibold leading-[1.5] text-ink-100 [text-wrap:pretty]">
        {lead}
        {hook?.tool && <span className="font-mono fs-12 font-normal text-ink-900/60"> · {hook.tool}</span>}
      </span>
      {cancellable && (
        // The 44 × 64 target laid out at the pill's height: it reaches 4 px
        // past the row's border into the transcript gap.
        <span className="-my-[11.5px] flex shrink-0">
          <SecondaryButton variant="row-pill" onClick={live.cancel} disabled={live.busy}>
            {live.busy ? 'Cancelling' : 'Cancel'}
          </SecondaryButton>
        </span>
      )}
    </div>
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
  // Its text too: it grows a clause once a message waits behind the hooks.
  const row = useLiveNotice(props)
  const notice = row ? `${row.id}:${row.text}` : undefined
  return [props.offline ? 'offline' : 'live', notice ?? '-', gate ?? '-', limit ?? '-', outcome ?? '-'].join('|')
}
