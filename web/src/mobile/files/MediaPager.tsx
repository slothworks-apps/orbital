import { useCallback, useRef, useState } from 'react'
import type { MessageImage } from '../../lib/fileOpen'
import { mediaSourceKey, pagingOrder, positionIn } from '../../lib/media'
import type { MediaItem } from '../../lib/types'
import { GoneMark, isGone } from '../../panels/MediaParts'
import { useHiddenSources, useMedia } from '../../store/media'
import { basename } from '../format'
import { useMobile } from '../state'
import { ImagePage } from './ImageViewer'
import { MediaFoot, useSwipe } from './MediaFoot'
import { stepMedia } from './mediaPaging'
import { PdfPage } from './PdfViewer'

/**
 * The phone's viewer paging through a session's media (canvas `Feature -
 * Media` 24g; spec 2026-10-09-session-media-design § Phone, Viewer): 10d's
 * image viewer and the PDF viewer, one item at a time, swipe ↔ moving
 * through the items the Sources filter leaves standing, oldest first. Opened
 * on an item the filter hides, it pages through everything: that item was
 * asked for by name.
 *
 * ↩ Show in chat goes back to the session screen, which scrolls to the
 * message (`TranscriptView`'s `jumpTo`, through the media store's `jump`).
 */
export function MediaPager({
  sessionId, items, startId, onBack,
}: {
  sessionId: string
  items: readonly MediaItem[]
  startId: string
  onBack: () => void
}) {
  const [currentId, setCurrentId] = useState(startId)
  const [hidden] = useHiddenSources(sessionId)
  const startHidden = items.some((m) => {
    const key = m.id === startId ? mediaSourceKey(m) : null
    return key !== null && hidden.includes(key)
  })
  const order = pagingOrder(items, startHidden ? [] : hidden)
  const at = positionIn(order, items, currentId)
  const item = at >= 0 ? order[at] : undefined

  // Read through a ref so the swipe listeners are not re-attached on every step.
  const latest = useRef({ order, items, currentId })
  latest.current = { order, items, currentId }
  const onPage = useCallback((delta: number) => {
    const { order: o, items: all, currentId: id } = latest.current
    const next = stepMedia(o, all, id, delta)
    if (next) setCurrentId(next)
  }, [])

  if (!item) return null
  const showInChat = () => {
    useMedia.getState().showInTranscript(sessionId, item.messageId)
    useMobile.getState().openSession(sessionId)
  }
  const media = { item, onShowInChat: showInChat }

  if (isGone(item)) {
    return <GonePage key={item.id} item={item} index={at} count={order.length} onBack={onBack} onPage={onPage} onShowInChat={showInChat} />
  }
  if (item.kind === 'pdf' && item.path) {
    return (
      <PdfPage
        key={item.id}
        sessionId={sessionId}
        path={item.path}
        cwd={item.cwd}
        index={at}
        count={order.length}
        onBack={onBack}
        onPage={onPage}
        foot={({ page, cached }) => (
          <MediaFoot item={item} chip={page} hint="scroll · swipe ↔" above={cached} onShowInChat={showInChat} />
        )}
      />
    )
  }
  return (
    <ImagePage
      key={item.id}
      sessionId={sessionId}
      cwd={item.cwd}
      item={asMessageImage(item)}
      index={at}
      count={order.length}
      caption=""
      onBack={onBack}
      onPage={onPage}
      media={media}
    />
  )
}

/** A media item in the shape the image viewer pages through. */
function asMessageImage(item: MediaItem): MessageImage {
  if (item.ref) return { kind: 'ref', ref: item.ref, image: { ref: item.ref, w: item.w ?? null, h: item.h ?? null, bytes: 0 } }
  return { kind: 'path', path: item.path ?? '' }
}

/** 24f C on the phone: a named file no longer on disk keeps its place in the paging, as its footprint. */
function GonePage({
  item, index, count, onBack, onPage, onShowInChat,
}: {
  item: MediaItem
  index: number
  count: number
  onBack: () => void
  onPage: (delta: number) => void
  onShowInChat: () => void
}) {
  const stage = useRef<HTMLDivElement>(null)
  useSwipe(stage, onPage, onBack)
  const sub = ['not on disk', count > 1 ? `${index + 1} of ${count}` : null].filter(Boolean).join(' · ')
  return (
    <main className="relative flex h-full min-h-0 flex-col overflow-hidden bg-black text-ink-100">
      <div ref={stage} className="absolute inset-0 flex items-center justify-center px-6">
        <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-[12px] border border-line/10 bg-shade/60">
          <GoneMark size="dialog" />
        </div>
      </div>
      <div className="relative z-[2] flex h-14 shrink-0 items-center gap-1 bg-[linear-gradient(180deg,rgba(0,0,0,.7),transparent)] pl-1.5 pr-2.5">
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="grid h-11 w-11 shrink-0 place-items-center fs-28 leading-none text-ink-100"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate fs-15 font-semibold">{item.path ? basename(item.path) : 'Image'}</div>
          <div className="mt-0.5 truncate font-mono fs-10.5 text-ink-600/70">{sub}</div>
        </div>
      </div>
      <div className="flex-1" />
      <MediaFoot item={item} onShowInChat={onShowInChat} />
    </main>
  )
}
