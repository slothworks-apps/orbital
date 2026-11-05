import { ATTACHMENT_RETRY_LIMIT, attachmentMeta, type Attachment } from '../lib/attachments'
import { extensionLabel } from '../lib/attachedFiles'
import { pageHost } from '../lib/browserBridge'
import { BrowserHoverCard, useHoverDelay } from './BrowserHoverCard'

/**
 * One pending attachment in the well (canvas 9c-2, 9d-A, 9d-B).
 *
 * The resting chip vocabulary, not the active one — a pending attachment is
 * inventory, not a choice — which is why it carries the `.16` hairline on a
 * `.05` fill and takes no hover or selected treatment of its own. The two
 * non-resting states change only weight: the thumbnail dims, the fill drops,
 * the meta line says what happened. Nothing turns red (9d-B).
 */

/** 9e: chip 48px tall, 8px radius, padding `6 8 6 6`, 8px gap. */
const CHIP_FRAME =
  'relative flex h-fit min-h-12 items-center gap-2 overflow-hidden rounded-[8px] border border-line/16 py-1.5 pl-1.5 pr-2'

export interface AttachmentChipProps {
  chip: Attachment
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}

/** A size as the browser chip says it: `1440×900`, or nothing when the image did not say. */
function dims(chip: Attachment): string {
  const entry = chip.entry
  return entry && 'w' in entry && entry.w && entry.h ? `${entry.w}×${entry.h}` : ''
}

