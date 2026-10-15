import type { ChatMessage, MediaItem } from './types'
import { mediaPathsInReply } from './pathLinks'
import { isScreenshotTool, writtenImagePaths } from '@orbital/shared/paths'

/**
 * The pure half of a session's media (spec 2026-10-09-session-media-design;
 * canvas `Feature - Media` 24b–24h, `Feature - Media tiles` 26a–26e): which items are shown, how the grid
 * stacks them and the order the maximised view pages through. No React, no
 * store — the desktop panel and the phone's gallery read the same answers.
 *
 * The server lists items oldest first. The grids show them newest first; the
 * maximised view pages in the transcript's own order, oldest first, so ›
 * moves forward in time (24e).
 */

/** What a press on a thumbnail asks to see: an image store ref, or a path a reply named. */
export type MediaTarget =
  | { kind: 'ref'; ref: string; messageId?: string }
  | { kind: 'path'; path: string; cwd?: string; messageId?: string }

/**
 * The five rows of the Sources filter (canvas `Feature - Media tiles` 26a,
 * 26d A), which replaced Hide tool images. A subagent's item is the
 * subagent's whatever it is underneath — a screenshot it took or a path it
 * named — so turning Subagents off hides all of a moon's output, and Tools
 * stays the parent's own tool frames.
 */
export type MediaSourceKey = 'you' | 'tool' | 'named' | 'saved' | 'subagent'
export const MEDIA_SOURCES: readonly MediaSourceKey[] = ['you', 'tool', 'named', 'saved', 'subagent']

/** The row an item is filtered under; null for a source a newer Mac sent that this client does not know, which is always shown. */
export function mediaSourceKey(item: Pick<MediaItem, 'source' | 'subagent'>): MediaSourceKey | null {
  if (item.subagent) return 'subagent'
  switch (item.source) {
    case 'you':
      return 'you'
    case 'tool':
      return 'tool'
    case 'agent':
      return 'named'
    case 'written':
      return 'saved'
    default:
      return null
  }
}

/** Whether the item is a tool's frame — the ones ⚙ marks and a tool run stacks (26d A). */
export function isToolFrame(item: Pick<MediaItem, 'source' | 'subagent'>): boolean {
  return item.source === 'tool' && !item.subagent
}

/** The items the filter leaves standing — the one filter for glance, gallery, paging and the phone (26a). */
export function visibleMedia(items: readonly MediaItem[], hidden: readonly MediaSourceKey[]): MediaItem[] {
  if (hidden.length === 0) return items.slice()
  return items.filter((item) => {
    const key = mediaSourceKey(item)
    return key === null || !hidden.includes(key)
  })
}

export function sourceCounts(items: readonly MediaItem[]): Record<MediaSourceKey, number> {
  const counts: Record<MediaSourceKey, number> = { you: 0, tool: 0, named: 0, saved: 0, subagent: 0 }
  for (const item of items) {
    const key = mediaSourceKey(item)
    if (key) counts[key]++
  }
  return counts
}

/**
 * Whether a row reads as on. A source with no items cannot be toggled (26b
 * C), so it counts as on whatever was stored for it: the button never says
 * the gallery is narrowed when nothing is hidden.
 */
export function sourceShown(key: MediaSourceKey, hidden: readonly MediaSourceKey[], counts: Record<MediaSourceKey, number>): boolean {
  return counts[key] === 0 || !hidden.includes(key)
}

/** What the filter button and the count line say (26b A): the state in words, and how much of the total is shown. */
export interface SourcesSummary {
  /** `Sources: All`, `Sources: 4 of 5`, `Sources: none`. */
  label: string
  /** Something is hidden: the button wears its active chip and the count reads `12 of 19`. */
  filtered: boolean
  shown: number
  total: number
}

export function sourcesSummary(items: readonly MediaItem[], hidden: readonly MediaSourceKey[]): SourcesSummary {
  const counts = sourceCounts(items)
  const on = MEDIA_SOURCES.filter((key) => sourceShown(key, hidden, counts)).length
  const shown = visibleMedia(items, hidden).length
  const filtered = on < MEDIA_SOURCES.length
  const label =
    !filtered ? 'Sources: All' : shown === 0 && items.length > 0 ? 'Sources: none' : `Sources: ${on} of ${MEDIA_SOURCES.length}`
  return { label, filtered, shown, total: items.length }
}

/** `19`, or `12 of 19` while the filter hides something — the count line's figure (26b A). */
export function mediaCount(summary: SourcesSummary): string {
  return summary.filtered ? `${summary.shown} of ${summary.total}` : String(summary.total)
}

