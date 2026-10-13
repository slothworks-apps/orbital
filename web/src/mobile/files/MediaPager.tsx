import { useCallback, useRef, useState } from 'react'
import type { MessageImage } from '../../lib/fileOpen'
import { isToolMedia, pagingOrder, positionIn } from '../../lib/media'
import type { MediaItem } from '../../lib/types'
import { GoneMark, isGone } from '../../panels/MediaParts'
import { useHideTool, useMedia } from '../../store/media'
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
 * through the items Hide tool images leaves standing, oldest first. Opened
 * on a tool image the switch hides, it pages through everything: that image
 * was asked for by name.
 *
 * ↩ Show in chat goes back to the session screen, which scrolls to the
 * message (`TranscriptView`'s `jumpTo`, through the media store's `jump`).
 */
export function MediaPager({
  sessionId, items, startId, onBack, pool,
}: {
  sessionId: string
  items: readonly MediaItem[]
  startId: string
  onBack: () => void
  /** Pages through the gallery of every session instead: each item in its own session, the action opens it. */
  pool?: PhoneMediaPool
}) {
  const [currentId, setCurrentId] = useState(startId)
  const [ownHideTool] = useHideTool(sessionId)
  const hideTool = pool ? pool.hideTool : ownHideTool
  const startHidden = items.some((m) => m.id === startId && isToolMedia(m))
  const order = pagingOrder(items, hideTool && !startHidden)
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
    if (pool) return pool.onOpenSession(item)
    useMedia.getState().showInTranscript(sessionId, item.messageId)
    useMobile.getState().openSession(sessionId)
  }
  const actionLabel = pool ? '↗ Open session' : undefined
  const where = pool?.titleOf(item)
  const media = { item, onShowInChat: showInChat, actionLabel, where }
  const itemSession = pool ? pool.sessionOf(item) : sessionId

  if (isGone(item)) {
    return (
      <GonePage
        key={item.id} item={item} index={at} count={order.length} onBack={onBack} onPage={onPage} onShowInChat={showInChat}
        actionLabel={actionLabel} where={where}
      />
    )
  }
  if (item.kind === 'pdf' && item.path) {
    return (
      <PdfPage
        key={item.id}
        sessionId={itemSession}
        path={item.path}
        cwd={item.cwd}
        index={at}
        count={order.length}
        onBack={onBack}
        onPage={onPage}
        foot={({ page, cached }) => (
          <MediaFoot
            item={item} chip={page} hint="scroll · swipe ↔" above={cached} onShowInChat={showInChat}
            actionLabel={actionLabel} where={where}
          />
        )}
      />
    )
  }
  return (
    <ImagePage
      key={item.id}
      sessionId={itemSession}
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

/** The gallery of every session, as the pager reads it (spec 2026-10-13-all-sessions-gallery-design § Phone). */
export interface PhoneMediaPool {
  sessionOf(item: MediaItem): string
  titleOf(item: MediaItem): string
  hideTool: boolean
  onOpenSession(item: MediaItem): void
}

/** A media item in the shape the image viewer pages through. */
function asMessageImage(item: MediaItem): MessageImage {
  if (item.ref) return { kind: 'ref', ref: item.ref, image: { ref: item.ref, w: item.w ?? null, h: item.h ?? null, bytes: 0 } }
  return { kind: 'path', path: item.path ?? '' }
}

/** 24f C on the phone: a named file no longer on disk keeps its place in the paging, as its footprint. */
function GonePage({
  item, index, count, onBack, onPage, onShowInChat, actionLabel, where,
}: {
  item: MediaItem
  index: number
  count: number
  onBack: () => void
  onPage: (delta: number) => void
  onShowInChat: () => void
  actionLabel?: string
  where?: string
}) {
  const stage = useRef<HTMLDivElement>(null)
  useSwipe(stage, onPage, onBack)
  const sub = ['not on disk', count > 1 ? `${index + 1} of ${count}` : null].filter(Boolean).join(' · ')
  return (
    <main className="relative flex h-full min-h-0 flex-col overflow-hidden bg-black text-[#e8eef8]">
      <div ref={stage} className="absolute inset-0 flex items-center justify-center px-6">
        <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-[12px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.6)]">
          <GoneMark size="dialog" />
        </div>
      </div>
      <div className="relative z-[2] flex h-14 shrink-0 items-center gap-1 bg-[linear-gradient(180deg,rgba(0,0,0,.7),transparent)] pl-1.5 pr-2.5">
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="grid h-11 w-11 shrink-0 place-items-center text-[28px] leading-none text-[#e8eef8]"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{item.path ? basename(item.path) : 'Image'}</div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-[rgba(200,215,235,.7)]">{sub}</div>
        </div>
      </div>
      <div className="flex-1" />
      <MediaFoot item={item} onShowInChat={onShowInChat} actionLabel={actionLabel} where={where} />
    </main>
  )
}
