import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { MediaItem } from '../lib/types'
import type { MediaSourceKey, MediaTile } from '../lib/media'
import {
  MEDIA_SOURCES,
  SOURCE_LABELS,
  isToolFrame,
  mediaClock,
  mediaSourceLabel,
  mediaTileCaption,
  sourceCounts,
  sourceDetail,
  sourceShown,
  sourcesSummary,
} from '../lib/media'
import { useMediaSourceUrl } from '../lib/images'
import { usePdfThumbnail } from '../lib/pdf'
import { useEscapeLayer } from '../ui/escapeLayer'
import { POPUP_SHELL, usePopupPosition } from '../ui/usePopupPosition'

/**
 * The pieces every media surface shares (canvas `Feature - Media` 24b, 24d,
 * 24f B; `Feature - Media tiles` 26a–26d): the picture inside a tile, the
 * one tag slot, the caption, the Sources filter, and the footprint a file
 * that is no longer on disk leaves. Used by the desktop's popover,
 * gallery and maximised view, and meant for the phone's gallery too — they
 * resolve bytes through `lib/images` and `lib/pdf`, whose sources a platform
 * configures, so nothing here assumes the Mac's origin.
 */

/** 24f B: the tag plate's ink, fill and hairline — 7b's readout grammar, shrunk. */
const TAG_CLASS =
  'absolute rounded-[3px] border border-line/14 bg-space/85 px-[5px] py-px font-mono leading-[1.4] text-ink-500/85'

/** 24f B's TOOL RUN: one offset hairline behind the tile — a stack, not a shadow. */
const STACK_SHADOW = 'shadow-[3px_-3px_0_-1px_var(--color-panel-solid),3px_-3px_0_0_color-mix(in_oklab,_var(--color-line)_16%,_transparent)]'
/** 24f B: hover is 7d's — border to .42 and a 3px accent halo, no scale; on the tile's group, so its line counts too. */
const HOVER_HALO = 'group-hover:shadow-[0_0_0_3px_color-mix(in_oklab,_var(--color-accent)_12%,_transparent)]'
const STACK_HOVER_HALO =
  'group-hover:shadow-[3px_-3px_0_-1px_var(--color-panel-solid),3px_-3px_0_0_color-mix(in_oklab,_var(--color-line)_16%,_transparent),0_0_0_3px_color-mix(in_oklab,_var(--color-accent)_12%,_transparent)]'

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
      <span aria-hidden className={['block rounded-[3px] border border-ink-900/35', glyph].join(' ')} />
      <span
        className={
          size === 'tile'
            ? 'text-center font-mono fs-7.5 tracking-[0.06em] text-ink-900/50'
            : size === 'reply'
              ? 'font-mono fs-9 tracking-[0.1em] text-ink-900/50'
              : 'font-mono fs-11 tracking-[0.1em] text-ink-500/75'
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
  fit = 'cover',
}: {
  sessionId: string
  item: MediaItem
  onPages?: (pages: number) => void
  onGone: () => void
  /** `contain` shows the whole image, letterboxed — a wide screenshot read whole rather than cropped to its middle. */
  fit?: 'cover' | 'contain'
}) {
  const { url } = useMediaSourceUrl(sessionId, item, { thumb: true })
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
    <img src={url} alt="" loading="lazy" onError={onGone} className={['block h-full w-full', fit === 'contain' ? 'object-contain' : 'object-cover'].join(' ')} />
  ) : null
}

export type TileVariant = 'glance' | 'gallery'

/** 26d B: the letterbox is the tile's own near-black, not a new colour. */
const TILE_FILL = 'bg-shade'

