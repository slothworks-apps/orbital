import { useId, useRef } from 'react'
import { MenuPopup } from './Menu'
import type { MenuEntry } from './Menu'
import type { PopupAnchor } from './usePopupPosition'

export interface ContextMenuProps {
  /**
   * Where the pointer was, in viewport px — the menu's top-left corner when it
   * fits there. Or an element the menu hangs under, its left edge lined up
   * with the element's, `UNDER_GAP_PX` below it: the bare-name chooser opened
   * by a press, which has no pointer point to keep (canvas `Feature - Path
   * menu glyphs` 1c, "anchored under the chip").
   */
  at: { x: number; y: number } | Element
  entries: readonly MenuEntry[]
  /** The menu's accessible name. */
  'aria-label': string
  onClose: () => void
  /** Pin the popup's width, as `MenuButton`'s `widthPx`. */
  widthPx?: number
  /** A floor under the popup's content width. */
  minWidthPx?: number
  /** Rows past which the list scrolls (`MenuPopup`'s `maxRows`). */
  maxRows?: number
  /** Names the rows on show; changing it swaps them in place (`MenuPopup`'s `view`). */
  view?: string
  /** Leave focus where it is (`MenuPopup`'s `keepsFocus`). */
  keepsFocus?: boolean
  /** ⌫ or ← puts the earlier rows back (`MenuPopup`'s `onBack`). */
  onBack?: () => void
}

/** Element to the menu hanging under it (canvas `Feature - Path menu glyphs` 1a: the chip's bottom + 6). */
const UNDER_GAP_PX = 6

/** A zero-size rect at a point. Built by hand: jsdom has no `DOMRect` constructor to lean on. */
function pointRect(x: number, y: number): DOMRect {
  return { x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0, toJSON: () => ({ x, y }) }
}

/**
 * A menu opened by a right-click (spec 2026-10-24-session-context-menu-design):
 * `MenuButton`'s open menu — the same rows, keys, escape layer and outside-press
 * dismissal (`MenuPopup`) — anchored to the pointer instead of a trigger. The
 * point is a zero-size anchor, so `usePopupPosition` opens the menu below and
 * to the right of it and flips it at the window's edges as it flips any popup.
 *
 * Rendered by its owner only while open; a right-click elsewhere is a new
 * opening, so the owner keys it on the point. Closing hands focus back to
 * whatever held it before the menu took it.
 */
export function ContextMenu({ at, entries, onClose, widthPx, minWidthPx, maxRows, view, onBack, keepsFocus, ...aria }: ContextMenuProps) {
  const id = useId()
  const anchorRef = useRef<PopupAnchor | null>(null)
  const under = at instanceof Element
  if (at instanceof Element) anchorRef.current = at
  else {
    const { x, y } = at
    anchorRef.current = { getBoundingClientRect: () => pointRect(x, y) }
  }
  // Read during render, once: by the first layout effect focus is in the menu.
  const before = useRef<Element | null | undefined>(undefined)
  if (before.current === undefined) before.current = document.activeElement

  // `MenuPopup` keeps the latest of this itself.
  const close = (restoreFocus: boolean) => {
    const back = before.current
    onClose()
    if (restoreFocus && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true })
  }

  return (
    <MenuPopup
      id={id}
      aria-label={aria['aria-label']}
      entries={entries}
      anchorRef={anchorRef}
      // At the pointer itself: the menu starts where the click was.
      position={{ gap: under ? UNDER_GAP_PX : 0, align: 'left', minWidth: minWidthPx }}
      widthPx={widthPx}
      maxRows={maxRows}
      initial="first"
      view={view}
      keepsFocus={keepsFocus}
      onBack={onBack}
      onClose={close}
    />
  )
}
