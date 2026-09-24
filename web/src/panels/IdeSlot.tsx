import { useRef, useState } from 'react'
import {
  elideFileName,
  fileNameOf,
  lipParts,
  selectionId,
  selectionTooltip,
} from '../lib/ideSelection'
import { usePresence } from '../ui/usePresence'
import type { IdeReadout } from '../lib/useIdeReadout'
import type { IdeSelection } from '../lib/types'

/**
 * The editor slot on the composer well's edge (spec:
 * 2026-09-23-ide-bridge-design § The slot and the lip; canvas
 * `Feature - IDE bridge` 20a/20b, placement C of 20e, values from 20f).
 *
 * The distinction the design draws is the one this component is built around:
 *
 * - **a chip is something you put there** — an attachment you chose, which
 *   uploads and can fail. That is `AttachmentChip`, and it lives IN the well;
 * - **a lip is something the world put there** — ambient state that arrives and
 *   leaves on its own. That is this, and it lives ON the well's edge.
 *
 * So it is an overlay: nothing reflows when it comes or goes, and mid-typing
 * the text and the caret are untouched (20b-5). Three states:
 *
 * - no editor, an editor on another project, or an editor that has not yet said
 *   where the caret is — nothing at all, and the panel is shipped 9a exactly
 *   (20b-1). The canvas ties the slot to the connection; it is tied here to
 *   having a reading, because `selection_changed` does not fire until the caret
 *   moves and a slot with no file name in it is a row that says nothing;
 * - cursor only — a read-out of the file and line, nothing to refuse (20b-2);
 * - a selection — the count, the file and a × that drops it (20b-3).
 *
 * Both sit in the same tab-shaped card; only its contents cross-fade.
 */

/** 20f: slot height 26px, inset 10px each side, a 1px overlap onto the well. */
const SLOT_HEIGHT_PX = 26
const SLOT_OVERLAP_PX = 1

/**
 * What the slot occupies above the well. The composer's completion popup adds
 * it to its own gap so that it clears both (canvas 20c: "the slot belongs to
 * the well, so the popup clears both").
 */
export const IDE_SLOT_HEIGHT_PX = SLOT_HEIGHT_PX

/**
 * 20f: the slot slides up from behind the well's edge in .26s on the export's
 * panel curve, and sinks back the same way; the lip rises out of the well over
 * the cursor line in .22s, and the two read-outs cross-fade in 120ms (20b-5).
 */
const SLIDE_MS = 260
const CROSSFADE_MS = 120

/** 20b-2: hovering the file name shows the whole path after a beat. */
const TOOLTIP_DELAY_MS = 350

export interface IdeSlotProps {
  /**
   * The editor's name as the lock reports it, or null when there is no editor
   * on this directory. Presentational on purpose: the readout's two rates run
   * in `Composer`, which needs the same answer for its hint line, and running
   * the hook twice would run two independent debounces over one stream.
   */
  ideName: string | null
  /** Where the caret is and what is selected, already throttled and debounced. */
  readout: IdeReadout
  /** Whether the lip is up — false once this session's × has dropped it. */
  standing: boolean
  /** The lip's ×. Per session, never per workspace (spec § Behaviour). */
  onDismiss: (selectionId: string) => void
}

