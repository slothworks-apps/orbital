import { useEffect, useRef, useState } from 'react'
import type { MediaItem } from '../lib/types'
import type { MediaTile } from '../lib/media'
import { mediaClock } from '../lib/media'
import { useMediaSourceUrl } from '../lib/images'
import { usePdfThumbnail } from '../lib/pdf'

/**
 * The pieces every media surface shares (canvas `Feature - Media` 24b, 24d,
 * 24f B): the picture inside a tile, the one tag slot, and the footprint a
 * file that is no longer on disk leaves. Used by the desktop's popover,
 * gallery and maximised view, and meant for the phone's gallery too — they
 * resolve bytes through `lib/images` and `lib/pdf`, whose sources a platform
 * configures, so nothing here assumes the Mac's origin.
 */

/** 24f B: the tag plate's ink, fill and hairline — 7b's readout grammar, shrunk. */
const TAG_CLASS =
  'absolute rounded-[3px] border border-[rgba(150,205,255,.14)] bg-[rgba(5,7,13,.85)] px-[5px] py-px font-mono leading-[1.4] text-[rgba(200,220,245,.85)]'

/** 24f B's TOOL RUN: one offset hairline behind the tile — a stack, not a shadow. */
const STACK_SHADOW = 'shadow-[3px_-3px_0_-1px_#0b1120,3px_-3px_0_0_rgba(150,205,255,.16)]'
/** 24f B: hover is 7d's — border to .42 and a 3px accent halo, no scale. */
const HOVER_HALO = 'hover:shadow-[0_0_0_3px_rgba(89,228,243,.12)]'
const STACK_HOVER_HALO =
  'hover:shadow-[3px_-3px_0_-1px_#0b1120,3px_-3px_0_0_rgba(150,205,255,.16),0_0_0_3px_rgba(89,228,243,.12)]'

/** Whether the list says the file an item names is gone. */
export function isGone(item: MediaItem): boolean {
  return item.source === 'agent' && item.disk === 'missing'
}

/** The cache key a PDF's first page is held under: the client knows the disk state, not the `mtime`. */
export function pdfKey(url: string, item: Pick<MediaItem, 'disk'>): string {
  return `${url}|${item.disk ?? ''}`
}

export type GoneSize = 'tile' | 'reply' | 'dialog'

/**
 * NO LONGER ON DISK (24f C): the same footprint, a hollow square and neutral
 * ink — housekeeping, not an error, so no retry and no colour. The grid's
 * tile is too small for the long words and says NOT ON DISK (24f B).
 */
export function GoneMark({ size }: { size: GoneSize }) {
  const glyph = size === 'tile' ? 'h-3 w-3' : size === 'reply' ? 'h-3.5 w-3.5' : 'h-5 w-5 rounded-[4px]'
  return (
    <>
      <span aria-hidden className={['block rounded-[3px] border border-[rgba(160,190,225,.35)]', glyph].join(' ')} />
      <span
        className={
          size === 'tile'
            ? 'text-center font-mono text-[7.5px] tracking-[0.06em] text-[rgba(160,190,225,.5)]'
            : size === 'reply'
              ? 'font-mono text-[9px] tracking-[0.1em] text-[rgba(160,190,225,.5)]'
              : 'font-mono text-[11px] tracking-[0.1em] text-[rgba(200,220,245,.75)]'
        }
      >
        {size === 'tile' ? 'NOT ON DISK' : 'NO LONGER ON DISK'}
      </span>
    </>
  )
}

/**
 * What fills a tile: the image cropped square, or a PDF's first page. Reports
 * a file that would not load, which the tile then draws as gone — a reply's
 * path that was never listed is checked no other way.
 */
export function MediaPicture({
  sessionId,
  item,
  onPages,
  onGone,
}: {
  sessionId: string
  item: MediaItem
  onPages?: (pages: number) => void
  onGone: () => void
}) {
  const { url } = useMediaSourceUrl(sessionId, item)
  const pdf = usePdfThumbnail(item.kind === 'pdf' ? url : null, url ? pdfKey(url, item) : '')
  const latest = useRef({ onGone, onPages })
  latest.current = { onGone, onPages }
  useEffect(() => {
    if (pdf.failed) latest.current.onGone()
  }, [pdf.failed])
  useEffect(() => {
    if (pdf.thumb) latest.current.onPages?.(pdf.thumb.pages)
  }, [pdf.thumb])
  if (item.kind === 'pdf') {
    return pdf.thumb ? (
      <img src={pdf.thumb.url} alt="" className="block h-full w-full object-cover object-top" />
    ) : null
  }
  return url ? (
    <img src={url} alt="" loading="lazy" onError={onGone} className="block h-full w-full object-cover" />
  ) : null
}

