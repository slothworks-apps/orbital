import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { formatBytes } from '../../lib/format'
import { PdfPageCanvas, usePdfDocument } from '../../panels/PdfPages'
import { asOfLabel, basename } from '../format'
import { useMobile } from '../state'
import { CantShow } from './CantShow'
import { ByteBar, CachedChip, GoneBlock, StateButton, StateText } from './FileStates'
import { useSwipe } from './MediaFoot'
import { useObjectUrl } from './objectUrl'
import { useFile } from './useFile'

/** Canvas 24g, PDF viewer: the pages 24px in from either edge, 14px apart. */
const PAGE_INSET_PX = 24
const PAGE_GAP_PX = 14
/** Under the 56px header, and over the foot, so the first and the last page can be read whole. */
const PAGES_TOP_PX = 70
const PAGES_BOTTOM_PX = 150
/** How far outside the view a page starts drawing, so a scroll meets it drawn. */
const PAGE_DRAW_MARGIN = '600px 0px'

/**
 * A PDF on the phone (canvas `Feature - Media` 24g; spec
 * 2026-10-09-session-media-design § Phone): the bytes over `file_get` as
 * `pdf`, every page drawn by pdf.js in one vertical scroll, so a swipe ↔
 * still moves to the next item. This replaces 10e's "can't be shown" for
 * PDFs; the other 10e states — loading, gone, the Mac asleep, couldn't load —
 * are the image viewer's. A Mac that predates PDFs refuses them, and the
 * phone then shows can't-be-shown as it used to.
 */
