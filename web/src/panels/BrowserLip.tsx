import { useRef } from 'react'
import { lipExcerpt, type BrowserSelection } from '../lib/browserBridge'
import { usePresence } from '../ui/usePresence'
import {
  IDE_SLOT_CARD_CLASS,
  IDE_SLOT_DISMISS_CLASS,
  IDE_SLOT_HEIGHT_PX,
  IDE_SLOT_OVERLAP_PX,
  IDE_SLOT_SLIDE_MS,
} from './IdeSlot'

/**
 * The browser selection on the composer well's edge (spec
 * 2026-11-05-browser-bridge-design § A selection in the composer): the page
 * title, the start of the text and a ×.
 *
 * Provisional look: the editor slot's card, glyph and × reused as they are,
 * until Claude Design draws its own. Like the slot it is a lip — something the
 * world put there — so it is an overlay on the well's edge and nothing
 * reflows. When the editor slot is up too, this one stacks above it
 * (`liftPx`), and the completion popup clears both.
 */
export function BrowserLip({
  selection,
  liftPx,
  onDismiss,
}: {
  selection: BrowserSelection | null
  /** How far above the well's edge it sits: the editor slot's height while that is up. */
  liftPx: number
  onDismiss: () => void
}) {
  const { mounted, state } = usePresence(selection !== null, IDE_SLOT_SLIDE_MS, IDE_SLOT_SLIDE_MS)
  // Held through the sink, so it goes back down with what it said.
  const last = useRef<BrowserSelection | null>(selection)
  if (selection) last.current = selection
  const shown = selection ?? last.current
  if (!mounted || !shown) return null
  const hidden = state !== 'entered'

  return (
    <div
      data-browser-lip
      // The editor slot's box (IdeSlot): one pixel into the edge below it,
      // clipped so the slide reads as "from behind the edge".
      style={{
        height: `${IDE_SLOT_HEIGHT_PX + IDE_SLOT_OVERLAP_PX}px`,
        bottom: liftPx ? `calc(100% + ${liftPx}px)` : '100%',
      }}
      className="pointer-events-none absolute left-0 right-0 z-[3] overflow-hidden"
    >
      <div
        style={{
          transform: hidden ? 'translateY(100%)' : 'translateY(0)',
          opacity: hidden ? 0 : 1,
          transition: `transform ${IDE_SLOT_SLIDE_MS}ms cubic-bezier(.2,.8,.2,1), opacity 200ms ease`,
        }}
        className="motion-reduce:!transition-none absolute inset-0"
      >
        <div
          style={{ height: `${IDE_SLOT_HEIGHT_PX}px`, marginBottom: `-${IDE_SLOT_OVERLAP_PX}px` }}
          className={IDE_SLOT_CARD_CLASS}
        >
          <div className="pointer-events-auto absolute inset-0 flex items-center gap-2 whitespace-nowrap pl-[10px] pr-[5px] text-ink-500/75">
            {/* The editor lip's lines glyph: a selection of text. */}
            <span aria-hidden className="relative block h-[9px] w-[10px] flex-none">
              <span className="absolute left-0 top-0 h-[1.6px] w-[10px] rounded-[1px] bg-ink-900/60" />
              <span className="absolute left-0 top-[3.7px] h-[1.6px] w-[7px] rounded-[1px] bg-ink-900/60" />
              <span className="absolute left-0 top-[7.4px] h-[1.6px] w-[9px] rounded-[1px] bg-ink-900/60" />
            </span>
            <span className="min-w-0 flex-1 truncate" title={shown.url}>
              <span className="text-ink-200">{shown.title || shown.url}</span>{' '}
              <span>{lipExcerpt(shown.text)}</span>
            </span>
            <button
              type="button"
              aria-label="Drop the browser selection from this session"
              onClick={onDismiss}
              className={IDE_SLOT_DISMISS_CLASS}
            >
              ×
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
