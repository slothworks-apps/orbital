/**
 * Pure ordering for the Desk theme (spec 2026-10-01-map-themes-design § 4,
 * ADR `desk-mats-order-by-tag-anchors`): mats follow the tag anchors the map
 * already stores, and moving a mat writes a new anchor between its new
 * neighbours — so what sits left on the map sits left on the desk.
 */

export interface MatAnchor {
  tagId: number
  x: number
  y: number
}

/** Mats left to right: by anchor x, then top to bottom (world y points up), then tag id. */
export function matOrder<T extends MatAnchor>(anchors: T[]): T[] {
  return [...anchors].sort((a, b) => a.x - b.x || b.y - a.y || a.tagId - b.tagId)
}

/**
 * The anchor to store for the mat at `from` dropped at slot `to` of `ordered`
 * (indices into the list before the move). Its x lands halfway between its
 * new neighbours, or one spacing past the end it moved to; its y is kept, so
 * the planet cluster moves sideways only. Null when the mat does not move.
 */
export function anchorForMatMove(
  ordered: MatAnchor[],
  from: number,
  to: number,
): { x: number; y: number } | null {
  if (from === to || from < 0 || from >= ordered.length) return null
  const moving = ordered[from]
  const rest = ordered.filter((_, i) => i !== from)
  const slot = Math.max(0, Math.min(rest.length, to > from ? to - 1 : to))
  const xs = ordered.map((a) => a.x)
  const spacing =
    xs.length > 1 ? Math.max(1, (Math.max(...xs) - Math.min(...xs)) / (xs.length - 1)) : 10
  const left = rest[slot - 1]
  const right = rest[slot]
  let x: number
  if (left && right) x = (left.x + right.x) / 2
  else if (right) x = right.x - spacing
  else if (left) x = left.x + spacing
  else return null
  return { x, y: moving.y }
}

/**
 * Where a mat dragged `dx` px sideways from slot `from` would land, for a row
 * of `count` mats a `step` px apart: `slot` is its index among the other
 * mats (where the placeholder goes), `to` is the same spot in the
 * `anchorForMatMove` sense. Null while it has not moved a whole slot.
 */
export function matDropSlot(
  from: number,
  dx: number,
  count: number,
  step: number,
): { slot: number; to: number } | null {
  const slot = Math.max(0, Math.min(count - 1, from + Math.round(dx / step)))
  if (slot === from) return null
  return { slot, to: slot > from ? slot + 1 : slot }
}

/** Cards inside a mat: by session id, so they never reshuffle as their states change. */
export function cardOrder<T extends { session: { id: string } }>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0,
  )
}
