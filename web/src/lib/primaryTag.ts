import type { Tag } from './types'

/**
 * The one tag a session wears: its first id that still names a tag, else the
 * default tag — the same pick as the map's clusters (`map/layout.ts`), so a
 * row's hue matches the session's planet. `tagIds` stays an array because
 * that is the wire shape, but a session carries a single tag (canvas 1b).
 * Shared by the phone's list and screens, the detail header, the subagent
 * panel and the context menu.
 */
export function primaryTag(tagIds: readonly number[], tags: readonly Tag[]): Tag | undefined {
  for (const id of tagIds) {
    const tag = tags.find((t) => t.id === id)
    if (tag) return tag
  }
  return tags.find((t) => t.is_default === 1)
}