/**
 * One grid tile (24b's glance, 24d's gallery; 26a, 26d): the whole image
 * fitted into a square, never cropped, the tag bottom-left, in the gallery
 * the time top-right, and one caption line under it (`mediaTileCaption`).
 * The parent's own tool frames carry ⚙ (⚙ ×n for a stack); PDFs say
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
  const tag = tileTag(cover, count, gone, pages)
  const gallery = variant === 'gallery'
  const caption = mediaTileCaption(tile)
  const title = tileTitle(tile)

  return (
    <button
      type="button"
      title={title}
      aria-label={`Open ${title}`}
      onClick={() => onOpen(first)}
      className="group flex w-full min-w-0 cursor-zoom-in flex-col gap-[5px] p-0 text-left"
    >
      <span
        className={[
          'relative aspect-square w-full overflow-hidden rounded-[6px] border',
          TILE_FILL,
          'transition-[border-color,box-shadow] duration-[160ms] ease-[ease]',
          gone
            ? 'flex flex-col items-center justify-center gap-[5px] border-line/10'
            : 'block border-line/14 group-hover:border-line/42',
          stacked ? `${STACK_SHADOW} ${STACK_HOVER_HALO}` : gone ? '' : HOVER_HALO,
        ].join(' ')}
      >
        {gone ? (
          <GoneMark size="tile" />
        ) : (
          <MediaPicture
            sessionId={sessionId}
            item={cover}
            fit="contain"
            onPages={setPages}
            onGone={() => setGoneKey(cover.id)}
          />
        )}
        {tag && (
          <span
            className={[TAG_CLASS, gallery ? 'bottom-[5px] left-[5px] fs-9.5' : 'bottom-1 left-1 fs-9'].join(' ')}
          >
            {tag}
          </span>
        )}
        {gallery && !gone && (
          <span className="absolute right-[5px] top-1 font-mono fs-9 text-ink-500/60">
            {mediaClock(cover.ts)}
          </span>
        )}
      </span>
      <TileCaption caption={caption} className={gallery ? 'fs-9.5' : 'fs-9'} />
    </button>
  )
}

/** ⚙ on the parent's own tool frames, ⚙ ×n on a stack of them; PDF · pages on a PDF that is there. */
export function tileTag(cover: MediaItem, count: number, gone: boolean, pages: number | null): string | null {
  if (isToolFrame(cover)) return count > 1 ? `⚙ ×${count}` : '⚙'
  if (count > 1) return `×${count}`
  if (cover.kind === 'pdf' && !gone) return pages ? `PDF · ${pages}` : 'PDF'
  return null
}

/** 26d A: the full name, the source and the time — what the caption had to cut. */
export function tileTitle(tile: MediaTile): string {
  const { cover, count } = tile
  const what = count > 1 ? `${count} tool images` : (cover.path ?? (cover.kind === 'pdf' ? 'PDF' : 'Image'))
  return [what, [mediaSourceLabel(cover), mediaClock(cover.ts)].filter(Boolean).join(' · ')].join(' — ')
}

/**
 * The line under a tile (26d A): a name in brighter ink, cut from the front
 * — saved files differ at the end (26d C) — or the source, muted. A
 * subagent's leads with the moon's hollow dot, neutral, never the tag hue.
 */
export function TileCaption({
  caption,
  className,
  dot = 'h-1.5 w-1.5 border-[1.2px]',
}: {
  caption: { text: string; named: boolean; moon: boolean }
  className: string
  dot?: string
}) {
  return (
    <span
      className={[
        'flex min-w-0 items-center gap-[5px] font-mono leading-[1.3]',
        caption.named ? 'text-ink-200/88' : 'text-ink-900/60',
        className,
      ].join(' ')}
    >
      {caption.moon && <span aria-hidden className={['block flex-none rounded-full border-ink-500/70', dot].join(' ')} />}
      {caption.named ? (
        // rtl puts the ellipsis at the front; the marks keep the name itself reading left to right.
        <span dir="rtl" className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-left">
          {`\u200E${caption.text}\u200E`}
        </span>
      ) : (
        <span className="min-w-0 truncate">{caption.text}</span>
      )}
    </span>
  )
}

/** 24f A / 24b: the tag on a reply's PDF thumbnail. */
export function PdfTag({ pages }: { pages: number | null }) {
  return <span className={[TAG_CLASS, 'bottom-1 left-1 fs-9'].join(' ')}>{pages ? `PDF · ${pages}` : 'PDF'}</span>
}

/** 26a: the chip convention — resting hairline for everything, the filled chip once narrowed. */
const CHIP_REST = 'border-line/14 bg-transparent text-ink-500/75 hover:border-line/30'
const CHIP_ACTIVE = 'border-line/30 bg-line/14 text-ink-100'
/** 26a: the ✓ and the row's accent. */
const ACCENT_INK = 'text-accent'

/** Marks the list, so a popover it opens over does not take a press inside it for a press outside. */
export const SOURCES_LIST_ATTR = 'data-media-sources'

/**
 * Sources ▾ (26a, 26b): the button says the filter's state in words and
 * opens the list of five sources, each with its count. The list stays open
 * while you toggle; Escape or a press outside closes it. The same button in
 * the glance, the gallery and the maximised view, where ⚙ Hide tool images
 * used to sit.
 */
