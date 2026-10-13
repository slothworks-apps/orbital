import type { AllMediaItem } from './types'
import { mediaTiles, type MediaTile } from './media'

/**
 * The pure half of the gallery of every session (spec
 * 2026-10-13-all-sessions-gallery-design): the tag filter's clicks, how a
 * page joins the ones before it, and how the grid groups the items by
 * session. The desktop's overlay and the phone's screen read the same answers.
 *
 * The server lists sessions by recency and each session's items newest first,
 * so one session's items arrive together, possibly split across pages.
 */

/** A plain click keeps only that tag; ⌘-click (or the phone's hold) adds or removes it. */
export function pickTag(selected: readonly number[], tagId: number, additive: boolean): number[] {
  if (!additive) return [tagId]
  return selected.includes(tagId) ? selected.filter((id) => id !== tagId) : [...selected, tagId]
}

/**
 * An item's id across sessions. An item's own id is unique within its
 * session only; the grid, the viewer and paging key it by both.
 */
export function allMediaKey(item: Pick<AllMediaItem, 'sessionId' | 'id'>): string {
  return `${item.sessionId}/${item.id}`
}

/** The items keyed across sessions: `id` becomes `allMediaKey`, which the viewer pages by. */
export function keyedMedia(items: readonly AllMediaItem[]): AllMediaItem[] {
  return items.map((item) => ({ ...item, id: allMediaKey(item) }))
}

/** A page joined to what is held, an item already held (by key) left out. */
export function joinPage(held: readonly AllMediaItem[], page: readonly AllMediaItem[]): AllMediaItem[] {
  const seen = new Set(held.map(allMediaKey))
  return [...held, ...page.filter((item) => !seen.has(allMediaKey(item)))]
}

export interface AllMediaSection {
  sessionId: string
  title: string
  tiles: MediaTile[]
}

/**
 * The grid's sections: one per run of a session's items, its tiles newest
 * first with tool runs stacked as in the session's own gallery. Takes the
 * keyed items (`keyedMedia`). A session whose items Hide tool images hides
 * entirely has no section.
 */
export function allMediaSections(keyed: readonly AllMediaItem[], hideTool: boolean): AllMediaSection[] {
  const sections: AllMediaSection[] = []
  let i = 0
  while (i < keyed.length) {
    const sessionId = keyed[i].sessionId
    let j = i
    while (j < keyed.length && keyed[j].sessionId === sessionId) j++
    // `mediaTiles` takes a session's list oldest first, as the server lists one.
    const tiles = mediaTiles(keyed.slice(i, j).reverse(), hideTool)
    if (tiles.length > 0) sections.push({ sessionId, title: keyed[i].sessionTitle, tiles })
    i = j
  }
  return sections
}

/**
 * What the maximised view pages through: every loaded item, against the
 * grid's order, so › moves forward in time as in a session's own viewer and
 * a stack opened on its first frame walks on through the rest. Hide tool
 * images is applied by the viewer, which keeps an item asked for by name.
 */
export function allMediaOrder(keyed: readonly AllMediaItem[]): AllMediaItem[] {
  return keyed.slice().reverse()
}