export function IdeSlot({ ideName, readout, standing, onDismiss }: IdeSlotProps) {
  const { cursor, lip } = readout
  const [hovered, setHovered] = useState(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // An editor being open is not by itself something to say. `selection_changed`
  // only fires when the caret moves, so between connecting and the first click
  // in the editor there is no reading at all — and a slot holding a caret
  // glyph, a blank where the file name goes and the editor's name on the right
  // is a row that has nothing to tell you. The slot therefore rides on having a
  // reading, not on the connection: it slides up when the editor first says
  // where the caret is, and back down when the editor goes.
  const { mounted, state } = usePresence(ideName !== null && cursor !== null, SLIDE_MS, SLIDE_MS)

  // The editor that quit is still on screen for the length of the sink, so the
  // last name and the last reading are both held — reading the live values
  // alone would empty the row in the same frame and the slot would blink out,
  // or sink as an empty box, instead of going back down with what it said.
  const last = useRef<{ name: string | null; cursor: IdeSelection | null }>({
    name: ideName,
    cursor,
  })
  if (ideName) last.current.name = ideName
  if (cursor) last.current.cursor = cursor
  const shownName = ideName ?? last.current.name
  const shownCursor = cursor ?? last.current.cursor

  if (!mounted || !shownName || !shownCursor) return null

  const hidden = state !== 'entered'
  const reading = standing && lip ? lip : shownCursor
  const tooltip = reading ? selectionTooltip(reading) : null

  const armTooltip = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHovered(true), TOOLTIP_DELAY_MS)
  }
  const dropTooltip = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
    hoverTimer.current = null
    setHovered(false)
  }

  return (
    <div
      data-ide-slot
      data-state={standing ? 'selection' : 'cursor'}
      // 20a in situ: a box one pixel INTO the well (the lip's overlap), the
      // slot's own height tall, clipped — which is what makes the slide read as
      // "from behind the edge".
      //
      // `bottom: 100%` IS that overlap: an absolute box is placed against the
      // well's padding box, so its last row lands on the well's border, which
      // is SLOT_OVERLAP_PX wide. Subtracting the overlap again would drop the
      // cursor line's opaque fill onto that border and erase it.
      //
      // The clip is put HERE rather than anywhere further out on purpose: the
      // completion popup hangs off this same well and dies inside any clipping
      // ancestor (web/CLAUDE.md). It is portalled to <body>, so this box is not
      // one of its ancestors — but a clip on the well, or on the composer's
      // root, would have been.
      style={{
        height: `${SLOT_HEIGHT_PX + SLOT_OVERLAP_PX}px`,
        bottom: '100%',
      }}
      className="pointer-events-none absolute left-0 right-0 overflow-hidden"
    >
      <div
        // 20f: translateY 100% → 0, .26s cubic-bezier(.2,.8,.2,1) — the
        // export's panel curve, the one every surface in the app decelerates
        // on. Written as a style rather than utilities because Tailwind cannot
        // build a class from a runtime duration, and one property at a time
        // cannot be resolved by stylesheet order (web/CLAUDE.md).
        style={{
          transform: hidden ? 'translateY(100%)' : 'translateY(0)',
          opacity: hidden ? 0 : 1,
          transition: `transform ${SLIDE_MS}ms cubic-bezier(.2,.8,.2,1), opacity 200ms ease`,
        }}
        className="motion-reduce:!transition-none absolute inset-0"
      >
        {/* One card for both states. 20b-2 draws the cursor line bare and
            only the lip as a tab; Tomin chose the tab for both (2026-09-24),
            because a line that gains a frame the moment you select something
            read as two different components. So the frame stands still and
            only what is in it cross-fades (20b-5's timing).

            20b-3 / 20f: .05 fill over the panel ground, a .14 hairline, 8px top
            radius, bottom open onto the well, inset 10px each side. Anchored to
            the bottom so the negative margin pushes it over the well's border,
            which is what opens it onto the well; from `top-0` the margin does
            nothing. The fill is two utilities because a colour inside a
            `bg-[...]` gradient list makes the whole value an invalid
            `background-color`, and the card renders see-through — with the
            composer's hairline rule drawn straight through the file name. */}
        <div
          style={{
            height: `${SLOT_HEIGHT_PX}px`,
            marginBottom: `-${SLOT_OVERLAP_PX}px`,
          }}
          className={[
            'absolute inset-x-0 bottom-0 box-border mx-[10px]',
            'rounded-t-[8px] border border-b-0 border-[rgba(150,205,255,.14)]',
            'bg-[#070b16] bg-[image:linear-gradient(rgba(150,205,255,.05),rgba(150,205,255,.05))]',
            'font-mono text-[10.5px]',
          ].join(' ')}
        >
          <div
            aria-hidden={standing}
            style={{
              opacity: standing ? 0 : 1,
              transition: `opacity ${CROSSFADE_MS}ms ease`,
            }}
            // 20b-2 / 20f: ink rgba(160,190,225,.55), nothing to refuse. The
            // right padding matches the left, there being no × to make room for.
            className="motion-reduce:!transition-none absolute inset-0 flex items-center gap-2 whitespace-nowrap px-[10px] text-[rgba(160,190,225,.55)]"
          >
            {/* 20f: the caret glyph, 1.4×11px at .55 — the same bar the active
                tab wears in the completion list, so one glyph means "the cursor
                is here" in both places. */}
            <span
              aria-hidden
              className="block h-[11px] w-[1.4px] flex-none rounded-[1px] bg-[rgba(160,190,225,.55)]"
            />
            {/* `shownCursor`, not `cursor`: the row has to keep saying what it
                said while it sinks back out of view. */}
            <span className="text-[rgba(200,220,245,.75)]">
              {elideFileName(fileNameOf(shownCursor.filePath))}
            </span>
            <span>:{shownCursor.lineStart}</span>
            <span aria-hidden className="flex-1" />
            <span className="text-[rgba(160,190,225,.45)]">{shownName}</span>
          </div>

          {lip && (
            <div
              aria-hidden={!standing}
              style={{
                opacity: standing ? 1 : 0,
                transition: `opacity ${CROSSFADE_MS}ms ease`,
              }}
              className={[
                'motion-reduce:!transition-none absolute inset-0 flex items-center gap-2 whitespace-nowrap',
                'pl-[10px] pr-[5px] text-[rgba(200,220,245,.75)]',
                standing ? 'pointer-events-auto' : 'pointer-events-none',
              ].join(' ')}
            >
              {/* 20f: the lines glyph — three bars 10/7/9 long, 1.6px thick. */}
              <span aria-hidden className="relative block h-[9px] w-[10px] flex-none">
                <span className="absolute left-0 top-0 h-[1.6px] w-[10px] rounded-[1px] bg-[rgba(160,190,225,.6)]" />
                <span className="absolute left-0 top-[3.7px] h-[1.6px] w-[7px] rounded-[1px] bg-[rgba(160,190,225,.6)]" />
                <span className="absolute left-0 top-[7.4px] h-[1.6px] w-[9px] rounded-[1px] bg-[rgba(160,190,225,.6)]" />
              </span>
              <span
                className="min-w-0 truncate"
                // 20b-2: the whole path and the lines, after a beat. `title` is
                // the browser's own delay-then-show, which is the behaviour the
                // canvas draws without adding a second tooltip implementation.
                title={hovered && tooltip ? tooltip : undefined}
                onMouseEnter={armTooltip}
                onMouseLeave={dropTooltip}
              >
                Selected <span className="text-[#e8eef8]">{lipParts(lip).amount}</span> from{' '}
                <span className="text-[#dfeeff]">{elideFileName(lipParts(lip).file)}</span>
              </span>
              <span aria-hidden className="flex-1" />
              <span className="text-[rgba(160,190,225,.45)]">{shownName}</span>
              <button
                type="button"
                // The lip's × is a statement about THIS conversation, not about
                // the workspace — every other session in it keeps the selection.
                aria-label="Drop the editor selection from this session"
                onClick={() => onDismiss(selectionId(lip))}
                // 20b-3 / 20f: 18px, no border at rest — the lip already has
                // one — gaining the .3 hairline on hover, the only hover here.
                className="grid h-[18px] w-[18px] flex-none place-items-center rounded-[5px] border border-transparent text-[11px] leading-none text-[rgba(200,220,245,.7)] hover:border-[rgba(150,205,255,.3)] focus-visible:border-[rgba(150,205,255,.3)] focus-visible:outline-none"
              >
                ×
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
