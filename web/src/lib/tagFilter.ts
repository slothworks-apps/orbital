/** A tag filter's selection with `tagId` added, or taken out if it was in. Empty means All. */
export function toggleTag(selected: number[], tagId: number): number[] {
  return selected.includes(tagId) ? selected.filter((id) => id !== tagId) : [...selected, tagId]
}
