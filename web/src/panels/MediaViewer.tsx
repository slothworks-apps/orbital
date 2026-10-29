import { useEffect, useMemo, useRef, useState } from 'react'
import type { Ref } from 'react'
import { createPortal } from 'react-dom'
import type { MediaItem } from '../lib/types'
import type { MediaTarget } from '../lib/media'
import { isToolFrame, matchMediaItem, mediaClock, mediaSourceKey, mediaSourceLabel, positionIn, stepIndex } from '../lib/media'
import { api } from '../lib/api'
import { copyImageToClipboard, copyToClipboard } from '../lib/clipboard'
import { canShowInFolder, showInFolder } from '../lib/desktop'
import { reportError } from '../lib/errors'
import { useMediaSourceUrl } from '../lib/images'
import { isPdfPath } from '../lib/pathLinks'
import { useHiddenSources, useMedia } from '../store/media'
import { useOrbital } from '../store/store'
import { EscapeBoundary, useEscapeLayer } from '../ui/escapeLayer'
import { ContextMenu } from '../ui/ContextMenu'
import type { MenuItem } from '../ui/Menu'
import { usePresence } from '../ui/usePresence'
import { CopyGlyph, FolderGlyph, ImageGlyph } from '../ui/UtilityButton'
import { GoneMark, MediaPicture, SourcesButton, isGone, pdfKey } from './MediaParts'
import { PdfPager, usePdfDocument } from './PdfPages'

/**
 * The maximised view (canvas `Feature - Media` 24e): the 7c lightbox grown
 * into a pager across a session's media. ‹ › and ← → step through what the
 * Sources filter leaves shown (26b B), oldest first, wrapping; a filmstrip below, the
 * source and time under the item, and Show in transcript. A PDF shows every
 * page: ↑ ↓ or the wheel over the page moves through pages, ← → to the next
 * item.
 *
 * Every opener mounts its own — a transcript thumbnail, a path, a tile — the
 * way each mounted its own lightbox before, so the view needs no host. It
 * opens on the listed item the press stands for. Until the list has
 * arrived, or for something the list does not hold (a subagent's image),
 * it shows that one item on its own, with nothing to page.
 *
 * The phone does not mount this: its presses go to its own viewer through
 * `lib/fileOpen`, which pages through the same list from `store/media`.
 */

/** 7d: the backdrop fades and the item settles from 98% (the 7c lightbox's timings). */
const VIEWER_ENTER_MS = 180
const VIEWER_EXIT_MS = 140

/** 24i: the dialog's image cap — never upscaled past the item's own size. */
const STAGE_MAX_W_PX = 1100
const STAGE_MAX_H_PX = 600
/** 24e: the stage starts 40px from the top; caption, filmstrip and margins take the rest. */
const STAGE_TOP_PX = 40
const STAGE_CHROME_H_PX = 300
/** What the arrows and their margins take from either side of the stage. */
const STAGE_SIDE_PX = 100
/** 24e: a gone item without known dimensions keeps the canvas's footprint. */
const GONE_BOX = { w: 1440, h: 900 }

export type ViewerTarget = MediaTarget | { kind: 'item'; id: string }

export interface MediaViewerProps {
  open: boolean
  /** Whose list it pages through. Null — nothing selected — shows the pressed item alone. */
  sessionId: string | null
  /** What was pressed. */
  target: ViewerTarget | null
  /** The caption when the list holds no item for the press — what the 7c lightbox said: source · size. */
  fallbackCaption?: string
  onClose: () => void
}

function useViewportHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight)
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return height
}

function targetItemId(items: readonly MediaItem[] | undefined, target: ViewerTarget | null): string | null {
  if (!items || !target) return null
  if (target.kind === 'item') return items.some((item) => item.id === target.id) ? target.id : null
  return matchMediaItem(items, target)?.id ?? null
}

/** What the box draws when the list holds no item for the press. */
function standIn(target: ViewerTarget | null): MediaItem | null {
  if (!target || target.kind === 'item') return null
  const common = { id: '', source: 'agent' as const, messageId: target.messageId ?? '', ts: '' }
  return target.kind === 'ref'
    ? { ...common, kind: 'image', source: 'you', ref: target.ref }
    : { ...common, kind: isPdfPath(target.path) ? 'pdf' : 'image', path: target.path, cwd: target.cwd }
}

