import { useRef } from 'react'
import type { MediaItem } from '../../lib/types'
import { ViewFrame } from '../../panels/ViewFrame'
import { useSwipe } from './MediaFoot'

/**
 * A generated view in the phone's media viewer (canvas `Feature - Views`
 * 69e, THE VIEWER AT PHONE WIDTH; spec 2026-11-18-generated-views-design §
 * Media): full screen, × and the counter on top, ‹, ↩ Show in transcript
 * and › below, all 44 px. The view stays live: sending from it and a
 * waiting view work here as in the transcript.
 *
 * A swipe moves between items on the chrome around the frame only — a
 * touch inside the frame is the page's, and never reaches this document.
 */
export function ViewPage({
  sessionId,
  item,
  index,
  count,
  onBack,
  onPage,
  onShowInChat,
}: {
  sessionId: string
  item: MediaItem & { view: NonNullable<MediaItem['view']> }
  index: number
  count: number
  onBack: () => void
  onPage: (delta: number) => void
  onShowInChat: () => void
}) {
  const stage = useRef<HTMLDivElement>(null)
  useSwipe(stage, onPage, onBack)
  return (
    <main ref={stage} className="relative flex h-full min-h-0 flex-col overflow-hidden bg-space text-ink-100">
      {/* 69e: 52 px, × and ⋯'s place 44 px each, the title and the counter between. No ⋯: 69e names nothing in it. */}
      <div className="flex h-13 shrink-0 items-center gap-1 px-1.5">
        <button
          type="button"
          aria-label="Close"
          onClick={onBack}
          className="grid h-11 w-11 shrink-0 place-items-center fs-22 leading-none text-ink-100"
        >
          ×
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate fs-15 font-bold">{item.view.title}</div>
          <div className="font-mono fs-10 text-ink-900/60">
            {count > 1 ? `VIEW · ${index + 1} of ${count}` : 'VIEW'}
          </div>
        </div>
        <span aria-hidden className="block h-11 w-11 shrink-0" />
      </div>
      {/* 69e: 8px 10px around the frame, which sits in the middle of what is left. */}
      <div className="flex min-h-0 flex-1 flex-col justify-center overflow-y-auto px-2.5 py-2">
        <ViewFrame key={item.view.toolUseId} sessionId={sessionId} toolUseId={item.view.toolUseId} surface="phone" />
      </div>
      <div className="flex shrink-0 items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          aria-label="Previous"
          disabled={index <= 0}
          onClick={() => onPage(-1)}
          className="grid h-11 w-11 place-items-center rounded-[12px] border border-line/16 fs-20 disabled:opacity-40"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={onShowInChat}
          className="grid h-11 flex-1 place-items-center rounded-[12px] border border-line/16 font-mono fs-11.5"
        >
          ↩ Show in transcript
        </button>
        <button
          type="button"
          aria-label="Next"
          disabled={index >= count - 1}
          onClick={() => onPage(1)}
          className="grid h-11 w-11 place-items-center rounded-[12px] border border-line/16 fs-20 disabled:opacity-40"
        >
          ›
        </button>
      </div>
    </main>
  )
}
