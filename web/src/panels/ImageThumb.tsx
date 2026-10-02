import { useState } from 'react'
import type { ImageRefEntry } from '../lib/types'
import { formatBytes } from '../lib/format'
import { Lightbox } from '../ui/Lightbox'
import { useImageUrl } from '../lib/images'

/**
 * One transcript image thumbnail (canvas 7a/7b/7d), clicking through to
 * the `Lightbox`. The box is reserved from the stored dimensions so decode
 * shifts nothing (7a acceptance); a pruned ref (`onerror`) swaps to the
 * NOT IN CACHE placeholder at the same footprint — housekeeping, not an
 * error, so no retry and nothing to click (7b-B).
 */

/** 7d: user-turn thumbs 120px tall, tool results 96px ("machinery reads
 * smaller than speech"), width capped at 86% of the 406px content column. */
const THUMB_HEIGHT_PX: Record<ThumbVariant, number> = {
  'user-solo': 120,
  user: 120,
  tool: 96,
}
const THUMB_MAX_WIDTH_PX = 349


/**
 * `user-solo` — the thumbnail IS the bubble (image-only turn): bubble
 * corner geometry and the tag-hue border. `user` — under a text bubble:
 * neutral hairline, 8px radius. `tool` — inside an expanded tool row.
 * Only the solo turn borrows the hue; hue stays reserved for tags (7d).
 */
export type ThumbVariant = 'user-solo' | 'user' | 'tool'

const FRAME_CLASSES: Record<ThumbVariant, string> = {
  'user-solo':
    'rounded-[12px_12px_4px_12px] border-[oklch(80%_.13_210_/_.3)] hover:border-[oklch(80%_.13_210_/_.6)]',
  user: 'rounded-lg border-[rgba(150,205,255,.18)] hover:border-[rgba(150,205,255,.42)]',
  tool: 'rounded-[6px] border-[rgba(150,205,255,.12)] hover:border-[rgba(150,205,255,.42)]',
}

/** The reserved box: stored dims scaled into the caps, never upscaled. */
function boxFor(
  image: ImageRefEntry,
  variant: ThumbVariant,
  widthCapPx?: number,
): { width?: number; height: number } {
  const capH = THUMB_HEIGHT_PX[variant]
  const capW = widthCapPx ?? THUMB_MAX_WIDTH_PX
  if (!image.w || !image.h) return { height: capH }
  const k = Math.min(capH / image.h, capW / image.w, 1)
  return { width: Math.round(image.w * k), height: Math.round(image.h * k) }
}

export interface ImageThumbProps {
  image: ImageRefEntry
  variant: ThumbVariant
  /** Lightbox caption's source label — `pasted image`, or the tool name. */
  source: string
  /** Two-up rows cap each thumb narrower (7a: 171px). */
  widthCapPx?: number
}

export function ImageThumb({ image, variant, source, widthCapPx }: ImageThumbProps) {
  const [missing, setMissing] = useState(false)
  const [open, setOpen] = useState(false)
  const box = boxFor(image, variant, widthCapPx)
  const { url, failed, async: fadeIn, retry } = useImageUrl(image.ref)
  const [loaded, setLoaded] = useState(false)

  if (missing) {
    return (
      <div
        style={box}
        className="flex flex-col items-center justify-center gap-1.5 rounded-[6px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.6)]"
      >
        <span aria-hidden className="h-3.5 w-3.5 rounded-[3px] border border-[rgba(160,190,225,.35)]" />
        <span className="font-mono text-[9px] tracking-[0.1em] text-[rgba(160,190,225,.5)]">
          NOT IN CACHE
        </span>
      </div>
    )
  }

  // The bytes did not arrive over the tunnel (9p): the box stays, and a tap asks again.
  if (failed) {
    return (
      <button
        type="button"
        onClick={retry}
        style={box}
        className="flex flex-col items-center justify-center gap-1.5 rounded-[6px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.6)]"
      >
        <span aria-hidden className="h-3.5 w-3.5 rounded-[3px] border border-[rgba(160,190,225,.35)]" />
        <span className="font-mono text-[9px] tracking-[0.1em] text-[rgba(160,190,225,.5)]">
          COULDN&apos;T LOAD · RETRY
        </span>
      </button>
    )
  }

  const caption = [
    source,
    image.w && image.h ? `${image.w}×${image.h}` : null,
    formatBytes(image.bytes),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <>
      <button
        type="button"
        aria-label="Open image full size"
        onClick={() => setOpen(true)}
        style={{ ...box, cursor: 'zoom-in' }}
        className={[
          'block overflow-hidden border p-0 transition-[border-color,box-shadow] duration-[160ms] ease-out',
          'hover:shadow-[0_0_0_3px_rgba(89,228,243,.12)]',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[oklch(85%_.12_205_/_.7)]',
          FRAME_CLASSES[variant],
        ].join(' ')}
      >
        {url && (
          <img
            src={url}
            alt=""
            loading="lazy"
            onError={() => setMissing(true)}
            onLoad={() => setLoaded(true)}
            // The reserved box already carries the aspect ratio; unknown dims
            // fall back to the height cap and let the image size itself.
            className="block h-full w-full"
            style={{
              ...(image.w && image.h ? {} : { width: 'auto', maxHeight: '100%' }),
              // Only bytes that arrived later fade in; a URL known at first paint just shows.
              ...(fadeIn ? { opacity: loaded ? 1 : 0, transition: 'opacity 160ms ease-out' } : {}),
            }}
          />
        )}
      </button>
      <Lightbox open={open} image={image} caption={caption} onClose={() => setOpen(false)} />
    </>
  )
}
