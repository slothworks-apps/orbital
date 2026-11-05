import { useRef } from 'react'
import { lipQuote, pageHost, type BrowserSelection } from '../lib/browserBridge'
import type { Presence } from '../ui/usePresence'
import { BrowserHoverCard, useHoverDelay } from './BrowserHoverCard'
import {
  IDE_SLOT_CARD_CLASS,
  IDE_SLOT_DISMISS_CLASS,
  IDE_SLOT_HEIGHT_PX,
  IDE_SLOT_OVERLAP_PX,
  IDE_SLOT_SLIDE_MS,
} from './IdeSlot'

/**
 * The browser selection on the composer well's edge (spec
 * 2026-11-05-browser-bridge-design § A selection in the composer; canvas
 * `Feature - Browser bridge` 64a/64b): a second entry in the editor lip's
 * family, 26px like it, in the same tab — the window glyph, the start of the
 * text in quotes, "from" the page title, the host where the editor puts its
 * IDE, and a ×.
 *
 * Like the editor slot it is a lip — something the world put there — so it
 * is an overlay on the well's edge and nothing reflows. The stack's order is
 * `lipStack`'s: what will be sent touches the well, browser above editor; the
 * editor's cursor read-out, which sends nothing, never does.
 */

/** 64b-6: × pressed — the row fades out in 120ms and the stack closes. */
export const BROWSER_LIP_FADE_MS = 120

/** 64b: the hover shell sits 6px above the stack's top row. */
const HOVER_GAP_PX = 6

export interface LipStack {
  /** How far above the well's edge the browser row sits: the editor selection's row while that one is up. */
  browserLiftPx: number
  /** How far above the well's edge the editor slot sits: the browser row, when the slot shows only the cursor. */
  ideLiftPx: number
  /** The editor's selection tab is the lower row of two: square top, the .08 hairline between them (64b-2). */
  ideUnder: boolean
  /** The editor's cursor read-out stands above the browser row, borderless (64b-5). */
  ideBare: boolean
  /** The stack's height above the well, for the hover shell and the completion popup. */
  stackPx: number
}

/**
 * Where each row of the lip family goes (canvas 64b): what will be sent
 * touches the well, browser above editor; the cursor read-out never does, so
 * with a browser row up it rises above it.
 */
export function lipStack(input: { browserUp: boolean; ideUp: boolean; ideStanding: boolean }): LipStack {
  const { browserUp, ideUp, ideStanding } = input
  const editorSends = ideUp && ideStanding
  const cursorOnly = ideUp && !ideStanding
  const rows = (browserUp ? 1 : 0) + (ideUp ? 1 : 0)
  return {
    browserLiftPx: browserUp && editorSends ? IDE_SLOT_HEIGHT_PX : 0,
    ideLiftPx: browserUp && cursorOnly ? IDE_SLOT_HEIGHT_PX : 0,
    ideUnder: browserUp && editorSends,
    ideBare: browserUp && cursorOnly,
    stackPx: rows * IDE_SLOT_HEIGHT_PX,
  }
}

export function BrowserLip({
  selection,
  presence,
  liftPx,
  stackPx,
  onDismiss,
}: {
  selection: BrowserSelection | null
  /** The row's presence, owned by the composer so the stack closes only once the row has faded. */
  presence: Presence
  liftPx: number
  stackPx: number
  onDismiss: () => void
}) {
  const hover = useHoverDelay()
  // Held through the fade, so it goes with what it said.
  const last = useRef<BrowserSelection | null>(selection)
  if (selection) last.current = selection
  const shown = selection ?? last.current
  if (!presence.mounted || !shown) return null
  const entering = presence.state === 'entering'
  const exiting = presence.state === 'exiting'
  const host = pageHost(shown.url)
  const chars = shown.text.length

  return (
    <>
      <div
        data-browser-lip
        // At the well's edge the editor slot's box: one pixel into the edge,
        // clipped so the slide reads as "from behind the edge". Lifted, the
        // row sits on the one below it and its own box is exactly its height.
        style={
          liftPx
            ? { height: `${IDE_SLOT_HEIGHT_PX}px`, bottom: `calc(100% + ${liftPx - IDE_SLOT_OVERLAP_PX}px)` }
            : { height: `${IDE_SLOT_HEIGHT_PX + IDE_SLOT_OVERLAP_PX}px`, bottom: '100%' }
        }
        className="pointer-events-none absolute left-0 right-0 z-[3] overflow-hidden"
      >
        <div
          // 64a: up from behind the edge in .26s on the panel curve, like the
          // editor slot; out by fading, 120ms (64b-6).
          style={{
            transform: entering ? 'translateY(100%)' : 'translateY(0)',
            opacity: entering || exiting ? 0 : 1,
            transition: exiting
              ? `opacity ${BROWSER_LIP_FADE_MS}ms ease`
              : `transform ${IDE_SLOT_SLIDE_MS}ms cubic-bezier(.2,.8,.2,1), opacity 200ms ease`,
          }}
          className="motion-reduce:!transition-none absolute inset-0"
        >
          <div
            style={{ height: `${IDE_SLOT_HEIGHT_PX}px`, marginBottom: liftPx ? 0 : `-${IDE_SLOT_OVERLAP_PX}px` }}
            className={IDE_SLOT_CARD_CLASS}
          >
            <div className="pointer-events-auto absolute inset-0 flex items-center gap-2 whitespace-nowrap pl-[10px] pr-[5px] text-ink-500/75">
              {/* 64b: the window glyph — an 11×9 frame, 1.3px at .6, a 1.2px
                  bar 1.5px under its top edge. */}
              <span
                aria-hidden
                className="relative box-border block h-[9px] w-[11px] flex-none rounded-[2px] border-[1.3px] border-ink-900/60"
              >
                <span className="absolute inset-x-0 top-[1.5px] block h-[1.2px] bg-ink-900/60" />
              </span>
              <span className="flex min-w-0 flex-1 items-center whitespace-pre">
                <span className="flex-none text-ink-100">{lipQuote(shown.text)}</span>
                <span className="flex-none"> from </span>
                <span
                  data-browser-lip-title
                  onMouseEnter={hover.onMouseEnter}
                  onMouseLeave={hover.onMouseLeave}
                  className="min-w-0 cursor-default truncate text-ink-200"
                >
                  {shown.title || shown.url}
                </span>
              </span>
              {/* 64b-3: the host is never cut. */}
              {host && <span className="flex-none pl-1 text-ink-900/45">{host}</span>}
              <button
                type="button"
                aria-label="Don’t attach this browser selection"
                onClick={onDismiss}
                className={IDE_SLOT_DISMISS_CLASS}
              >
                ×
              </button>
            </div>
          </div>
        </div>
      </div>
      {hover.shown && !exiting && (
        // 64b-3: the whole title, the URL and the length, 6px above the stack,
        // as wide as the tab.
        <BrowserHoverCard
          title={shown.title || shown.url}
          lines={[shown.url, `${chars} char${chars === 1 ? '' : 's'} selected`]}
          className="left-[10px] right-[10px]"
          style={{ bottom: `calc(100% + ${stackPx + HOVER_GAP_PX - IDE_SLOT_OVERLAP_PX}px)` }}
        />
      )}
    </>
  )
}
