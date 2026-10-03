import { createPortal } from 'react-dom'
import { EscapeBoundary, useEscapeLayer } from './escapeLayer'
import { usePresence } from './usePresence'

/**
 * Full-size image preview (canvas 7c). Deliberately NOT `Dialog`: that is
 * form-dialog chrome — fixed widths, ruled header, corner brackets — and
 * the canvas draws a bare lightbox. What the idea doc actually wanted from
 * `Dialog` (overlay, Escape ranking, exit animation, portal past the
 * panel's backdrop-filter) lives in the shared infra reused here.
 *
 * Timings and easing from 7d: backdrop fades, the image settles 98%→100%.
 * No zoom, no pan, no gallery arrows — page zoom is disabled app-wide
 * (web/CLAUDE.md), and a first pass that needs none of it stays out of
 * that trade-off.
 */
const LIGHTBOX_ENTER_MS = 180
const LIGHTBOX_EXIT_MS = 140

export interface LightboxProps {
  open: boolean
  /** Null while the bytes are still being resolved — the frame shows empty. */
  src: string | null
  /** Stored dimensions, when known: the cap never upscales past them. */
  width?: number | null
  height?: number | null
  /** Mono caption under the image: source · dimensions · size. */
  caption: string
  onClose: () => void
}

export function Lightbox({ open, src, width, height, caption, onClose }: LightboxProps) {
  useEscapeLayer(open, onClose)
  const { mounted, state } = usePresence(open, LIGHTBOX_ENTER_MS, LIGHTBOX_EXIT_MS)
  if (!mounted) return null
  const entered = state === 'entered'

  return createPortal(
    <EscapeBoundary>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Image preview"
        data-state={state}
        inert={state === 'exiting' || undefined}
        onClick={onClose}
        style={{ transition: 'opacity 140ms ease', opacity: entered ? 1 : 0 }}
        className="orbital-no-drag fixed inset-0 z-50 flex flex-col items-center justify-center gap-3.5 bg-[rgba(2,4,9,.82)] p-6 backdrop-blur-[6px]"
      >
        <img
          src={src ?? undefined}
          alt={caption}
          onClick={(event) => event.stopPropagation()}
          style={{
            // Longest edge to 85% of the viewport, never upscaled past the
            // stored size — enlarging would invent detail (7d).
            maxWidth: width ? `min(85vw, ${width}px)` : '85vw',
            maxHeight: height ? `min(85vh, ${height}px)` : '85vh',
            transition: 'transform 180ms cubic-bezier(.2,.9,.25,1)',
            transform: entered ? 'scale(1)' : 'scale(.98)',
          }}
          className="block rounded-xl border border-[rgba(150,205,255,.22)] shadow-[0_40px_120px_rgba(0,0,0,.7)]"
        />
        <div
          onClick={(event) => event.stopPropagation()}
          className="font-mono text-[11px] tracking-[0.08em] text-[rgba(160,190,225,.6)]"
        >
          {caption}
          <span aria-hidden className="mx-3 text-[rgba(150,205,255,.28)]">
            ·
          </span>
          <span className="mr-1.5 rounded border border-[rgba(150,205,255,.2)] px-[7px] py-[3px] text-[rgba(200,220,245,.7)]">
            esc
          </span>
          or click outside to close
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-7 top-7 grid h-[34px] w-[34px] place-items-center rounded-[9px] border border-[rgba(150,205,255,.2)] bg-[rgba(10,14,24,.7)] text-base text-text-bright transition-colors hover:border-[rgba(150,205,255,.45)]"
        >
          ×
        </button>
      </div>
    </EscapeBoundary>,
    document.body,
  )
}
