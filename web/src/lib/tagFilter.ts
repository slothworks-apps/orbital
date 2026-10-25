/** A tag filter's selection with `tagId` added, or taken out if it was in. Empty means every session. */
export function toggleTag(selected: number[], tagId: number): number[] {
  return selected.includes(tagId) ? selected.filter((id) => id !== tagId) : [...selected, tagId]
}

/**
 * `tags` with `tagId` taken out and put back at `toIndex` (clamped), or the
 * same array when that changes nothing — so a drop on its own slot saves nothing.
 */
export function moveTagTo<T extends { id: number }>(tags: T[], tagId: number, toIndex: number): T[] {
  const from = tags.findIndex((t) => t.id === tagId)
  if (from < 0) return tags
  const to = Math.max(0, Math.min(tags.length - 1, toIndex))
  if (to === from) return tags
  const next = [...tags]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * The index `moveTagTo` wants for a tag dropped into gap `slot` (0 = before
 * the first tag, `length` = after the last). Gaps on the far side of the
 * dragged tag count one less, since taking it out shifts them back.
 */
export function slotToIndex(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot
}