export function MediaViewer({ open, sessionId, target, fallbackCaption, onClose }: MediaViewerProps) {
  useEscapeLayer(open, onClose)
  const { mounted, state } = usePresence(open, VIEWER_ENTER_MS, VIEWER_EXIT_MS)
  if (!mounted) return null
  return createPortal(
    <EscapeBoundary>
      <ViewerBody
        sessionId={sessionId}
        target={target}
        fallbackCaption={fallbackCaption}
        entered={state === 'entered'} exiting={state === 'exiting'} onClose={onClose} />
    </EscapeBoundary>,
    document.body,
  )
}

function ViewerBody({
  sessionId,
  target,
  fallbackCaption,
  entered,
  exiting,
  onClose,
}: {
  sessionId: string | null
  target: ViewerTarget | null
  fallbackCaption?: string
  entered: boolean
  exiting: boolean
  onClose: () => void
}) {
  const items = useMedia((s) => (sessionId ? s.lists[sessionId] : undefined))
  const [hidden, setHidden] = useHiddenSources(sessionId ?? '')
  const title = useOrbital((s) => (sessionId ? s.sessions[sessionId]?.title : undefined))
  const viewportHeight = useViewportHeight()
  const stageHeight = Math.max(160, Math.min(STAGE_MAX_H_PX, viewportHeight - STAGE_CHROME_H_PX))

  // Ask once on opening: the list may be older than the press.
  useEffect(() => {
    if (sessionId) void useMedia.getState().load(sessionId)
  }, [sessionId])

  // Where the reader is. Until they page, the item the press stands for —
  // which may only turn up once the list arrives. That item stays reachable
  // even while the filter hides its source, until the reader moves off it.
  const [selected, setSelected] = useState<string | null>(null)
  const [pinned, setPinned] = useState(true)
  const [page, setPage] = useState(1)
  const currentId = selected ?? targetItemId(items, target)
  const all = useMemo(() => items ?? [], [items])
  const order = useMemo(
    () =>
      all.filter((item) => {
        const key = mediaSourceKey(item)
        return key === null || !hidden.includes(key) || (pinned && item.id === currentId)
      }),
    [all, hidden, pinned, currentId],
  )
  const index = currentId ? positionIn(order, all, currentId) : -1
  const current = index >= 0 ? order[index] : null
  const shown = current ?? standIn(target)
  const paging = current !== null && order.length > 1

  const go = (item: MediaItem) => {
    setSelected(item.id)
    setPinned(false)
    setPage(1)
  }
  const step = (delta: number) => {
    if (!paging) return
    go(order[stepIndex(order.length, index, delta)])
  }

  // A press that closes the image's menu only closes the menu; the click it
  // ends in must not go on to close the viewer. Read on `window` in the
  // capture phase, before the menu's own outside-press listener closes it.
  const menuOpen = useRef(false)
  const pressedWithMenu = useRef(false)
  useEffect(() => {
    const onPointerDown = () => {
      pressedWithMenu.current = menuOpen.current
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  const latest = useRef({ step, shown, page })
  latest.current = { step, shown, page }
  const [pages, setPages] = useState<number | null>(null)
  useEffect(() => {
    if (exiting) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const { step, shown, page } = latest.current
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault()
        step(event.key === 'ArrowRight' ? 1 : -1)
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && shown?.kind === 'pdf' && pages) {
        event.preventDefault()
        setPage(Math.max(1, Math.min(pages, page + (event.key === 'ArrowDown' ? 1 : -1))))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [exiting, pages])

  const changeHidden = (next: typeof hidden) => {
    setPinned(false)
    if (current) setSelected(current.id)
    setHidden(next)
  }

  const showInTranscript = () => {
    if (!sessionId || !current) return
    useMedia.getState().showInTranscript(sessionId, current.messageId)
    onClose()
  }

  const clock = shown?.ts ? mediaClock(shown.ts) : ''
  const where = [title, clock].filter(Boolean).join(', ')

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={shown?.kind === 'pdf' ? 'PDF preview' : 'Image preview'}
      data-state={entered ? 'entered' : exiting ? 'exiting' : 'entering'}
      inert={exiting || undefined}
      onClick={() => {
        if (!pressedWithMenu.current) onClose()
      }}
      style={{ transition: `opacity ${VIEWER_EXIT_MS}ms ease`, opacity: entered ? 1 : 0 }}
      className="orbital-no-drag fixed inset-0 z-50 bg-space/82 backdrop-blur-[6px]"
    >
      <div
        className="absolute inset-x-0 flex items-center justify-center gap-4"
        style={{
          top: STAGE_TOP_PX,
          height: stageHeight,
          transition: `transform ${VIEWER_ENTER_MS}ms cubic-bezier(.2,.9,.25,1)`,
          transform: entered ? 'scale(1)' : 'scale(.98)',
        }}
      >
        {shown && (sessionId !== null || shown.ref !== undefined) && (
          // With nothing selected a ref still has its bytes; a path has no tree to be read in.
          <Stage
            key={shown.id || `${shown.ref ?? ''}${shown.path ?? ''}`}
            sessionId={sessionId ?? ''}
            item={shown}
            stageHeight={stageHeight}
            page={page}
            onPage={setPage}
            onPages={setPages}
            menuOpen={menuOpen}
          />
        )}
      </div>

      {shown && (
        <div
          onClick={(event) => event.stopPropagation()}
          className="absolute inset-x-0 flex flex-col items-center gap-2 font-mono tracking-[0.06em]"
          style={{ top: STAGE_TOP_PX + stageHeight + 18 }}
        >
          <div className="flex items-center gap-2.5 fs-11.5 text-ink-100">
            {isToolFrame(shown) && current && (
              <span className="rounded-[3px] border border-line/20 px-1.5 py-px fs-10 text-ink-500/85">
                ⚙ TOOL
              </span>
            )}
            {current ? mediaSourceLabel(current) : (fallbackCaption ?? null)}
            {current && shown.path && <span className="text-line/28">·</span>}
            {shown.path && <span className="text-ink-200">{shown.path}</span>}
          </div>
          <div className="flex items-center gap-3 fs-10.5 text-ink-900/60">
            {current && <Meta item={shown} pages={pages} where={where} />}
            {current && (
              <>
                <span className="text-line/28">·</span>
                <button
                  type="button"
                  onClick={showInTranscript}
                  className="rounded-[5px] border border-line/20 bg-transparent px-[9px] py-[3px] font-mono fs-10.5 text-ink-100 transition-[border-color] duration-[160ms] ease-[ease] hover:border-line/45"
                >
                  ↩ Show in transcript
                </button>
                <span className="text-line/28">·</span>
              </>
            )}
            <span>
              <span className="mr-1.5 rounded border border-line/20 px-[7px] py-[3px] text-ink-500/70">
                esc
              </span>
              to close
            </span>
          </div>
        </div>
      )}

      {current && (
        <div
          onClick={(event) => event.stopPropagation()}
          className="absolute inset-x-0 bottom-[30px] flex items-center justify-center gap-4"
        >
          <span className="w-[150px] text-right font-mono fs-10.5 text-ink-900/60">
            {index + 1} of {order.length}
          </span>
          <Filmstrip sessionId={sessionId!} order={order} current={current} onPick={go} />
          <span className="w-[150px]">
            {all.length > 0 && <SourcesButton items={all} hidden={hidden} onChange={changeHidden} prefer="above" />}
          </span>
        </div>
      )}

      {paging && (
        <>
          <ArrowButton label="Previous" side="left" top={STAGE_TOP_PX + stageHeight / 2 - 22} onPress={() => step(-1)}>
            ‹
          </ArrowButton>
          <ArrowButton label="Next" side="right" top={STAGE_TOP_PX + stageHeight / 2 - 22} onPress={() => step(1)}>
            ›
          </ArrowButton>
        </>
      )}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-7 top-7 grid h-[34px] w-[34px] place-items-center rounded-[9px] border border-line/20 bg-panel/70 fs-16 leading-(--text-base--line-height) text-ink-100 transition-colors hover:border-line/45"
      >
        ×
      </button>
      {shown?.kind === 'pdf' && pages && (
        <div className="absolute right-7 top-[76px] text-right font-mono fs-10.5 leading-[1.7] text-ink-900/60">
          page {page} of {pages}
          <br />↑ ↓ or scroll for pages
        </div>
      )}
    </div>
  )
}

/** 24e's caption meta: dimensions or pages, then the session and the time — or what became of the file. */
function Meta({ item, pages, where }: { item: MediaItem; pages: number | null; where: string }) {
  const named = item.ts ? mediaClock(item.ts) : ''
  const parts: string[] = []
  if (isGone(item)) {
    // Spec § Where this departs from the canvas: Orbital never saw it go, so it says only that it is gone now.
    parts.push(named ? `named ${named} · not on disk now` : 'not on disk now')
  } else {
    if (item.kind === 'pdf') parts.push(pages ? `PDF · ${pages} page${pages === 1 ? '' : 's'}` : 'PDF')
    else if (item.w && item.h) parts.push(`${item.w}×${item.h}`)
    if (where) parts.push(where)
    if (item.disk === 'changed' && named) parts.push(`changed since ${named}`)
  }
  return <span>{parts.join(' · ')}</span>
}

/** 24e: the arrows wear 7c's chrome, at 44px. */
function ArrowButton({
  label,
  side,
  top,
  onPress,
  children,
}: {
  label: string
  side: 'left' | 'right'
  top: number
  onPress: () => void
  children: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onPress()
      }}
      style={{ top }}
      className={[
        'absolute grid h-11 w-11 place-items-center rounded-[10px] border border-line/20 bg-panel/70 fs-20 text-ink-100',
        'transition-[border-color] duration-[160ms] ease-[ease] hover:border-line/45',
        side === 'left' ? 'left-7' : 'right-7',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/**
 * The item itself: an image at its own size within the cap, a PDF's pages,
 * or a gone file's footprint. A file that fails to load mid-view is drawn
 * as gone too — the list's `disk` is only as fresh as its last answer.
 */
function Stage({
  sessionId,
  item,
  stageHeight,
  page,
  onPage,
  onPages,
  menuOpen,
}: {
  sessionId: string
  item: MediaItem
  stageHeight: number
  page: number
  onPage: (page: number) => void
  onPages: (pages: number | null) => void
  menuOpen: { current: boolean }
}) {
  const [failed, setFailed] = useState(false)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const hasMenu = menuAt !== null
  useEffect(() => {
    menuOpen.current = hasMenu
    return () => {
      menuOpen.current = false
    }
  }, [hasMenu, menuOpen])
  const { url } = useMediaSourceUrl(sessionId, item)
  const pdf = usePdfDocument(item.kind === 'pdf' && !isGone(item) ? url : null, url ? pdfKey(url, item) : '')
  const maxWidth = Math.min(STAGE_MAX_W_PX, window.innerWidth - 2 * STAGE_SIDE_PX)
  const pageCount = pdf.doc?.numPages ?? null

  useEffect(() => {
    onPages(pageCount)
  }, [pageCount, onPages])

  if (isGone(item) || failed || pdf.failed) {
    const w = item.w ?? GONE_BOX.w
    const h = item.h ?? GONE_BOX.h
    const k = Math.min(maxWidth / w, stageHeight / h)
    const named = item.ts ? mediaClock(item.ts) : ''
    return (
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex flex-col items-center justify-center gap-2.5 rounded-xl border border-line/10 bg-shade/60 font-mono tracking-[0.1em] shadow-[0_40px_120px_color-mix(in_oklab,_var(--color-shadow)_70%,_transparent)]"
        style={{ width: Math.round(w * k), height: Math.round(h * k) }}
      >
        <GoneMark size="dialog" />
        {item.path && (
          <span className="fs-10.5 tracking-[0.04em] text-ink-900/55">
            {[item.path, named && `named ${named}`, 'not on disk now'].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>
    )
  }

  if (item.kind === 'pdf') {
    if (!pdf.doc || !pdf.aspect) return null
    return (
      <PdfPager
        doc={pdf.doc}
        aspect={pdf.aspect}
        page={Math.min(page, pdf.doc.numPages)}
        onPage={onPage}
        stageHeightPx={stageHeight}
        maxWidthPx={maxWidth}
      />
    )
  }

  return url ? (
    <>
    <img
      src={url}
      alt=""
      data-selectable
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenuAt({ x: event.clientX, y: event.clientY })
      }}
      onError={() => setFailed(true)}
      style={{
        // Never upscaled past the stored size — enlarging would invent detail (7d).
        maxWidth: item.w ? Math.min(maxWidth, item.w) : maxWidth,
        maxHeight: item.h ? Math.min(stageHeight, item.h) : stageHeight,
      }}
      className="block rounded-xl border border-line/22 shadow-[0_40px_120px_color-mix(in_oklab,_var(--color-shadow)_70%,_transparent)]"
    />
    {menuAt && (
      // The menu is portalled, but React still bubbles its clicks up this
      // tree; a chosen row must not reach the backdrop and close the viewer.
      <span onClick={(event) => event.stopPropagation()}>
        <ImageMenu
          // Keyed on the point: a right-click elsewhere is a new opening.
          key={`${menuAt.x}:${menuAt.y}`}
          at={menuAt}
          sessionId={sessionId}
          item={item}
          url={url}
          onClose={() => setMenuAt(null)}
        />
      </span>
    )}
    </>
  ) : null
}

/** What could not be done reaches the user the way the session menu's Copy path does (adr errors-are-recorded-not-announced). */
function failed(message: string): void {
  reportError(new Error(message), message)
}

/**
 * The image's right-click menu (spec 2026-10-26-media-viewer-context-menu-design):
 * Copy image always; Copy path and Show in Finder for a file a session named,
 * Finder only in the desktop app and only for a session on this Mac.
 */
function ImageMenu({
  at,
  sessionId,
  item,
  url,
  onClose,
}: {
  at: { x: number; y: number }
  sessionId: string
  item: MediaItem
  url: string
  onClose: () => void
}) {
  const local = useOrbital((s) => !s.sessions[sessionId]?.machine)
  const { path, cwd } = item

  /** The file on this Mac, absolute; null when the server cannot find it. */
  const locate = () => (path && local && sessionId ? api.locateFile(sessionId, path, cwd).catch(() => null) : Promise.resolve(null))

  const entries: MenuItem[] = [
    {
      key: 'copy-image',
      label: 'Copy image',
      icon: <ImageGlyph />,
      onSelect: () =>
        void copyImageToClipboard(url).then((ok) => ok || failed('Could not copy the image to the clipboard')),
    },
  ]
  if (path) {
    entries.push({
      key: 'copy-path',
      label: 'Copy path',
      icon: <CopyGlyph />,
      onSelect: () =>
        void (async () => {
          // A path already absolute is copied as the session wrote it; the
          // server's answer is the real one (`/tmp` read as `/private/tmp`).
          const absolute = path.startsWith('/') ? path : ((await locate()) ?? path)
          if (!(await copyToClipboard(absolute))) failed('Could not copy the path to the clipboard')
        })(),
    })
    if (canShowInFolder() && local) {
      entries.push({
        key: 'show-in-finder',
        label: 'Show in Finder',
        icon: <FolderGlyph />,
        onSelect: () =>
          void locate().then((found) => (found ? showInFolder(found) : failed('Could not find the file on disk'))),
      })
    }
  }

  return <ContextMenu at={at} entries={entries} aria-label="Image actions" onClose={onClose} />
}

/** 24e: 40px frames 4px apart; the current one in the accent with a 2px ring. Scrolls when the session has many. */
function Filmstrip({
  sessionId,
  order,
  current,
  onPick,
}: {
  sessionId: string
  order: readonly MediaItem[]
  current: MediaItem
  onPick: (item: MediaItem) => void
}) {
  const currentRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [current.id])
  return (
    <div className="flex max-w-[calc(100vw-400px)] gap-1 overflow-x-auto rounded-[9px] border border-line/12 bg-panel/70 p-[5px] [scrollbar-width:none]">
      {order.map((item) => (
        <FilmFrame
          key={item.id}
          ref={item.id === current.id ? currentRef : undefined}
          sessionId={sessionId}
          item={item}
          current={item.id === current.id}
          onPick={() => onPick(item)}
        />
      ))}
    </div>
  )
}

function FilmFrame({
  sessionId,
  item,
  current,
  onPick,
  ref,
}: {
  sessionId: string
  item: MediaItem
  current: boolean
  onPick: () => void
  ref?: Ref<HTMLButtonElement>
}) {
  const [gone, setGone] = useState(false)
  return (
    <button
      ref={ref}
      type="button"
      title={item.path ?? mediaSourceLabel(item)}
      aria-current={current || undefined}
      onClick={onPick}
      className={[
        'relative block h-10 w-10 flex-none overflow-hidden rounded-[5px] border bg-shade p-0',
        current
          ? 'border-accent/90 shadow-[0_0_0_2px_color-mix(in_oklab,var(--color-accent)_20%,transparent)]'
          : 'border-line/14',
      ].join(' ')}
    >
      {!isGone(item) && !gone && <MediaPicture sessionId={sessionId} item={item} fit="contain" onGone={() => setGone(true)} />}
      {isToolFrame(item) && (
        <span className="absolute bottom-px left-0.5 font-mono fs-8 text-ink-500/80">⚙</span>
      )}
    </button>
  )
}