/**
 * What a row says under its name (26a): the tools and the moons it stands
 * for, so one row each is enough however many there are (26e).
 */
export function sourceDetail(key: MediaSourceKey, items: readonly MediaItem[]): string {
  if (key === 'saved') return 'not mentioned in a reply'
  const names = new Set<string>()
  for (const item of items) {
    if (mediaSourceKey(item) !== key) continue
    if (key === 'subagent' && item.subagent) names.add(item.subagent.name)
    if (key === 'tool' && item.tool) names.add(mediaToolLabel(item.tool).split(' · ')[0])
  }
  return [...names].join(', ')
}

/** The rows' names (26d A). */
export const SOURCE_LABELS: Record<MediaSourceKey, string> = {
  you: 'Attached by you',
  tool: '⚙ Tools',
  named: 'Named in a reply',
  saved: 'Saved by the agent',
  subagent: 'Subagents',
}

/**
 * The stored filter, read back: the sources turned off, unknown names
 * dropped. A session that only ever had Hide tool images on keeps what that
 * switch hid — tool frames and images saved to disk.
 */
export function parseHiddenSources(stored: string | null, legacyHideTool: boolean): MediaSourceKey[] {
  if (stored === null) return legacyHideTool ? ['tool', 'saved'] : []
  try {
    const value: unknown = JSON.parse(stored)
    if (!Array.isArray(value)) return []
    return MEDIA_SOURCES.filter((key) => value.includes(key))
  } catch {
    return []
  }
}

/**
 * One grid tile. A run of consecutive tool frames from one tool call is one
 * tile (⚙ ×n, 24d): `cover` is the newest frame, the one the newest-first
 * grid meets first, and `first` the oldest — a stack opens on its first
 * frame and › walks on through the rest.
 */
export interface MediaTile {
  key: string
  cover: MediaItem
  first: MediaItem
  /** Frames in the stack; 1 for a lone item. */
  count: number
}

/** Newest first, consecutive frames of one tool run stacked into one tile. */
export function mediaTiles(items: readonly MediaItem[], hidden: readonly MediaSourceKey[]): MediaTile[] {
  const newest = visibleMedia(items, hidden).reverse()
  const tiles: MediaTile[] = []
  for (let i = 0; i < newest.length; i++) {
    const cover = newest[i]
    let j = i
    if (cover.source === 'tool' && cover.toolRun !== undefined) {
      while (
        j + 1 < newest.length &&
        newest[j + 1].source === 'tool' &&
        newest[j + 1].toolRun === cover.toolRun &&
        newest[j + 1].subagent?.toolUseId === cover.subagent?.toolUseId
      ) {
        j++
      }
    }
    tiles.push({ key: cover.id, cover, first: newest[j], count: j - i + 1 })
    i = j
  }
  return tiles
}

/** What the maximised view pages through: the shown items, oldest first, every stacked frame its own stop. */
export function pagingOrder(items: readonly MediaItem[], hidden: readonly MediaSourceKey[]): MediaItem[] {
  return visibleMedia(items, hidden)
}

/**
 * Where `id` sits in `order`. An item the filter has just hidden (the view
 * was on a tool frame when Tools went off) hands over to the next
 * shown item after it in time, or the last one when nothing follows — the
 * view never goes blank under the reader. -1 only for an empty order.
 */
export function positionIn(order: readonly MediaItem[], all: readonly MediaItem[], id: string): number {
  if (order.length === 0) return -1
  const at = order.findIndex((item) => item.id === id)
  if (at >= 0) return at
  const from = all.findIndex((item) => item.id === id)
  if (from < 0) return 0
  const later = new Set(all.slice(from + 1).map((item) => item.id))
  const next = order.findIndex((item) => later.has(item.id))
  return next >= 0 ? next : order.length - 1
}

/** ‹ › and ← →: one step, wrapping at either end (24e). */
export function stepIndex(length: number, index: number, delta: number): number {
  if (length === 0) return -1
  return (((index + delta) % length) + length) % length
}

/**
 * The listed item a thumbnail in the transcript stands for, so the view can
 * open on it and page on (spec § What the user sees, Reply thumbnails). The
 * message narrows it when known: one image attached twice is one ref in two
 * messages, and one path named twice is two items. Undefined when the list
 * has no such item — the caller falls back to that one image on its own.
 */
