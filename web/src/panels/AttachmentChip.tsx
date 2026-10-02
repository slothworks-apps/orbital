import { ATTACHMENT_RETRY_LIMIT, attachmentMeta, type Attachment } from '../lib/attachments'
import { extensionLabel } from '../lib/attachedFiles'

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
  'relative flex h-12 items-center gap-2 overflow-hidden rounded-[8px] border border-[rgba(150,205,255,.16)] py-1.5 pl-1.5 pr-2'

export interface AttachmentChipProps {
  chip: Attachment
  onRemove: (id: string) => void
  onRetry: (id: string) => void
}

export function AttachmentChip({ chip, onRemove, onRetry }: AttachmentChipProps) {
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
        failed ? 'bg-[rgba(150,205,255,.03)]' : 'bg-[rgba(150,205,255,.05)]',
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
            'block h-9 w-9 flex-none rounded-[5px] border border-[rgba(150,205,255,.12)] object-cover',
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
            'whitespace-nowrap font-mono text-[11px]',
            // 9d-B: a failed chip's name steps back to the muted row ink.
            failed ? 'text-[rgba(200,220,245,.8)]' : 'text-text-bright',
          ].join(' ')}
        >
          {chip.name}
        </span>
        <span
          data-chip-meta
          className="whitespace-nowrap font-mono text-[9.5px] text-[rgba(160,190,225,.55)]"
        >
          {attachmentMeta(chip)}
        </span>
      </span>

      {/* The one retry in Orbital (9d-B) — and only while there is one left to
          offer. Past the budget the chip stays as a record you can remove. */}
      {failed && chip.retries < ATTACHMENT_RETRY_LIMIT && (
        <button
          type="button"
          onClick={() => onRetry(chip.id)}
          className="flex-none rounded-[5px] border border-[rgba(150,205,255,.2)] px-2 py-[3px] font-mono text-[9.5px] tracking-[0.08em] text-[rgba(220,235,255,.9)] transition-colors duration-[120ms] ease-[ease] hover:border-[rgba(150,205,255,.42)]"
        >
          retry
        </button>
      )}

      {/* 9e: 18px square at 5px radius, and the .12s hover the canvas gives it. */}
      <button
        type="button"
        aria-label="Remove attachment"
        onClick={() => onRemove(chip.id)}
        className="grid h-[18px] w-[18px] flex-none place-items-center rounded-[5px] border border-[rgba(150,205,255,.14)] text-[11px] text-[rgba(200,220,245,.7)] transition-[border-color,color] duration-[120ms] ease-[ease] hover:border-[rgba(150,205,255,.42)] hover:text-[#f2f9ff]"
      >
        ×
      </button>

      {rail && (
        // 9d-A: a 2px rail on the chip's own bottom edge, accent .7 on .1.
        <span
          aria-hidden
          data-chip-rail
          className="absolute inset-x-0 bottom-0 block h-0.5 bg-[rgba(150,205,255,.1)]"
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

/** The 36px square a file chip has in place of a thumbnail, and a receipt has at a smaller size. */
export function FileGlyph({ name, className = '', small = false }: { name: string; className?: string; small?: boolean }) {
  return (
    <span
      aria-hidden
      data-chip-thumb
      className={[
        'grid flex-none place-items-center rounded-[5px] border border-[rgba(150,205,255,.12)] bg-[rgba(150,205,255,.06)] font-mono tracking-[0.04em] text-[rgba(200,220,245,.8)]',
        small ? 'h-5 w-7 text-[7.5px]' : 'h-9 w-9 text-[9px]',
        className,
      ].join(' ')}
    >
      {extensionLabel(name) || 'FILE'}
    </span>
  )
}
