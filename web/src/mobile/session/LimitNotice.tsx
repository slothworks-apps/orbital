import { useState } from 'react'
import { api } from '../../lib/api'
import { useNow } from '../../lib/useNow'
import { useOrbital } from '../../store/store'
import { CLOCK_TICK_MS } from '../constants'
import { limitNoticeKey, phoneLimitNotice, QUEUED_NOTE } from '../limits/limitCopy'
import { useMobile } from '../state'
import type { SlotKeyProps, SlotProps } from './slot'

/** The bubbles' hue when the session has no tag — the desktop notice's own fallback. */
const UNTAGGED_HUE = 205

/**
 * The transcript's last row while the session waits for a plan limit: when
 * it continues, what it sends, Cancel / Undo, and the queued messages (spec
 * 2026-10-05-mobile-next § 5; canvas 10k, 10l). Never amber, never animated.
 *
 * Cancel and Undo change nothing here: the Mac republishes the session and
 * the notice redraws from its `limitWait`, as on the desktop. A terminal
 * session never has a wait (spec § 8 Decision 1).
 */
export function LimitNotice({ session, offline }: SlotProps) {
  const wait = session.limitWait
  const macName = useMobile((s) => s.macName)
  const hue = useOrbital((s) => s.tags.find((t) => t.id === session.tagIds[0])?.hue ?? UNTAGGED_HUE)
  const now = useNow(wait != null, CLOCK_TICK_MS)
  const [busy, setBusy] = useState(false)
  if (!wait || session.source === 'terminal') return null

  const notice = phoneLimitNotice(wait, { offline, macName, now })

  const act = () => {
    if (busy || notice.kind !== 'live' || !notice.action) return
    setBusy(true)
    const call = notice.action === 'cancel' ? api.cancelLimitWait(session.id) : api.undoLimitWait(session.id)
    call
      // Said on the composer's line, like every request of this phone (`phoneError`).
      .catch((err: unknown) =>
        useOrbital.setState({ toast: { kind: 'error', message: err instanceof Error ? err.message : String(err) } }),
      )
      .finally(() => setBusy(false))
  }

  return (
    <div data-limit-wait className="flex flex-col gap-3">
      {notice.kind === 'live' ? (
        // canvas 10k, first phone
        <div className="flex flex-col gap-2.5 rounded-[12px] border border-[rgba(150,205,255,.16)] bg-[rgba(8,12,22,.9)] px-3.5 py-3">
          <div className="flex items-start gap-2.5">
            <span
              aria-hidden
              className="mt-1 box-border block h-[9px] w-[9px] flex-none rounded-full border-[1.5px] border-[rgba(200,215,235,.7)]"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[14px] font-semibold">{notice.title}</span>
              <span className="font-mono text-[10.5px] leading-[1.5] text-[rgba(160,190,225,.7)]">{notice.sub}</span>
            </span>
          </div>
          <div className="flex items-center gap-2.5 pl-[19px]">
            <span className="min-w-0 flex-1 font-mono text-[10px] text-[rgba(160,190,225,.5)]">{notice.meta}</span>
            {notice.action && (
              <button
                type="button"
                onClick={act}
                disabled={busy}
                className="h-11 min-w-[88px] rounded-[12px] border border-[rgba(150,205,255,.22)] bg-transparent px-4 text-[13.5px] font-semibold text-text-bright"
              >
                {notice.action === 'cancel' ? 'Cancel' : 'Undo'}
              </button>
            )}
          </div>
        </div>
      ) : (
        // canvas 10k, second phone: the Mac asleep — no button
        <div className="flex flex-col gap-1.5 rounded-[12px] border border-[rgba(150,205,255,.12)] bg-[rgba(8,12,22,.85)] px-3.5 py-3">
          <span className="text-[14px] font-semibold text-[rgba(232,238,248,.85)]">{notice.title}</span>
          {notice.body && (
            <span className="text-[12.5px] leading-[1.5] text-pretty text-[rgba(160,190,225,.7)]">{notice.body}</span>
          )}
          <span className="font-mono text-[10px] text-[rgba(160,190,225,.5)]">{notice.meta}</span>
        </div>
      )}
      {wait.queued.map((text, i) => (
        // Written during the wait and held by the Mac until the reset: only
        // listed, never removable (spec "Decided before"). Dashed, because it
        // has not gone out yet (canvas 10k).
        <div key={i} data-limit-queued className="flex max-w-[84%] flex-col items-end gap-1 self-end">
          <div
            className="whitespace-pre-wrap rounded-[16px_16px_5px_16px] border border-dashed px-3.5 py-2.5 text-[14px] leading-[1.5]"
            style={{
              borderColor: `oklch(80% .13 ${hue} / ${offline ? '.3' : '.4'})`,
              color: offline ? 'rgba(232,238,248,.7)' : 'rgba(232,238,248,.85)',
            }}
          >
            {text}
          </div>
          {!offline && <span className="font-mono text-[10px] text-[rgba(160,190,225,.6)]">{QUEUED_NOTE}</span>}
        </div>
      ))}
    </div>
  )
}

/** As `useGateCardKey`, for the notice: null while there is none. */
export function useLimitNoticeKey({ session, offline }: SlotKeyProps): string | null {
  const wait = session?.limitWait
  if (!session || !wait || session.source === 'terminal') return null
  return limitNoticeKey(wait, offline)
}
