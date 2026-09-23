import { cloneElement, useEffect, useId, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { useEscapeLayer } from './escapeLayer'

interface TooltipBase {
  /** Mono first line — the exact name of the thing. */
  title: string
  /**
   * Which edge of the trigger the bubble hangs from. A trigger at the right
   * end of a 450px panel with a bubble aligned to its LEFT edge puts the
   * bubble off the panel.
   */
  align?: 'left' | 'right'
  /**
   * How long the pointer must rest on the trigger before the bubble appears.
   * Keyboard focus ignores it — focusing a control is already deliberate,
   * while a pointer crosses controls on its way somewhere else.
   */
  delayMs?: number
  /** The trigger. Must accept a ref-less `aria-describedby` prop. */
  children: ReactElement<{ 'aria-describedby'?: string }>
}

/**
 * `card` is the two-line bubble of artboard 2d — a name over a sentence.
 * `name` is the smaller single-line shell the git reading hangs under
 * (`Feature - Git worktree` 1f): the same panel fill and border, tighter, and
 * carrying nothing but the name that did not fit on the row.
 */
export type TooltipProps =
  | (TooltipBase & {
      variant?: 'card'
      /** Second line, one sentence. */
      description: string
    })
  | (TooltipBase & {
      variant: 'name'
      /** A one-line bubble says only its title. */
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
export function Tooltip({
  title,
  description,
  variant = 'card',
  align = 'left',
  delayMs = 0,
  children,
}: TooltipProps) {
  const id = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const open = (hovered || focused) && !dismissed
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

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => {
        if (delayMs <= 0) {
          setHovered(true)
          return
        }
        cancelHover()
        hoverTimer.current = setTimeout(() => setHovered(true), delayMs)
      }}
      onMouseLeave={() => {
        cancelHover()
        setHovered(false)
        if (!focused) setDismissed(false)
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        setDismissed(false)
      }}
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
            'orbital-tooltip-in',
            'absolute top-full z-20 mt-2 w-max border',
            'border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)]',
            // 1f draws the one-line shell tighter and with a softer drop than
            // 2d's card, because it hangs off a text row rather than a control.
            variant === 'name'
              ? 'max-w-[300px] rounded-[7px] px-2 py-[5px] shadow-[0_10px_26px_rgba(0,0,0,.5)]'
              : 'max-w-[340px] rounded-[9px] px-3 py-[9px] shadow-[0_16px_40px_rgba(0,0,0,.55)]',
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
                : 'block font-mono text-[11.5px] text-text-bright'
            }
          >
            {title}
          </span>
          {variant === 'card' && (
            <span className="mt-1 block text-[11.5px] leading-[1.45] text-[rgba(160,190,225,.8)] [text-wrap:pretty]">
              {description}
            </span>
          )}
        </span>
      )}
    </span>
  )
}
