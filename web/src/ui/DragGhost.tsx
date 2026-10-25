import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ReorderDrag } from './useReorderDrag'

/**
 * The lifted copy that follows the pointer while an item is dragged (canvas
 * `Feature - Tag chips` 80e). Drawn on the body, `fixed`, so no scrolling
 * list or `overflow-hidden` panel it leaves can clip it.
 */
export function DragGhost({ ghost, fullWidth = false, children }: {
  ghost: ReorderDrag['ghost']
  /** Takes the dragged item's width — a card; a chip sizes itself. */
  fullWidth?: boolean
  children: ReactNode
}) {
  return createPortal(
    <div
      aria-hidden
      data-drag-ghost
      className="pointer-events-none fixed z-[1000] flex"
      style={{ left: ghost.x, top: ghost.y, width: fullWidth ? ghost.width : undefined }}
    >
      {children}
    </div>,
    document.body,
  )
}
