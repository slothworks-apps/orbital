import { useEffect, useRef, useState } from 'react'
import { useMapNotices } from '../store/mapNotices'
import { useOrbital, type Toast } from '../store/store'

/** The queue entry the store's toast rides as; there is never more than one. */
export const FEEDBACK_NOTICE_ID = 'toast'

/** How long an `info` reply stays, the pointer away from it (canvas 3a). */
export const FEEDBACK_NOTICE_MS = 4_000

/** The same for an `info` reply with an action to reach, Undo (canvas 3b). */
export const FEEDBACK_UNDO_MS = 6_000

/**
 * Keeps the store's toast in the Mac's notice queue (spec
 * 2026-10-09-one-place-for-messages-design): the reply to what the user just
 * did shows where every notice shows, ahead of them. A newer toast replaces
 * the one showing inside the same entry; a cleared one leaves the queue.
 * Mounted once per window, next to its `MapNoticeHost`.
 */
export function useFeedbackNotice(): void {
  const showing = useOrbital((s) => s.toast !== null)
  useEffect(() => {
    const notices = useMapNotices.getState()
    if (showing) notices.push({ id: FEEDBACK_NOTICE_ID, kind: 'feedback', Body: FeedbackNotice })
    else notices.dismiss(FEEDBACK_NOTICE_ID)
  }, [showing])
}

/**
 * The reply's card (canvas `Feature - Notice toast` 3a–3d): one line, 40 px,
 * as wide as its text up to the column's width (`MapNoticeHost`), a long one
 * ending in …; the errors log's red dot on a failure, at most one action,
 * ×. No head line, and a lighter shell than the notice it covers.
 *
 * `info` goes after `FEEDBACK_NOTICE_MS`, or `FEEDBACK_UNDO_MS` with an
 * action; the pointer over it holds it, and the count starts over when the
 * pointer leaves. A failure stays until ×, its action, a newer reply, or
 * (rewind) the next send — its record is in the errors log either way.
 * Dismissing marks nothing seen (ADR errors-are-recorded-not-announced).
 */
function FeedbackNotice() {
  const toast = useOrbital((s) => s.toast)
  const clearToast = useOrbital((s) => s.clearToast)
  const setDialog = useOrbital((s) => s.setDialog)
  const [hovered, setHovered] = useState(false)

  // The last reply stays drawn while the card fades out after it is cleared.
  const last = useRef<Toast | null>(toast)
  if (toast) last.current = toast
  const shown = toast ?? last.current

  useEffect(() => {
    if (toast?.kind !== 'info' || hovered) return
    const t = setTimeout(
      () => {
        // Only ours: a newer reply showing by now must stay.
        if (useOrbital.getState().toast === toast) clearToast()
      },
      toast.action ? FEEDBACK_UNDO_MS : FEEDBACK_NOTICE_MS,
    )
    return () => clearTimeout(t)
  }, [toast, hovered, clearToast])

  if (!shown) return null
  const failed = shown.kind !== 'info'
  // An error without an action of its own links to the log, where it is the
  // newest row (3c); an info reply has no row there.
  const action =
    shown.action ?? (shown.kind === 'error' ? { label: 'Detail', run: () => setDialog('errors') } : undefined)

  return (
    // 3a: 40 tall, 0/6/0/14 padding, 10 radius, the .12 hairline over a .9
    // fill, a shorter shadow than the notice's, a 12 px blur.
    <div
      role="status"
      aria-live="polite"
      data-kind={shown.kind}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className="flex h-10 max-w-full items-center gap-2.5 whitespace-nowrap rounded-[10px] border border-[rgba(150,205,255,.12)] bg-[rgba(10,16,28,.9)] pl-3.5 pr-1.5 text-[13px] text-[rgba(214,226,242,.94)] shadow-[0_10px_28px_rgba(0,0,0,.45)] backdrop-blur-[12px]"
    >
      {/* 3c: the only mark of a failure. oklch(66% .2 25), the errors log's red. */}
      {failed && <span aria-hidden className="block h-[7px] w-[7px] flex-none rounded-full bg-[oklch(66%_.2_25)]" />}
      <span className="min-w-0 overflow-hidden text-ellipsis">{shown.message}</span>
      {action && (
        <button
          type="button"
          // Every action ends the reply: Undo has happened, Detail has opened the log (3b, 3c).
          onClick={() => {
            action.run()
            clearToast()
          }}
          className="flex-none rounded-[7px] px-[9px] py-[5px] text-[12.5px] font-semibold text-text-bright transition-colors hover:bg-[rgba(150,205,255,.08)]"
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        onClick={clearToast}
        aria-label="Dismiss"
        className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[6px] text-[15px] text-[rgba(160,190,225,.6)] transition-colors hover:bg-[rgba(150,205,255,.08)] hover:text-text-bright"
      >
        ×
      </button>
    </div>
  )
}