export type TileVariant = 'glance' | 'gallery'

/**
 * One grid tile (24b's glance, 24d's gallery, 24f B): a square crop, the tag
 * bottom-left, and in the gallery the time top-right. Yours and the agent's
 * images carry no tag; tool frames carry ⚙ (⚙ ×n for a stack); PDFs say
 * PDF · pages once pdf.js has counted them.
 */
export function MediaTileButton({
  sessionId,
  tile,
  variant,
  onOpen,
}: {
  sessionId: string
  tile: MediaTile
  variant: TileVariant
  onOpen: (item: MediaItem) => void
}) {
  const { cover, first, count } = tile
  const [goneKey, setGoneKey] = useState<string | null>(null)
  const [pages, setPages] = useState<number | null>(null)
  const gone = isGone(cover) || goneKey === cover.id
  const stacked = count > 1
  const tag = cover.source === 'tool' ? (stacked ? `⚙ ×${count}` : '⚙') : cover.kind === 'pdf' && !gone ? (pages ? `PDF · ${pages}` : 'PDF') : null
  const title = stacked ? `${count} tool images` : (cover.path ?? (cover.source === 'tool' ? 'Tool image' : 'Attached image'))
  const gallery = variant === 'gallery'

  return (
    <button
      type="button"
      title={title}
      aria-label={`Open ${title}`}
      onClick={() => onOpen(first)}
      className={[
        'relative aspect-square w-full cursor-zoom-in overflow-hidden rounded-[6px] border p-0',
        'transition-[border-color,box-shadow] duration-[160ms] ease-[ease]',
        gone
          ? 'flex flex-col items-center justify-center gap-[5px] border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.6)]'
          : 'block border-[rgba(150,205,255,.14)] bg-[rgba(4,8,16,.6)] hover:border-[rgba(150,205,255,.42)]',
        stacked ? `${STACK_SHADOW} ${STACK_HOVER_HALO}` : gone ? '' : HOVER_HALO,
      ].join(' ')}
    >
      {gone ? (
        <GoneMark size="tile" />
      ) : (
        <MediaPicture
          sessionId={sessionId}
          item={cover}
          onPages={setPages}
          onGone={() => setGoneKey(cover.id)}
        />
      )}
      {tag && (
        <span
          className={[TAG_CLASS, gallery ? 'bottom-[5px] left-[5px] text-[9.5px]' : 'bottom-1 left-1 text-[9px]'].join(' ')}
        >
          {tag}
        </span>
      )}
      {gallery && (
        <span className="absolute right-[5px] top-1 font-mono text-[9px] text-[rgba(200,220,245,.55)]">
          {mediaClock(cover.ts)}
        </span>
      )}
    </button>
  )
}

/** 24f A / 24b: the tag on a reply's PDF thumbnail. */
export function PdfTag({ pages }: { pages: number | null }) {
  return <span className={[TAG_CLASS, 'bottom-1 left-1 text-[9px]'].join(' ')}>{pages ? `PDF · ${pages}` : 'PDF'}</span>
}

/**
 * ⚙ Hide tool images — the one per-session switch, the same chip in the
 * popover, the gallery and the maximised view (24b, 24d, 24e), drawn with
 * the chip convention: resting hairline, on = .3 border over a .14 fill.
 */
export function HideToolChip({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={[
        'flex-none whitespace-nowrap rounded-full border px-[9px] py-[3px] font-mono text-[10px] tracking-[0.02em]',
        'transition-[border-color,background-color,color] duration-[160ms] ease-[ease]',
        on
          ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-[#e8eef8]'
          : 'border-[rgba(150,205,255,.14)] bg-transparent text-[rgba(200,220,245,.75)] hover:border-[rgba(150,205,255,.3)]',
      ].join(' ')}
    >
      ⚙ Hide tool images
    </button>
  )
}

/**
 * 24h C, the one real empty state: there is media, and the switch hides all
 * of it. One mono line saying why, and the one button that turns it off.
 */
export function OnlyToolHidden({ hidden, onShow, className }: { hidden: number; onShow: () => void; className?: string }) {
  return (
    <div
      className={[
        'flex flex-col items-center justify-center gap-2 font-mono text-[10.5px] text-[rgba(160,190,225,.6)]',
        className ?? '',
      ].join(' ')}
    >
      <span>Only tool images so far · {hidden} hidden</span>
      <button
        type="button"
        onClick={onShow}
        className="rounded-[5px] border border-[rgba(150,205,255,.2)] px-2.5 py-1 text-[#e8eef8] transition-colors duration-[160ms] hover:border-[rgba(150,205,255,.45)]"
      >
        Show tool images
      </button>
    </div>
  )
}
