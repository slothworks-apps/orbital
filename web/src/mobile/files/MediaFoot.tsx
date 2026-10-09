import { useEffect, type ReactNode, type RefObject } from 'react'
import { mediaClock, mediaSourceLabel } from '../../lib/media'
import type { MediaItem } from '../../lib/types'
import { releaseGesture } from './zoom'

/**
 * The viewer's foot when it pages through the session's media (canvas
 * `Feature - Media` 24g, PDF viewer): an optional chip and the gesture hint,
 * then the source line and ↩ Show in chat.
 */
export function MediaFoot({
  item,
  chip,
  hint,
  above,
  onShowInChat,
}: {
  item: MediaItem
  /** 24g: the PDF's "page 2 of 6". */
  chip?: string | null
  hint?: string | null
  /** What stands over the rows — the cached chip of 10e. */
  above?: ReactNode
  onShowInChat: () => void
}) {
  const clock = mediaClock(item.ts)
  return (
    <div className="relative z-[2] flex shrink-0 flex-col gap-2.5 bg-[linear-gradient(0deg,rgba(0,0,0,.85),transparent)] px-4 pb-1.5 pt-[18px]">
      {above}
      {(chip || hint) && (
        <div className="flex items-center gap-2 font-mono text-[11px] text-[rgba(200,215,235,.75)]">
          {chip && (
            <span className="rounded-full border border-[rgba(150,205,255,.2)] bg-[rgba(5,7,13,.75)] px-2 py-[3px] text-[#e8eef8]">
              {chip}
            </span>
          )}
          <span className="flex-1" />
          {hint && <span>{hint}</span>}
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[rgba(200,215,235,.75)]">
          {[mediaSourceLabel(item), clock].filter(Boolean).join(' · ')}
        </span>
        <button
          type="button"
          onClick={onShowInChat}
          className="flex h-11 shrink-0 items-center rounded-[12px] border border-[rgba(150,205,255,.22)] bg-[rgba(5,7,13,.6)] px-3.5 text-[13px] font-semibold text-[#e8eef8]"
        >
          ↩ Show in chat
        </button>
      </div>
    </div>
  )
}

/**
 * Swipe ↔ to the next or previous item, and down to go back, on a surface
 * that keeps its own scrolling — a PDF's pages, a gone file's footprint. The
 * listeners are passive: they only read where a finger went, so a vertical
 * scroll stays the WebView's. `back` is left out where down is a scroll.
 */
export function useSwipe(
  ref: RefObject<HTMLElement | null>,
  onPage: (delta: number) => void,
  onBack?: () => void,
): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let start: { x: number; y: number } | null = null
    const onStart = (e: TouchEvent) => {
      start = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null
    }
    const onEnd = (e: TouchEvent) => {
      const from = start
      start = null
      if (!from || e.touches.length > 0) return
      const t = e.changedTouches[0]
      const action = releaseGesture(1, t.clientX - from.x, t.clientY - from.y)
      if (action === 'next' || action === 'prev') onPage(action === 'next' ? 1 : -1)
      else if (action === 'back') onBack?.()
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchend', onEnd, { passive: true })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchend', onEnd)
    }
  }, [ref, onPage, onBack])
}
