import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MessageImage } from '../../lib/fileOpen'
import { formatBytes } from '../../lib/format'
import { asOfLabel, basename } from '../format'
import { useMobile } from '../state'
import { CantShow } from './CantShow'
import { ByteBar, CachedChip, GoneBlock, ReservedBox, StateButton, StateText } from './FileStates'
import { useFile, type FileSource } from './useFile'
import {
  DOUBLE_TAP_MS, FIT, clampPan, fitSize, releaseGesture, toggleZoom, zoomAt, zoomLabel,
  type Point, type Size, type View,
} from './zoom'

/** A finger that moves less than this between down and up is a tap. */
const TAP_SLOP_PX = 10

/**
 * Canvas 10d, second phone — the one full-screen viewer for every image a
 * transcript shows or names (spec 2026-10-05-mobile-next § 2): black, the
 * chrome over the image, pinch to `MAX_ZOOM`, double-tap `DOUBLE_TAP_ZOOM` ↔
 * fit, swipe sideways through the message's images, ‹ or swipe down to go
 * back. The image area's other states are 10e's.
 */
export function ImageViewer({
  sessionId, items, start, caption, onBack,
}: {
  sessionId: string
  /** The images of the message the press came from, in order; never empty. */
  items: MessageImage[]
  start: number
  /** The foot's "session hh:mm". */
  caption: string
  onBack: () => void
}) {
  const [index, setIndex] = useState(start)
  const onPage = useCallback(
    (delta: number) => setIndex((i) => Math.min(items.length - 1, Math.max(0, i + delta))),
    [items.length],
  )
  const item = items[Math.min(index, items.length - 1)]
  return (
    <ImagePage
      key={item.kind === 'ref' ? `ref:${item.ref}` : `path:${item.path}`}
      sessionId={sessionId}
      item={item}
      index={index}
      count={items.length}
      caption={caption}
      onBack={onBack}
      onPage={onPage}
    />
  )
}

function sourceOf(sessionId: string, item: MessageImage): FileSource {
  return item.kind === 'ref'
    ? { kind: 'ref', ref: item.ref, w: item.image.w, h: item.image.h }
    : { kind: 'path', sessionId, path: item.path, as: 'image' }
}