export function SourcesButton({
  items,
  hidden,
  onChange,
  prefer = 'below',
}: {
  items: readonly MediaItem[]
  hidden: readonly MediaSourceKey[]
  onChange: (hidden: MediaSourceKey[]) => void
  /** The maximised view hangs it above: its button sits at the bottom of the screen. */
  prefer?: 'below' | 'above'
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const summary = sourcesSummary(items, hidden)
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={[
          'flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full border px-[9px] py-[3px] font-mono fs-10 tracking-[0.02em]',
          'transition-[border-color,background-color,color] duration-[160ms] ease-[ease]',
          summary.filtered || open ? CHIP_ACTIVE : CHIP_REST,
        ].join(' ')}
      >
        {summary.label}
        <span aria-hidden className="fs-8 opacity-80">
          ▾
        </span>
      </button>
      {open && (
        <SourcesList
          anchorRef={buttonRef}
          items={items}
          hidden={hidden}
          onChange={onChange}
          prefer={prefer}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function SourcesList({
  anchorRef,
  items,
  hidden,
  onChange,
  prefer,
  onClose,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>
  items: readonly MediaItem[]
  hidden: readonly MediaSourceKey[]
  onChange: (hidden: MediaSourceKey[]) => void
  prefer: 'below' | 'above'
  onClose: () => void
}) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<MediaSourceKey | null>(null)
  usePopupPosition(true, anchorRef, listRef, { gap: 5, align: 'right', prefer })
  useEscapeLayer(true, onClose)

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (anchorRef.current?.contains(target) || listRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [anchorRef, onClose])

  const counts = sourceCounts(items)
  const filtered = sourcesSummary(items, hidden).filtered
  const only = (key: MediaSourceKey) => onChange(MEDIA_SOURCES.filter((k) => k !== key))
  const toggle = (key: MediaSourceKey) =>
    onChange(hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key])

  return createPortal(
    <div
      ref={listRef}
      role="menu"
      aria-label="Show images from"
      {...{ [SOURCES_LIST_ATTR]: '' }}
      onClick={(event) => event.stopPropagation()}
      className={['orbital-no-drag orbital-popover-in fixed z-[70] w-[264px] overflow-hidden font-mono', POPUP_SHELL].join(' ')}
    >
      <div className="px-3 pb-1.5 pt-[9px] fs-9.5 tracking-[0.14em] text-ink-900/55">SHOW IMAGES FROM</div>
      {MEDIA_SOURCES.map((key) => {
        const count = counts[key]
        const on = sourceShown(key, hidden, counts)
        const empty = count === 0
        const detail = sourceDetail(key, items)
        const hovered = hover === key && !empty
        return (
          <div
            key={key}
            onMouseEnter={() => setHover(key)}
            onMouseLeave={() => setHover(null)}
            className={['flex items-center px-1.5', hovered ? 'bg-line/6' : ''].join(' ')}
          >
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              disabled={empty}
              onClick={(event) => (event.altKey ? only(key) : toggle(key))}
              className={[
                'flex h-fit min-h-8 min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left fs-11 disabled:cursor-default',
                on && !empty ? 'text-ink-100' : 'text-ink-900/55',
              ].join(' ')}
            >
              <span aria-hidden className={['w-3 flex-none fs-11', ACCENT_INK].join(' ')}>
                {on && !empty ? '✓' : ''}
              </span>
              {key === 'subagent' && (
                <span aria-hidden className="block h-[7px] w-[7px] flex-none rounded-full border-[1.3px] border-current" />
              )}
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate">{SOURCE_LABELS[key]}</span>
                {detail && <span className="truncate fs-9.5 text-ink-900/50">{detail}</span>}
              </span>
            </button>
            <span className="flex w-11 flex-none justify-end pr-1.5">
              {hovered ? (
                <button
                  type="button"
                  onClick={() => only(key)}
                  className="rounded-[4px] border border-line/20 px-1.5 py-0.5 fs-9.5 text-ink-100"
                >
                  only
                </button>
              ) : (
                <span className="fs-10.5 text-ink-900/55">{count}</span>
              )}
            </span>
          </div>
        )
      })}
      <div className="mt-1 flex items-center gap-2 border-t border-line/8 px-3 py-2">
        <button
          type="button"
          disabled={!filtered}
          onClick={() => onChange([])}
          className={[
            'rounded-[5px] border border-line/20 px-[9px] py-[3px] fs-10.5 disabled:cursor-default',
            filtered ? 'text-ink-100' : 'text-ink-900/40',
          ].join(' ')}
        >
          Show all
        </button>
        <span className="flex-1" />
        <span className="fs-9.5 text-ink-900/45">this session</span>
      </div>
    </div>,
    document.body,
  )
}

/**
 * 26b C, the one real empty state: there is media, and the filter hides all
 * of it, whatever the combination. One mono line saying why, and Show all —
 * never a blank grid.
 */
export function NothingShown({ hidden, onShowAll, className }: { hidden: number; onShowAll: () => void; className?: string }) {
  return (
    <div
      className={[
        'flex flex-col items-center justify-center gap-2 font-mono fs-10.5 text-ink-900/60',
        className ?? '',
      ].join(' ')}
    >
      <span>Nothing from these sources · {hidden} hidden</span>
      <button
        type="button"
        onClick={onShowAll}
        className="rounded-[5px] border border-line/20 px-2.5 py-1 text-ink-100 transition-colors duration-[160ms] hover:border-line/45"
      >
        Show all
      </button>
    </div>
  )
}
