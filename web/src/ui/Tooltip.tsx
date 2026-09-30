import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeLayer } from './escapeLayer'
import { shortcutLabel } from '../lib/keymap'

interface TooltipBase {
  /**
   * The id of the keymap command the trigger fires, printed muted after the
   * title (`End session  ⌘⌫`). A control that can be reached from the
   * keyboard says so where the pointer already is, which is how the binding
   * gets learned; the pane in Settings is the index, not the teacher.
   */
  shortcut?: string
  /**
   * Which edge of the trigger the bubble hangs from. A trigger at the right
   * end of a 450px panel with a bubble aligned to its LEFT edge puts the
   * bubble off the panel.
   */
  align?: 'left' | 'right'
  /**
   * Whether the bubble drops below the trigger or rises above it. Above is for
   * triggers at the bottom of the window — the composer's row — where a
   * bubble below would fall off the screen.
   */
  side?: 'below' | 'above'
  /**
   * How long the pointer must rest on the trigger before the bubble appears.
   * Keyboard focus ignores it — focusing a control is already deliberate,
   * while a pointer crosses controls on its way somewhere else.
   */
  delayMs?: number
  /**
   * What the bubble hangs from. `trigger` is the trigger itself; `group` is
   * the nearest positioned ancestor, for a trigger that belongs to a group the
   * canvas aligns the bubble to — the detach control's tooltip sits under the
   * detach · close pair, flush with its right edge (canvas `Feature - Detached
   * window` 22a). The caller makes that ancestor `relative`.
   */
  anchor?: 'trigger' | 'group'
  /**
   * Keeps the bubble down while the trigger's own popover is open — the
   * popover already says what the bubble would, and they would overlap.
   */
  suppressed?: boolean
  /** The trigger. Must accept a ref-less `aria-describedby` prop. */
  children: ReactElement<{ 'aria-describedby'?: string }>
}

/**
 * `card` is the two-line bubble of artboard 2d — a name over a sentence.
 * `name` is the smaller single-line shell the git reading hangs under
 * (`Feature - Git worktree` 1f): the same panel fill and border, tighter, and
 * carrying nothing but the name that did not fit on the row.
 * `panel` is the fixed-width shell the header's pull request and line
 * changes explain themselves in (`Feature - Branch status` 1e): rows the
 * caller lays out, where a title and a sentence are not enough.
 */
export type TooltipProps =
  | (TooltipBase & {
      variant?: 'card'
      /** Mono first line — the exact name of the thing. */
      title: string
      /** Second line, one sentence. */
      description: string
    })
  | (TooltipBase & {
      variant: 'name'
      /** Mono first line — the exact name of the thing. */
      title: string
      /** A one-line bubble says only its title. */
      description?: never
    })
  | (TooltipBase & {
      variant: 'panel'
      /** The bubble's rows. */
      content: ReactNode
      /**
       * The box the bubble must stay inside (1h: "clamped to the panel"). Its
       * left edge sits on the trigger until that would carry its right edge
       * past this box's.
       */
      clampWithin?: () => HTMLElement | null
      title?: never
      description?: never
    })

/**
 * Two-line hover/focus tooltip, per artboard 2d of
 * `Feature - Permission mode dots.dc.html`.
 *
 * Not the native `title`: that never appears on keyboard focus, and it cannot
 * carry the mono-name-over-description shape the canvas draws. The acceptance
 * for the permission-mode readout asks for both.
 *
 * The bubble is positioned inside a `relative` wrapper rather than portalled.
 * Nothing that hosts a tooltip clips its overflow, so a portal would buy only
 * z-index bookkeeping.
 *
 * ESCAPE is claimed only when the tooltip was opened by KEYBOARD FOCUS.
 * `useEscapeLayer` makes its holder the single recipient of the keystroke, so
 * a tooltip that registered on hover would silently eat the Escape meant for
 * the dialog underneath the pointer. A keyboard user, by contrast, has no
 * other way to put it away.
 */