function distance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function ImagePage({
  sessionId, item, index, count, caption, onBack, onPage,
}: {
  sessionId: string
  item: MessageImage
  index: number
  count: number
  caption: string
  onBack: () => void
  onPage: (delta: number) => void
}) {
  const source = useMemo(() => sourceOf(sessionId, item), [sessionId, item])
  const { view, retry, known } = useFile(source)
  const mac = useMobile((s) => s.macName) ?? 'the Mac'
  const path = item.kind === 'path' ? item.path : null
  const name = path ? basename(path) : 'Image'

  const outcome = view.phase === 'done' ? view.outcome : null
  const shown = outcome?.kind === 'ready' ? outcome : outcome?.kind === 'gone' ? outcome.copy : null
  const url = useMemo(
    () => (shown ? URL.createObjectURL(new Blob([new Uint8Array(shown.bytes)], { type: shown.mediaType ?? '' })) : null),
    [shown],
  )
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url)
  }, [url])

  const [natural, setNatural] = useState<Size | null>(null)
  const [loaded, setLoaded] = useState(false)
  // Held by value: the touch listeners below are attached once per image,
  // and a new object every render would re-attach them mid-pinch.
  const iw = known?.w ?? natural?.w ?? null
  const ih = known?.h ?? natural?.h ?? null
  const imageSize = useMemo<Size | null>(() => (iw && ih ? { w: iw, h: ih } : null), [iw, ih])
  const size =
    shown?.bytes.length ?? (view.phase === 'loading' ? view.total : null) ?? (item.kind === 'ref' && item.image.bytes > 0 ? item.image.bytes : null)

  const [zoom, setZoom] = useState<View>(FIT)
  const [animate, setAnimate] = useState(false)
  const zoomRef = useRef(zoom)
  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])
  const stageRef = useRef<HTMLDivElement>(null)

  const stageGeometry = useCallback(() => {
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect || !imageSize) return null
    const stage = { w: rect.width, h: rect.height }
    const at = (x: number, y: number): Point => ({ x: x - rect.left - rect.width / 2, y: y - rect.top - rect.height / 2 })
    return { stage, fitted: fitSize(imageSize, stage), at }
  }, [imageSize])

  const toggleAt = useCallback(
    (clientX: number | null, clientY: number | null) => {
      const g = stageGeometry()
      if (!g) return
      const point = clientX === null || clientY === null ? { x: 0, y: 0 } : g.at(clientX, clientY)
      setAnimate(true)
      setZoom((v) => toggleZoom(v, point, g.fitted, g.stage))
    },
    [stageGeometry],
  )

  // React's touch handlers are passive (web CLAUDE.md), and a pinch has to
  // stop the WebView's own scrolling, so the listeners go on by hand.
  const showing = url !== null
  useEffect(() => {
    const el = stageRef.current
    if (!el || !showing) return
    type Gesture =
      | { kind: 'pan'; x0: number; y0: number; view: View; moved: boolean }
      | { kind: 'pinch'; d0: number; mid0: Point; view: View }
    let gesture: Gesture | null = null
    let lastTap = 0
    const onStart = (e: TouchEvent) => {
      e.preventDefault()
      const g = stageGeometry()
      if (!g) return
      setAnimate(false)
      if (e.touches.length >= 2) {
        const [a, b] = [e.touches[0], e.touches[1]]
        gesture = {
          kind: 'pinch', d0: distance(a, b), view: zoomRef.current,
          mid0: g.at((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2),
        }
      } else {
        const t = e.touches[0]
        gesture = { kind: 'pan', x0: t.clientX, y0: t.clientY, view: zoomRef.current, moved: false }
      }
    }
    const onMove = (e: TouchEvent) => {
      e.preventDefault()
      const g = stageGeometry()
      if (!g || !gesture) return
      if (gesture.kind === 'pinch' && e.touches.length >= 2) {
        const [a, b] = [e.touches[0], e.touches[1]]
        const mid = g.at((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)
        const scaled = zoomAt(gesture.view, (gesture.view.scale * distance(a, b)) / gesture.d0, gesture.mid0, g.fitted, g.stage)
        setZoom(clampPan({ ...scaled, x: scaled.x + mid.x - gesture.mid0.x, y: scaled.y + mid.y - gesture.mid0.y }, g.fitted, g.stage))
      } else if (gesture.kind === 'pan') {
        const t = e.touches[0]
        const dx = t.clientX - gesture.x0
        const dy = t.clientY - gesture.y0
        if (Math.hypot(dx, dy) > TAP_SLOP_PX) gesture.moved = true
        if (gesture.view.scale > 1) setZoom(clampPan({ ...gesture.view, x: gesture.view.x + dx, y: gesture.view.y + dy }, g.fitted, g.stage))
      }
    }
    const onEnd = (e: TouchEvent) => {
      e.preventDefault()
      const ended = gesture
      if (!ended) return
      if (ended.kind === 'pinch') {
        // The last finger up ends the pinch; one still down starts nothing new.
        if (e.touches.length === 0) gesture = null
        return
      }
      gesture = null
      const t = e.changedTouches[0]
      if (!ended.moved) {
        const now = Date.now()
        if (now - lastTap < DOUBLE_TAP_MS) {
          lastTap = 0
          toggleAt(t.clientX, t.clientY)
        } else {
          lastTap = now
        }
        return
      }
      const action = releaseGesture(ended.view.scale, t.clientX - ended.x0, t.clientY - ended.y0)
      if (action === 'back') onBack()
      else if (action) onPage(action === 'next' ? 1 : -1)
    }
    el.addEventListener('touchstart', onStart, { passive: false })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd, { passive: false })
    el.addEventListener('touchcancel', onEnd, { passive: false })
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [showing, stageGeometry, toggleAt, onBack, onPage])

  const dims = imageSize ? `${imageSize.w}×${imageSize.h}` : null
  const sub = [dims, size !== null ? formatBytes(size) : null, count > 1 ? `${index + 1} of ${count}` : null]
    .filter(Boolean)
    .join(' · ')
  const now = Date.now()

  let area
  if (url) {
    area = (
      // Canvas 10d: the image fills the stage behind the chrome; a double-tap's
      // zoom eases over `.3s ease`, a pinch follows the fingers with none.
      <img
        src={url}
        alt=""
        draggable={false}
        onLoad={(e) => {
          setLoaded(true)
          if (!known) setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
        }}
        className="absolute inset-0 h-full w-full object-contain"
        style={{
          transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
          // 10e LOADING: "bytes in → fade .4 s"; the phone's own copy just shows.
          opacity: loaded || shown?.cached ? 1 : 0,
          transition: [animate ? 'transform .3s ease' : null, shown?.cached ? null : 'opacity .4s'].filter(Boolean).join(', ') || 'none',
        }}
      />
    )
  } else if (view.phase === 'loading') {
    area = (
      <div className="absolute inset-0 flex flex-col justify-center gap-3">
        {imageSize && <ReservedBox w={imageSize.w} h={imageSize.h} tone="loading" label={[dims, size !== null ? formatBytes(size) : null].filter(Boolean).join(' · ')} />}
        <ByteBar received={view.received} total={view.total} mac={mac} />
      </div>
    )
  } else if (outcome?.kind === 'failed') {
    area = (
      <div className="absolute inset-0 flex flex-col justify-center gap-3.5">
        {imageSize && <ReservedBox w={imageSize.w} h={imageSize.h} tone="quiet" label={dims ?? ''} />}
        <StateText title="Couldn't load" action={<StateButton onClick={retry}>Retry</StateButton>}>
          {outcome.received > 0 ? `The connection dropped at ${formatBytes(outcome.received)}.` : 'The connection dropped.'}
        </StateText>
      </div>
    )
  } else if (outcome?.kind === 'gone') {
    area = (
      <div className="absolute inset-0 flex flex-col justify-center">
        <GoneBlock path={path} mac={mac} />
      </div>
    )
  } else if (outcome?.kind === 'waits') {
    area = (
      // 10e MAC ASLEEP · NOT CACHED: nothing moves.
      <div className="absolute inset-0 flex flex-col justify-center gap-3.5">
        {imageSize && <ReservedBox w={imageSize.w} h={imageSize.h} tone="quiet" label={dims ?? ''} />}
        <StateText title={`Opens when ${mac} wakes`}>Not on this phone yet. Stay here and it loads on its own.</StateText>
      </div>
    )
  } else if (outcome?.kind === 'cant-show' || outcome?.kind === 'outside') {
    area = (
      <div className="absolute inset-0 flex flex-col justify-center bg-[#05070d]">
        <CantShow path={path} size={outcome.kind === 'cant-show' ? outcome.size : null} outside={outcome.kind === 'outside'} />
      </div>
    )
  }

  return (
    <main className="relative flex h-full min-h-0 flex-col overflow-hidden bg-black text-[#e8eef8]">
      <div
        ref={stageRef}
        onDoubleClick={(e) => toggleAt(e.clientX, e.clientY)}
        className="absolute inset-0 touch-none overflow-hidden"
      >
        {area}
      </div>
      {/* Canvas 10d: the header over the image, 56px on a fade from black. */}
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
          <div className="truncate text-[15px] font-semibold">{name}</div>
          {sub && <div className="mt-0.5 truncate font-mono text-[10.5px] text-[rgba(200,215,235,.7)]">{sub}</div>}
        </div>
        {url && (
          <button
            type="button"
            onClick={() => toggleAt(null, null)}
            className="h-11 min-w-14 rounded-[12px] border border-[rgba(150,205,255,.2)] bg-[rgba(5,7,13,.6)] px-2.5 font-mono text-[11px] text-[#e8eef8]"
          >
            {zoomLabel(zoom.scale)}
          </button>
        )}
      </div>
      <div className="flex-1" />
      {/* Canvas 10d: the foot — the pages, then the path and the session with its time. */}
      <div className="relative z-[2] flex shrink-0 flex-col gap-2.5 bg-[linear-gradient(0deg,rgba(0,0,0,.8),transparent)] px-4 pb-1.5 pt-4">
        {shown?.cached && (
          <div>
            <CachedChip asOf={asOfLabel(shown.readAt, now)} />
          </div>
        )}
        {count > 1 && (
          <div className="flex justify-center gap-1.5">
            {Array.from({ length: count }, (_, i) => (
              <span
                key={i}
                className={['block h-1.5 w-1.5 rounded-full', i === index ? 'bg-[#e8eef8]' : 'bg-[rgba(232,238,248,.35)]'].join(' ')}
              />
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 font-mono text-[11px] text-[rgba(200,215,235,.75)]">
          <span className="min-w-0 flex-1 truncate">
            {path ?? 'image'} · {caption}
          </span>
          {url && <span>pinch · double-tap</span>}
        </div>
      </div>
    </main>
  )
}
