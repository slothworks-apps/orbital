import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { openPdf, pdfAspect, renderPdfPage } from '../lib/pdf'

/**
 * A PDF's pages in the maximised view (canvas `Feature - Media` 24e): the
 * page itself as tall as the stage, and a rail of pages beside it. The phone
 * lays its pages out its own way (24g) from the same `usePdfDocument` and
 * `PdfPageCanvas`.
 */

/** 24i: the rail's page, 46 × 59, 6px apart. */
const RAIL_PAGE_W_PX = 46
const RAIL_PAGE_H_PX = 59
/** How far a wheel or trackpad travels before it turns one page — one notch of a mouse wheel and then some. */
const WHEEL_PAGE_PX = 80

export interface PdfDocumentState {
  doc: PDFDocumentProxy | null
  /** Width over height of page 1. */
  aspect: number | null
  failed: boolean
}

/** The document at `url`, opened through `lib/pdf`'s cache. Null `url` opens nothing. */
export function usePdfDocument(url: string | null, key: string): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState & { key: string }>({
    key: '',
    doc: null,
    aspect: null,
    failed: false,
  })
  useEffect(() => {
    if (!url) return
    let live = true
    openPdf(url, key)
      .then(async (doc) => {
        const aspect = await pdfAspect(doc)
        if (live) setState({ key, doc, aspect, failed: false })
      })
      .catch(() => {
        if (live) setState({ key, doc: null, aspect: null, failed: true })
      })
    return () => {
      live = false
    }
  }, [url, key])
  return state.key === key ? state : { doc: null, aspect: null, failed: false }
}

/** One page, drawn at `heightPx` CSS pixels tall and as wide as its own aspect makes it. */
export function PdfPageCanvas({
  doc,
  page,
  heightPx,
  widthPx,
  className,
}: {
  doc: PDFDocumentProxy
  page: number
  heightPx: number
  widthPx: number
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const render = renderPdfPage(doc, page, canvas, heightPx)
    render.done.catch(() => undefined)
    return () => render.cancel()
  }, [doc, page, heightPx])
  return <canvas ref={ref} className={className} style={{ width: widthPx, height: heightPx }} />
}

/** A rail page, drawn only once it scrolls into the rail's view — a long PDF is many pages. */
function RailPage({
  doc,
  page,
  current,
  onPick,
}: {
  doc: PDFDocumentProxy
  page: number
  current: boolean
  onPick: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [seen])
  useEffect(() => {
    if (current) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [current])
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Page ${page}`}
      aria-current={current || undefined}
      onClick={onPick}
      className={[
        'relative block flex-none overflow-hidden rounded-[3px] border bg-[rgba(220,232,250,.1)] p-0',
        current ? 'border-[oklch(85%_.12_205_/_.8)]' : 'border-[rgba(150,205,255,.16)]',
      ].join(' ')}
      style={{ width: RAIL_PAGE_W_PX, height: RAIL_PAGE_H_PX }}
    >
      {seen && (
        <PdfPageCanvas doc={doc} page={page} heightPx={RAIL_PAGE_H_PX} widthPx={RAIL_PAGE_W_PX} className="block object-contain" />
      )}
      <span className="absolute bottom-0.5 right-[3px] font-mono text-[8px] text-[rgba(200,220,245,.6)]">{page}</span>
    </button>
  )
}

/**
 * 24e's PDF: the rail on the left, the page at the stage's height (never
 * wider than `maxWidthPx`), and ↑ ↓ or the wheel over the page to move
 * through pages — the keys are the viewer's, so ← → stay "next item".
 */
export function PdfPager({
  doc,
  aspect,
  page,
  onPage,
  stageHeightPx,
  maxWidthPx,
}: {
  doc: PDFDocumentProxy
  aspect: number
  page: number
  onPage: (page: number) => void
  stageHeightPx: number
  maxWidthPx: number
}) {
  const pages = doc.numPages
  const heightPx = Math.round(Math.min(stageHeightPx, maxWidthPx / aspect))
  const widthPx = Math.round(heightPx * aspect)
  const wheel = useRef(0)
  return (
    <>
      <div
        className="flex flex-none flex-col gap-1.5 overflow-y-auto [scrollbar-width:none]"
        style={{ height: stageHeightPx }}
      >
        {Array.from({ length: pages }, (_, i) => (
          <RailPage key={i} doc={doc} page={i + 1} current={i + 1 === page} onPick={() => onPage(i + 1)} />
        ))}
      </div>
      <div
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => {
          wheel.current += event.deltaY
          if (Math.abs(wheel.current) < WHEEL_PAGE_PX) return
          const step = wheel.current > 0 ? 1 : -1
          wheel.current = 0
          onPage(Math.max(1, Math.min(pages, page + step)))
        }}
        className="relative overflow-hidden rounded-xl border border-[rgba(150,205,255,.22)] bg-[rgba(220,232,250,.1)] shadow-[0_40px_120px_rgba(0,0,0,.7)]"
        style={{ width: widthPx, height: heightPx }}
      >
        <PdfPageCanvas doc={doc} page={page} heightPx={heightPx} widthPx={widthPx} className="block" />
      </div>
    </>
  )
}
