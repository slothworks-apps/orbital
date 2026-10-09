import { useEffect, useRef, useState } from 'react'
import { useMapNotices } from '../store/mapNotices'
import { useOrbital, type Toast } from '../store/store'

/** The queue entry the store's toast rides as; there is never more than one. */
export const FEEDBACK_NOTICE_ID = 'toast'

/**
 * How long an `info` reply stays before it goes by itself, with the pointer
 * away from it. Canvas 4a: "Undo 10 s", the reply that needs it longest.
 */
export const FEEDBACK_NOTICE_MS = 10_000

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
 * The reply's card. Provisional until `Feature - Notice toast` has a feedback
 * variant: the notice card's family in one line — the errors log's red dot on
 * a failure, the message, at most one action, ×.
 *
 * `info` goes after `FEEDBACK_NOTICE_MS`, counted again from the start once
 * the pointer leaves it; a failure stays until ×, a newer reply, or (rewind)
 * the next send — its record is in the errors log either way. Dismissing marks
 * nothing seen (ADR errors-are-recorded-not-announced).
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
    const t = setTimeout(() => {
      // Only ours: a newer reply showing by now must stay.
      if (useOrbital.getState().toast === toast) clearToast()
    }, FEEDBACK_NOTICE_MS)
    return () => clearTimeout(t)
  }, [toast, hovered, clearToast])

  if (!shown) return null
  const failed = shown.kind !== 'info'
  // An error without an action of its own links to the log, where it is the
  // newest row; an info reply has no row there.
  const action =
    shown.action ?? (shown.kind === 'error' ? { label: 'Detail', run: () => setDialog('errors') } : undefined)
  // Undo has done its job once run, so it clears the reply; Details opens the
  // log and leaves it up.
  const clearsOnRun = shown.kind === 'info'

  return (
    <div
      role="status"
      aria-live="polite"
      data-kind={shown.kind}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className="flex max-w-full items-center gap-3 rounded-[12px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] py-2 pl-4 pr-2 text-left text-[13px] leading-[1.45] text-[rgba(214,226,242,.94)] shadow-[0_18px_50px_rgba(0,0,0,.55),inset_0_1px_0_rgba(255,255,255,.05)] backdrop-blur-[12px]"
    >
      {/* oklch(66% .2 25), the errors log's red. */}
      {failed && <span aria-hidden className="block h-[7px] w-[7px] flex-none rounded-full bg-[oklch(66%_.2_25)]" />}
      <span className="min-w-0 flex-1 [text-wrap:pretty]">{shown.message}</span>
      {action && (
        <button
          type="button"
          onClick={() => {
            action.run()
            if (clearsOnRun) clearToast()
          }}
          className="shrink-0 font-bold text-accent hover:text-text-soft"
        >
          {action.label}
        </button>
      )}
      <button
        type="button"
        onClick={clearToast}
        aria-label="Dismiss"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-[7px] text-[16px] text-[rgba(160,190,225,.65)] transition-colors hover:bg-[rgba(150,205,255,.08)] hover:text-text-bright"
      >
        ×
      </button>
    </div>
  )
}
