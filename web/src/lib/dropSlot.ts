/** An item's box, relative to the list it sits in. */
export interface SlotRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Where a dragged item would land, and the bar that marks the gap. */
export interface DropSlot {
  /** The gap: 0 is before the first item, `rects.length` after the last. */
  slot: number
  bar: { x: number; y: number; width: number; height: number }
}

/**
 * The gap under the pointer (canvas `Feature - Tag chips` 80a, 80d).
 *
 * `row` is a wrapping chip row: the pointer picks the line it is on (or the
 * nearest one), then the first chip on that line whose middle lies to its
 * right; past the last chip it is the gap after it. The bar stands upright
 * `inset` px before that chip — half the row's gap, so it sits in the gap.
 *
 * `column` is a list of cards: the first card whose middle lies below the
 * pointer, or after the last one. The bar lies flat `inset` px above it.
 */
export function dropSlot(rects: SlotRect[], x: number, y: number, axis: 'row' | 'column', inset: number): DropSlot | null {
  const n = rects.length
  if (n === 0) return null
  if (axis === 'column') {
    let slot = rects.findIndex((r) => y < (r.top + r.bottom) / 2)
    if (slot < 0) slot = n
    const first = rects[0]
    const barY = slot < n ? rects[slot].top - inset : rects[n - 1].bottom + inset
    return { slot, bar: { x: first.left, y: barY, width: first.right - first.left, height: 0 } }
  }
  const mid = (r: SlotRect) => (r.top + r.bottom) / 2
  const ref =
    rects.find((r) => y >= r.top && y <= r.bottom) ??
    rects.reduce((a, b) => (Math.abs(mid(b) - y) < Math.abs(mid(a) - y) ? b : a))
  const line = rects.map((r, k) => ({ r, k })).filter(({ r }) => Math.abs(r.top - ref.top) < 2)
  const hit = line.find(({ r }) => x < (r.left + r.right) / 2)
  if (hit) {
    return { slot: hit.k, bar: { x: hit.r.left - inset, y: hit.r.top, width: 0, height: hit.r.bottom - hit.r.top } }
  }
  const last = line[line.length - 1]
  return { slot: last.k + 1, bar: { x: last.r.right + inset, y: last.r.top, width: 0, height: last.r.bottom - last.r.top } }
}

/** A gap either side of the dragged item puts it back where it was. */
export function movesItem(from: number, slot: number): boolean {
  return slot !== from && slot !== from + 1
}