/** The house clock reading, `14:32`. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function AttachmentChip(props: AttachmentChipProps) {
  const { chip } = props
  const hover = useHoverDelay()
  if (!chip.browser) return <ChipFrame {...props} />
  // A screenshot from the browser (canvas 64c): the same chip, only the words
  // differ — the page title for the name, the host where the size goes — and
  // after a beat the lip's shell says which page and when. The shell hangs
  // outside the chip, whose frame clips (web/CLAUDE.md: an overlay dies inside
  // an `overflow: hidden`).
  const browser = chip.browser
  const size = dims(chip)
  return (
    <div className="relative max-w-full" onMouseEnter={hover.onMouseEnter} onMouseLeave={hover.onMouseLeave}>
      <ChipFrame {...props} meta={[pageHost(browser.url), size].filter(Boolean).join(' · ')} />
      {hover.shown && !chip.exiting && (
        // 64c-C: 330px wide, its left edge on the chip's, 7px above it.
        <BrowserHoverCard
          title={chip.name}
          lines={[browser.url, ['visible tab', size, `taken ${clock(browser.at)}`].filter(Boolean).join(' · ')]}
          className="left-0 w-[330px]"
          style={{ bottom: 'calc(100% + 7px)' }}
        />
      )}
    </div>
  )
}

function ChipFrame({ chip, onRemove, onRetry, meta }: AttachmentChipProps & { meta?: string }) {
  const failed = chip.state === 'failed'
  const uploading = chip.state === 'uploading'
  // The rail only exists once there is a figure to draw it from, which is what
  // keeps it off screen entirely for an upload shorter than one tick (9e).
  const rail = uploading && chip.progress !== null

  return (
    <div
      data-testid="attachment-chip"
      data-state={chip.state}
      className={[
        CHIP_FRAME,
        // 9d-B: the failed chip's fill drops from .05 to .03.
        failed ? 'bg-line/3' : 'bg-line/5',
        // Enter is opacity + a 98%→100% scale, .14s, no slide (9e); the ×'s
        // exit is opacity only, .1s, and then the row reflows.
        chip.exiting ? 'orbital-chip-out' : 'orbital-chip-in',
      ].join(' ')}
    >
      {/* 9e: 36px square thumb at 5px radius. The preview is the LOCAL file, so
          it is on screen before a byte has been uploaded (9d-A). */}
      {chip.previewUrl ? (
        <img
          data-chip-thumb
          src={chip.previewUrl}
          alt=""
          className={[
            'block h-9 w-9 flex-none rounded-[5px] border border-line/12 object-cover',
            failed ? 'opacity-45' : uploading ? 'opacity-50' : '',
          ].join(' ')}
        />
      ) : (
        // A file rides by path and has no preview: the square names its kind.
        <FileGlyph
          name={chip.name}
          className={failed ? 'opacity-45' : uploading ? 'opacity-50' : ''}
        />
      )}

      {/* `flex-1` only while uploading or failed, exactly as the canvas has it
          (9d-A/9d-B carry it, the resting chip in 9c-2 does not): those two
          states have something to the right of the text — the rail's percentage
          column, `retry` — that has to be pushed to the edge, and a resting chip
          should hug its own name instead of stretching. */}
      <span
        className={[
          'flex min-w-0 flex-col gap-0.5',
          uploading || failed ? 'flex-1' : '',
        ].join(' ')}
      >
        <span
          data-chip-name
          className={[
            'whitespace-nowrap font-mono fs-11',
            // 64c-B: a page title is cut at 190px.
            chip.browser ? 'max-w-[190px] truncate' : '',
            // 9d-B: a failed chip's name steps back to the muted row ink.
            failed ? 'text-ink-500/80' : 'text-ink-100',
          ].join(' ')}
        >
          {chip.name}
        </span>
        <span
          data-chip-meta
          className="whitespace-nowrap font-mono fs-9.5 text-ink-900/55"
        >
          {meta ?? attachmentMeta(chip)}
        </span>
      </span>

      {/* The one retry in Orbital (9d-B) — and only while there is one left to
          offer. Past the budget the chip stays as a record you can remove. */}
      {failed && chip.retries < ATTACHMENT_RETRY_LIMIT && (
        <button
          type="button"
          onClick={() => onRetry(chip.id)}
          className="flex-none rounded-[5px] border border-line/20 px-2 py-[3px] font-mono fs-9.5 tracking-[0.08em] text-ink-200/90 transition-colors duration-[120ms] ease-[ease] hover:border-line/42"
        >
          retry
        </button>
      )}

      {/* 9e: 18px square at 5px radius, and the .12s hover the canvas gives it. */}
      <button
        type="button"
        aria-label="Remove attachment"
        onClick={() => onRemove(chip.id)}
        className="grid h-[18px] w-[18px] flex-none place-items-center rounded-[5px] border border-line/14 fs-11 text-ink-500/70 transition-[border-color,color] duration-[120ms] ease-[ease] hover:border-line/42 hover:text-ink-50"
      >
        ×
      </button>

      {rail && (
        // 9d-A: a 2px rail on the chip's own bottom edge, accent .7 on .1.
        <span
          aria-hidden
          data-chip-rail
          className="absolute inset-x-0 bottom-0 block h-0.5 bg-line/10"
        >
          <span
            className="block h-full bg-accent/70 transition-[width] duration-200 ease-linear"
            style={{ width: `${chip.progress}%` }}
          />
        </span>
      )}
    </div>
  )
}

/**
 * The 36px square a file chip has in place of a thumbnail, and a receipt has
 * at a smaller size. Its width is a floor, with side padding, so a
 * four-letter extension at a larger text size widens the box instead of
 * spilling out of it (canvas `Feature - Text size` 6c: min-width, 5px side
 * padding, the height kept). The small box takes 4px: at 5, `YAML` would
 * widen it already at the default size.
 */
export function FileGlyph({ name, className = '', small = false }: { name: string; className?: string; small?: boolean }) {
  return (
    <span
      aria-hidden
      data-chip-thumb
      className={[
        'grid flex-none place-items-center rounded-[5px] border border-line/12 bg-line/6 font-mono tracking-[0.04em] text-ink-500/80',
        small ? 'h-5 min-w-7 px-1 fs-7.5' : 'h-9 min-w-9 px-[5px] fs-9',
        className,
      ].join(' ')}
    >
      {extensionLabel(name) || 'FILE'}
    </span>
  )
}