export function PdfPage({
  sessionId, path, cwd, index, count, onBack, onPage, foot,
}: {
  sessionId: string
  path: string
  cwd?: string
  index: number
  count: number
  onBack: () => void
  onPage: (delta: number) => void
  /** The foot under the pages; `page` is "page 2 of 6" once the document is open, `cached` 10e's chip. */
  foot: (ctx: { page: string | null; cached: ReactNode }) => ReactNode
}) {
  const source = useMemo(() => ({ kind: 'path' as const, sessionId, path, as: 'pdf' as const, cwd }), [sessionId, path, cwd])
  const { view, retry } = useFile(source)
  const mac = useMobile((s) => s.macName) ?? 'the Mac'
  const outcome = view.phase === 'done' ? view.outcome : null
  const shown = outcome?.kind === 'ready' ? outcome : outcome?.kind === 'gone' ? outcome.copy : null
  const url = useObjectUrl(shown)
  const pdf = usePdfDocument(url, url ?? '')
  const [page, setPage] = useState(1)

  const scrollRef = useRef<HTMLDivElement>(null)
  useSwipe(scrollRef, onPage)

  const size = shown?.bytes.length ?? (view.phase === 'loading' ? view.total : null)
  const pages = pdf.doc?.numPages ?? null
  const sub = [
    'PDF',
    pages !== null ? `${pages} ${pages === 1 ? 'page' : 'pages'}` : null,
    size !== null ? formatBytes(size) : null,
    count > 1 ? `${index + 1} of ${count}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  let area: ReactNode = null
  if (pdf.doc && pdf.aspect) {
    area = <Pages doc={pdf.doc} aspect={pdf.aspect} onPage={setPage} />
  } else if (pdf.failed) {
    // Bytes pdf.js refuses: not a PDF after all, or a damaged one.
    area = <Centred><CantShow path={path} size={size} /></Centred>
  } else if (view.phase === 'loading') {
    area = <Centred><ByteBar received={view.received} total={view.total} mac={mac} /></Centred>
  } else if (outcome?.kind === 'failed') {
    area = (
      <Centred>
        <StateText title="Couldn't load" action={<StateButton onClick={retry}>Retry</StateButton>}>
          {outcome.received > 0 ? `The connection dropped at ${formatBytes(outcome.received)}.` : 'The connection dropped.'}
        </StateText>
      </Centred>
    )
  } else if (outcome?.kind === 'gone' && !shown) {
    area = <Centred><GoneBlock path={path} mac={mac} /></Centred>
  } else if (outcome?.kind === 'waits') {
    area = (
      <Centred>
        <StateText title={`Opens when ${mac} wakes`}>Not on this phone yet. Stay here and it loads on its own.</StateText>
      </Centred>
    )
  } else if (outcome?.kind === 'cant-show' || outcome?.kind === 'outside') {
    area = (
      <Centred>
        <CantShow path={path} size={outcome.kind === 'cant-show' ? outcome.size : null} outside={outcome.kind === 'outside'} />
      </Centred>
    )
  }

  return (
    <main className="relative flex h-full min-h-0 flex-col overflow-hidden bg-black text-[#e8eef8]">
      <div ref={scrollRef} className="absolute inset-0 overflow-y-auto overscroll-contain">
        {area}
      </div>
      {/* Canvas 24g: the header over the pages, 56px on a fade from black. */}
      <div className="relative z-[2] flex h-14 shrink-0 items-center gap-1 bg-[linear-gradient(180deg,rgba(0,0,0,.8),transparent)] pl-1.5 pr-2.5">
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="grid h-11 w-11 shrink-0 place-items-center text-[28px] leading-none text-[#e8eef8]"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{basename(path)}</div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-[rgba(200,215,235,.7)]">{sub}</div>
        </div>
      </div>
      <div className="pointer-events-none flex-1" />
      {foot({
        page: pdf.doc ? `page ${page} of ${pdf.doc.numPages}` : null,
        cached: shown?.cached ? <div><CachedChip asOf={asOfLabel(shown.readAt, Date.now())} /></div> : null,
      })}
    </main>
  )
}

function Centred({ children }: { children: ReactNode }) {
  return <div className="flex min-h-full flex-col justify-center">{children}</div>
}

/**
 * Every page, as wide as the screen less its insets, one under another. A
 * page is drawn once it comes near the view — a long PDF is many canvases —
 * and the page under the middle of the screen is the one the chip names.
 */
function Pages({ doc, aspect, onPage }: { doc: PDFDocumentProxy; aspect: number; onPage: (page: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setWidth(Math.max(0, el.clientWidth - 2 * PAGE_INSET_PX))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const height = Math.round(width / aspect)

  // The scroller is the parent the viewer owns; the page under its middle is the current one.
  const onScroll = useCallback(() => {
    const scroller = ref.current?.parentElement
    if (!scroller || height === 0) return
    const middle = scroller.scrollTop + scroller.clientHeight / 2 - PAGES_TOP_PX
    onPage(Math.min(doc.numPages, Math.max(1, Math.floor(middle / (height + PAGE_GAP_PX)) + 1)))
  }, [doc, height, onPage])
  useEffect(() => {
    const scroller = ref.current?.parentElement
    if (!scroller) return
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [onScroll])

  return (
    <div
      ref={ref}
      className="flex flex-col"
      style={{ gap: PAGE_GAP_PX, padding: `${PAGES_TOP_PX}px ${PAGE_INSET_PX}px ${PAGES_BOTTOM_PX}px` }}
    >
      {width > 0 &&
        Array.from({ length: doc.numPages }, (_, i) => (
          <PdfSheet key={i} doc={doc} page={i + 1} width={width} height={height} />
        ))}
    </div>
  )
}

function PdfSheet({ doc, page, width, height }: { doc: PDFDocumentProxy; page: number; width: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
      },
      { rootMargin: PAGE_DRAW_MARGIN },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [seen])
  return (
    <div
      ref={ref}
      aria-label={`Page ${page}`}
      className="flex-none overflow-hidden rounded-[4px] bg-[rgba(220,232,250,.1)]"
      style={{ width, height }}
    >
      {seen && <PdfPageCanvas doc={doc} page={page} heightPx={height} widthPx={width} className="block" />}
    </div>
  )
}
