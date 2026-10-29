import type { DropSlot } from '../lib/dropSlot'

/**
 * Where a dragged item will land (canvas `Feature - Tag chips` 80e): a 2 px
 * bar in body ink at 85 %, upright between chips or flat between cards.
 * Positioned in the list that `dropSlot` measured against.
 */
export function DropBar({ bar }: { bar: DropSlot['bar'] }) {
  const upright = bar.width === 0
  return (
    <span
      aria-hidden
      data-drop-bar
      className="pointer-events-none absolute block rounded-[1px] bg-ink-200/85"
      style={
        upright
          ? { left: bar.x, top: bar.y, width: 2, height: bar.height, marginLeft: -1 }
          : { left: bar.x, top: bar.y, width: bar.width, height: 2, marginTop: -1 }
      }
    />
  )
}