export function Tooltip(props: TooltipProps) {
  const {
    shortcut,
    variant = 'card',
    align = 'left',
    side = 'below',
    delayMs = 0,
    anchor = 'trigger',
    suppressed = false,
    children,
  } = props
  const id = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const open = (hovered || focused) && !dismissed && !suppressed
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelHover = () => {
    if (hoverTimer.current === null) return
    clearTimeout(hoverTimer.current)
    hoverTimer.current = null
  }

  // A trigger that unmounts while the timer is still counting must not open a
  // tooltip on a node that is gone.
  useEffect(() => cancelHover, [])

  useEscapeLayer(open && focused, () => setDismissed(true))

  const triggerEvents = {
    onMouseEnter: () => {
      if (delayMs <= 0) {
        setHovered(true)
        return
      }
      cancelHover()
      hoverTimer.current = setTimeout(() => setHovered(true), delayMs)
    },
    onMouseLeave: () => {
      cancelHover()
      setHovered(false)
      if (!focused) setDismissed(false)
    },
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false)
      setDismissed(false)
    },
  }

  // The panel bubble's left offset from its trigger, measured once it is up.
  const wrapper = useRef<HTMLSpanElement | null>(null)
  const [panelLeft, setPanelLeft] = useState(-PANEL_INSET_PX)
  const clampWithin = props.variant === 'panel' ? props.clampWithin : undefined
  useLayoutEffect(() => {
    if (!open || !clampWithin || !wrapper.current) return
    const bounds = clampWithin()?.getBoundingClientRect()
    if (!bounds) return
    const trigger = wrapper.current.getBoundingClientRect().left
    const left = Math.max(bounds.left - PANEL_INSET_PX, Math.min(trigger - PANEL_INSET_PX, bounds.right - PANEL_WIDTH_PX))
    setPanelLeft(left - trigger)
  }, [open, clampWithin])

  if (props.variant === 'panel') {
    return (
      <span
        ref={wrapper}
        className="relative inline-flex"
        {...triggerEvents}
      >
        {cloneElement(children, { 'aria-describedby': open ? id : undefined })}
        {open && (
          <span
            role="tooltip"
            id={id}
            style={{ left: panelLeft }}
            className={['orbital-tooltip-in orbital-no-drag absolute top-full z-20 mt-2', PANEL_CLASS].join(' ')}
          >
            {props.content}
          </span>
        )}
      </span>
    )
  }
  const { title, description } = props

  return (
    <span
      className={anchor === 'trigger' ? 'relative inline-flex' : 'inline-flex'}
      {...triggerEvents}
    >
      {cloneElement(children, { 'aria-describedby': open ? id : undefined })}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={[
            // 2d: 9px radius, flat panel fill, 340px cap, dropped below the
            // trigger with an 8px gap.
            // 4d: it arrives rather than blinks on — the last few pixels of
            // travel are what make a delayed bubble read as an answer to the
            // pointer resting, not as a flicker.
            side === 'above' ? 'orbital-tooltip-up bottom-full mb-2' : 'orbital-tooltip-in top-full mt-2',
            'orbital-no-drag absolute z-20',
            BUBBLE_SHELL_CLASS,
            // 1f draws the one-line shell tighter and with a softer drop than
            // 2d's card, because it hangs off a text row rather than a control.
            variant === 'name'
              ? 'max-w-[300px] rounded-[7px] px-2 py-[5px] shadow-[0_10px_26px_rgba(0,0,0,.5)]'
              : CARD_CLASS,
            align === 'right' ? 'right-0' : 'left-0',
          ].join(' ')}
        >
          {/* In a card the trigger's own accessible name already says this
              much, so the line is decoration for the eye and noise for a
              screen reader. A one-line bubble is the opposite case: it exists
              because the trigger's text was cut, so it is the only place the
              whole name is readable. */}
          <span
            aria-hidden={variant === 'card' || undefined}
            className={
              variant === 'name'
                ? // 1f draws this line as `nowrap`, which it can afford for the
                  // names it shows. A real branch can run to eighty-odd
                  // characters, and nowrap puts the bubble outside the panel
                  // it is meant to explain — so it wraps inside the cap above,
                  // breaking mid-name only when a name has nowhere else to break.
                  //
                  // `whitespace-normal` is stated rather than assumed: this
                  // bubble hangs off a row that sets `nowrap`, and inheriting
                  // it caps the box at 300px while the text runs straight out
                  // the side.
                  'block whitespace-normal font-mono text-[11px] text-text-bright [overflow-wrap:anywhere]'
                : CARD_TITLE_CLASS
            }
          >
            {title}
            {shortcut && (
              <span className={SHORTCUT_CLASS}>
                {shortcutLabel(shortcut)}
              </span>
            )}
          </span>
          {variant === 'card' && <span className={CARD_DESCRIPTION_CLASS}>{description}</span>}
        </span>
      )}
    </span>
  )
}

