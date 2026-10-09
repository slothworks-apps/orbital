import { useEffect, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'

/**
 * PDFs, drawn with pdf.js (spec 2026-10-09-session-media-design § pdf.js).
 *
 * The library and its worker are loaded with a dynamic `import()` the first
 * time a PDF is shown, so the map's first paint never pays for them; Vite
 * bundles the worker as an asset of its own (`?url`).
 *
 * First-page thumbnails are rendered once, at `THUMB_RENDER_PX` — twice the
 * gallery's tile, the largest tile there is — and kept in an in-memory LRU.
 * The key is the URL plus the file's disk state from the media list: the
 * client is never told a file's `mtime`, so "changed since" is what tells a
 * rewritten file from the one already drawn.
 */

type Pdfjs = typeof import('pdfjs-dist')

/** Twice canvas 24d's gallery tile (131px), so one rendering serves every tile at 2×. */
export const THUMB_RENDER_PX = 262
/** First-page thumbnails held. */
const THUMB_CACHE_SIZE = 64
/** Open documents held, so paging back to a PDF just viewed does not parse it again. */
const DOC_CACHE_SIZE = 3

let pdfjsLoad: Promise<Pdfjs> | null = null

function pdfjs(): Promise<Pdfjs> {
  if (!pdfjsLoad) {
    pdfjsLoad = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
      ([lib, worker]) => {
        lib.GlobalWorkerOptions.workerSrc = worker.default
        return lib
      },
    )
    // A failed chunk load is asked for again next time rather than remembered.
    pdfjsLoad.catch(() => {
      pdfjsLoad = null
    })
  }
  return pdfjsLoad
}

/** How a PDF's bytes are read from the URL the media source answered. */
export type PdfBytesLoader = (url: string) => Promise<ArrayBuffer>

let loadBytes: PdfBytesLoader = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`PDF ${response.status}`)
  return response.arrayBuffer()
}

/** For a platform whose PDF URLs plain `fetch` cannot read. */
export function configurePdf(opts: { load: PdfBytesLoader }): void {
  loadBytes = opts.load
}

/** A Map in insertion order is an LRU: touching an entry moves it to the end. */
function touch<V>(cache: Map<string, V>, key: string, value: V, size: number, drop?: (value: V) => void): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > size) {
    const [oldest, gone] = cache.entries().next().value as [string, V]
    cache.delete(oldest)
    drop?.(gone)
  }
}

const docs = new Map<string, Promise<PDFDocumentProxy>>()

async function loadDocument(url: string): Promise<PDFDocumentProxy> {
  const [lib, bytes] = await Promise.all([pdfjs(), loadBytes(url)])
  return lib.getDocument({ data: new Uint8Array(bytes) }).promise
}

/** The document behind `url`, opened once per `key` while it stays among the last few. */
export function openPdf(url: string, key: string = url): Promise<PDFDocumentProxy> {
  const held = docs.get(key)
  if (held) {
    touch(docs, key, held, DOC_CACHE_SIZE)
    return held
  }
  const opening = loadDocument(url)
  opening.catch(() => docs.delete(key))
  touch(docs, key, opening, DOC_CACHE_SIZE, (gone) => {
    void gone.then((doc) => doc.loadingTask.destroy()).catch(() => undefined)
  })
  return opening
}

export interface PageRender {
  done: Promise<void>
  cancel(): void
}

/**
 * Draws one page into `canvas` at `cssHeightPx` tall, sharp at the screen's
 * pixel ratio. The canvas's CSS size is the caller's.
 */
export function renderPdfPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  cssHeightPx: number,
): PageRender {
  let cancelled = false
  let task: { cancel(): void } | null = null
  const done = (async () => {
    const page = await doc.getPage(pageNumber)
    if (cancelled) return
    const base = page.getViewport({ scale: 1 })
    const ratio = globalThis.devicePixelRatio || 1
    const viewport = page.getViewport({ scale: (cssHeightPx / base.height) * ratio })
    canvas.width = Math.round(viewport.width)
    canvas.height = Math.round(viewport.height)
    const render = page.render({ canvas, viewport })
    task = render
    await render.promise
  })()
  return {
    done,
    cancel() {
      cancelled = true
      task?.cancel()
    },
  }
}

/** The page's width over its height, from page 1 — what a box reserves before anything draws. */
export async function pdfAspect(doc: PDFDocumentProxy, pageNumber = 1): Promise<number> {
  const page = await doc.getPage(pageNumber)
  const { width, height } = page.getViewport({ scale: 1 })
  return width / height
}

export interface PdfThumb {
  /** The first page, as a data URL. */
  url: string
  pages: number
  /** Width over height of the first page. */
  aspect: number
}

const thumbs = new Map<string, Promise<PdfThumb>>()

/** The first page of the PDF at `url`, rendered once per `key`. */
export function pdfThumbnail(url: string, key: string): Promise<PdfThumb> {
  const held = thumbs.get(key)
  if (held) {
    touch(thumbs, key, held, THUMB_CACHE_SIZE)
    return held
  }
  const rendering = (async () => {
    // A document of its own, let go once drawn: the open-document cache is the
    // viewer's, and a gallery of thumbnails would evict what it is showing.
    const doc = await loadDocument(url)
    try {
      const page = await doc.getPage(1)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: THUMB_RENDER_PX / base.width })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      await page.render({ canvas, viewport }).promise
      return { url: canvas.toDataURL('image/png'), pages: doc.numPages, aspect: base.width / base.height }
    } finally {
      void doc.loadingTask.destroy()
    }
  })()
  rendering.catch(() => thumbs.delete(key))
  touch(thumbs, key, rendering, THUMB_CACHE_SIZE)
  return rendering
}

/**
 * The thumbnail for a PDF, or `failed` once it could not be read — a file
 * that is not there, or bytes pdf.js refuses. Null `url` asks for nothing.
 */
export function usePdfThumbnail(url: string | null, key: string): { thumb: PdfThumb | null; failed: boolean } {
  const [state, setState] = useState<{ key: string; thumb: PdfThumb | null; failed: boolean }>({
    key: '',
    thumb: null,
    failed: false,
  })
  useEffect(() => {
    if (!url) return
    let live = true
    pdfThumbnail(url, key).then(
      (thumb) => {
        if (live) setState({ key, thumb, failed: false })
      },
      () => {
        if (live) setState({ key, thumb: null, failed: true })
      },
    )
    return () => {
      live = false
    }
  }, [url, key])
  return state.key === key ? { thumb: state.thumb, failed: state.failed } : { thumb: null, failed: false }
}
