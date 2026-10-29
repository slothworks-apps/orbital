import { swatch } from '../../lib/palette'
import { useState } from 'react'
import { api } from '../../lib/api'
import { useNow } from '../../lib/useNow'
import { useOrbital } from '../../store/store'
import { CLOCK_TICK_MS } from '../constants'
import { limitNoticeKey, phoneLimitNotice, QUEUED_NOTE } from '../limits/limitCopy'
import { useSessionDeviceName } from '../useDevice'
import type { SlotKeyProps, SlotProps } from './slot'
import { primaryTag } from '../../lib/primaryTag'

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
  const macName = useSessionDeviceName(session.id)
  const hue = useOrbital((s) => primaryTag(session.tagIds, s.tags)?.hue ?? UNTAGGED_HUE)
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
        <div className="flex flex-col gap-2.5 rounded-[12px] border border-line/16 bg-space-deep/90 px-3.5 py-3">
          <div className="flex items-start gap-2.5">
            <span
              aria-hidden
              className="mt-1 box-border block h-[9px] w-[9px] flex-none rounded-full border-[1.5px] border-ink-600/70"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="fs-14 font-semibold">{notice.title}</span>
              <span className="font-mono fs-10.5 leading-[1.5] text-ink-900/70">{notice.sub}</span>
            </span>
          </div>
          <div className="flex items-center gap-2.5 pl-[19px]">
            <span className="min-w-0 flex-1 font-mono fs-10 text-ink-900/50">{notice.meta}</span>
            {notice.action && (
              <button
                type="button"
                onClick={act}
                disabled={busy}
                className="h-11 min-w-[88px] rounded-[12px] border border-line/22 bg-transparent px-4 fs-13.5 font-semibold text-ink-100"
              >
                {notice.action === 'cancel' ? 'Cancel' : 'Undo'}
              </button>
            )}
          </div>
        </div>
      ) : (
        // canvas 10k, second phone: the Mac asleep — no button
        <div className="flex flex-col gap-1.5 rounded-[12px] border border-line/12 bg-space-deep/85 px-3.5 py-3">
          <span className="fs-14 font-semibold text-ink-100/85">{notice.title}</span>
          {notice.body && (
            <span className="fs-12.5 leading-[1.5] text-pretty text-ink-900/70">{notice.body}</span>
          )}
          <span className="font-mono fs-10 text-ink-900/50">{notice.meta}</span>
        </div>
      )}
      {wait.queued.map((text, i) => (
        // Written during the wait and held by the Mac until the reset: only
        // listed, never removable (spec "Decided before"). Dashed, because it
        // has not gone out yet (canvas 10k).
        <div key={i} data-limit-queued className="flex max-w-[84%] flex-col items-end gap-1 self-end">
          <div
            className="whitespace-pre-wrap rounded-[16px_16px_5px_16px] border border-dashed px-3.5 py-2.5 fs-14 leading-[1.5]"
            style={{
              borderColor: `oklch(var(--tb-l) var(--tb-c) ${hue} / ${offline ? '.3' : '.4'})`,
              color: offline ? swatch('ink-100', 0.7) : swatch('ink-100', 0.85),
            }}
          >
            {text}
          </div>
          {!offline && <span className="font-mono fs-10 text-ink-900/60">{QUEUED_NOTE}</span>}
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