export function matchMediaItem(items: readonly MediaItem[], target: MediaTarget): MediaItem | undefined {
  const same = (item: MediaItem) =>
    target.kind === 'ref'
      ? item.ref === target.ref
      : (item.source === 'agent' || item.source === 'written') && item.path === target.path
  const inMessage = target.messageId
    ? items.find((item) => item.messageId === target.messageId && same(item))
    : undefined
  if (inMessage) return inMessage
  // Without the message, the newest mention: the one the reader most likely just saw.
  for (let i = items.length - 1; i >= 0; i--) {
    if (same(items[i])) return items[i]
  }
  return undefined
}

/** The tools that launch a subagent, whose result is the subagent ending (`server/src/transcript/subagents.ts`). */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

/**
 * Whether the messages that just arrived bring media with it — the cue to ask
 * the server for the list again while nothing is watching it. `messages` is
 * the whole transcript they arrived into, where a result's call is found.
 *
 * A tool call that saves an image counts on its result, not on the call: the
 * file is only on disk once the tool has run, and the server lists a saved
 * image only while it is. A subagent's images are not in this transcript at
 * all; its call's result — the subagent ending — stands for them.
 */
export function mediaArrived(arrived: readonly ChatMessage[], messages: readonly ChatMessage[]): boolean {
  return arrived.some((message) => {
    if (message.partial) return false
    if (message.images?.length) return true
    if (message.role === 'assistant') return Boolean(message.text) && mediaPathsInReply(message.text!).length > 0
    if (message.role !== 'tool_result' || !message.toolUseId) return false
    const call = messages.find((m) => m.role === 'tool_use' && m.toolUseId === message.toolUseId)
    if (!call?.toolName) return false
    return (
      SUBAGENT_TOOLS.has(call.toolName) ||
      isScreenshotTool(call.toolName) ||
      writtenImagePaths(call.toolName, call.toolInput).length > 0
    )
  })
}

/** The house clock reading (`MessageView`'s `clockTime`), or '' for a stamp `Date` cannot read. */
export function mediaClock(ts: string): string {
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/**
 * The tool a `tool` item came from, as the caption names it (24e: the tool,
 * not just "a tool" — `Playwright · browser take screenshot`). An MCP
 * tool's transcript name is `mcp__<server>__<tool>`; a plugin's server repeats its own name
 * (`plugin_playwright_playwright`), so the last word of the server stands for
 * it. A built-in tool (`Read`) is its own name.
 */
export function mediaToolLabel(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!mcp) return tool
  const server = mcp[1].split('_').filter(Boolean).pop() ?? mcp[1]
  return `${server.charAt(0).toUpperCase()}${server.slice(1)} · ${mcp[2].replace(/_/g, ' ')}`
}

/**
 * Where an item came from, in the words the maximised view and the phone
 * viewer put under it (26d A, the 24e column).
 */
export function mediaSourceLabel(item: MediaItem): string {
  if (item.subagent) return `From moon ${item.subagent.name}`
  if (item.source === 'written') return 'Saved by the agent · not mentioned in a reply'
  return shortSourceLabel(item)
}

/** The same, short enough for a tile's caption (26d A, the caption column). */
function shortSourceLabel(item: MediaItem): string {
  if (item.subagent) return item.subagent.name
  switch (item.source) {
    case 'you':
      return 'Attached by you'
    case 'tool':
      return item.tool ? mediaToolLabel(item.tool) : 'Returned by a tool'
    case 'agent':
      return 'Named in a reply'
    case 'written':
      return 'Saved by the agent'
    default:
      return ''
  }
}

/**
 * The line under a tile (26d A): the file's name when it has one — what you
 * would search for — else where it came from, in muted ink. A stack is one
 * tool call, so it names the tool. `moon` leads a subagent's caption with
 * the moon's hollow dot.
 */
export function mediaTileCaption(tile: MediaTile): { text: string; named: boolean; moon: boolean } {
  const { cover, count } = tile
  const name = count === 1 && cover.path ? baseName(cover.path) : ''
  return name
    ? { text: name, named: true, moon: Boolean(cover.subagent) }
    : { text: shortSourceLabel(cover), named: false, moon: Boolean(cover.subagent) }
}

/** The header of the popover and the gallery: `MEDIA · 19`, or `MEDIA · 12 of 19` while filtered (26b A). */
export function mediaCountLine(items: readonly MediaItem[], hidden: readonly MediaSourceKey[]): string {
  return `MEDIA · ${mediaCount(sourcesSummary(items, hidden))}`
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