const BUBBLE_SHELL_CLASS = 'w-max border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)]'
/** `Feature - Branch status` 1h: the End-session tooltip's shell at a fixed width, rows laid out by the caller. */
const PANEL_WIDTH_PX = 264
/** 1a: the bubble's left edge sits this far left of its trigger's, so its padding lines up with the text. */
const PANEL_INSET_PX = 6
const PANEL_CLASS =
  'box-border flex w-[264px] flex-col gap-[9px] whitespace-normal rounded-lg border border-[rgba(150,205,255,.2)] bg-[rgba(10,16,28,.96)] px-3 py-2.5 text-left shadow-[0_10px_26px_rgba(0,0,0,.5)]'
const CARD_CLASS = 'max-w-[340px] rounded-[9px] px-3 py-[9px] shadow-[0_16px_40px_rgba(0,0,0,.55)]'
const CARD_TITLE_CLASS = 'block font-mono text-[11.5px] text-text-bright'
const SHORTCUT_CLASS = 'ml-2 whitespace-nowrap text-[rgba(160,190,225,.55)]'
const CARD_DESCRIPTION_CLASS =
  'mt-1 block text-[11.5px] leading-[1.45] text-[rgba(160,190,225,.8)] [text-wrap:pretty]'

/** The gap between a floating card and the run it explains — 2d's 8px. */
const FLOATING_GAP_PX = 8
/** Keeps a floating card's right edge off the window's. */
const FLOATING_EDGE_PX = 8
/** `CARD_CLASS`'s width cap, for the right-edge clamp. */
const FLOATING_MAX_WIDTH_PX = 340

/**
 * The 2d card hung above a rectangle rather than wrapped around a React
 * trigger — for a run of text some other renderer owns, like a token the
 * composer's editor paints as a decoration (spec:
 * 2026-09-30-skill-preview-design). Portalled and `fixed`, because the
 * composer's field scrolls and clips; the caller owns the hover timing and
 * passes the run's rect.
 *
 * Pointer-transparent: it describes the run under it and is never itself a
 * target, so moving onto it cannot flicker the hover it answers.
 */
export function FloatingTooltip({
  title,
  aside,
  description,
  rect,
}: {
  title: string
  /** Muted after the title, where `Tooltip` prints its shortcut. */
  aside?: string
  description?: string
  rect: DOMRect
}) {
  const left = Math.max(
    FLOATING_EDGE_PX,
    Math.min(rect.left, window.innerWidth - FLOATING_MAX_WIDTH_PX - FLOATING_EDGE_PX),
  )
  return createPortal(
    <span
      role="tooltip"
      style={{ left, bottom: window.innerHeight - rect.top + FLOATING_GAP_PX }}
      className={[
        'orbital-tooltip-up pointer-events-none fixed z-50 block',
        BUBBLE_SHELL_CLASS,
        CARD_CLASS,
      ].join(' ')}
    >
      <span className={CARD_TITLE_CLASS}>
        {title}
        {aside && <span className={SHORTCUT_CLASS}>{aside}</span>}
      </span>
      {description && <span className={CARD_DESCRIPTION_CLASS}>{description}</span>}
    </span>,
    document.body,
  )
}
