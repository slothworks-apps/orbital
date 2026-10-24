import { useId, useRef } from 'react'
import { MenuPopup } from './Menu'
import type { MenuEntry } from './Menu'
import type { PopupAnchor } from './usePopupPosition'

export interface ContextMenuProps {
  /** Where the pointer was, in viewport px — the menu's top-left corner when it fits there. */
  at: { x: number; y: number }
  entries: readonly MenuEntry[]
  /** The menu's accessible name. */
  'aria-label': string
  onClose: () => void
  /** Pin the popup's width, as `MenuButton`'s `widthPx`. */
  widthPx?: number
  /** Names the rows on show; changing it swaps them in place (`MenuPopup`'s `view`). */
  view?: string
}

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
export function ContextMenu({ at, entries, onClose, widthPx, view, ...aria }: ContextMenuProps) {
  const id = useId()
  const { x, y } = at
  const anchorRef = useRef<PopupAnchor | null>(null)
  anchorRef.current = { getBoundingClientRect: () => pointRect(x, y) }
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
      position={{ gap: 0, align: 'left' }}
      widthPx={widthPx}
      initial="first"
      view={view}
      onClose={close}
    />
  )
}
