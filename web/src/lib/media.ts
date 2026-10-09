import type { ChatMessage, MediaItem } from './types'
import { mediaPathsInReply } from './pathLinks'

/**
 * The pure half of a session's media (spec 2026-10-09-session-media-design;
 * canvas `Feature - Media` 24b–24h): which items are shown, how the grid
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

/** The items "Hide tool images" leaves standing — the one switch for popover, gallery and paging (24b). */
export function visibleMedia(items: readonly MediaItem[], hideTool: boolean): MediaItem[] {
  return hideTool ? items.filter((item) => item.source !== 'tool') : items.slice()
}

export function toolMediaCount(items: readonly MediaItem[]): number {
  return items.reduce((n, item) => n + (item.source === 'tool' ? 1 : 0), 0)
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
export function mediaTiles(items: readonly MediaItem[], hideTool: boolean): MediaTile[] {
  const newest = visibleMedia(items, hideTool).reverse()
  const tiles: MediaTile[] = []
  for (let i = 0; i < newest.length; i++) {
    const cover = newest[i]
    let j = i
    if (cover.source === 'tool' && cover.toolRun !== undefined) {
      while (
        j + 1 < newest.length &&
        newest[j + 1].source === 'tool' &&
        newest[j + 1].toolRun === cover.toolRun
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
export function pagingOrder(items: readonly MediaItem[], hideTool: boolean): MediaItem[] {
  return visibleMedia(items, hideTool)
}

/**
 * Where `id` sits in `order`. An item the switch has just hidden (the view
 * was on a tool frame when Hide tool images went on) hands over to the next
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
      : item.source === 'agent' && item.path === target.path
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

/** Whether a message brings media with it — the cue to ask the server for the list again. */
export function messageCarriesMedia(message: ChatMessage): boolean {
  if (message.partial) return false
  if (message.images?.length) return true
  return message.role === 'assistant' && Boolean(message.text) && mediaPathsInReply(message.text!).length > 0
}

/** The house clock reading (`MessageView`'s `clockTime`), or '' for a stamp `Date` cannot read. */
export function mediaClock(ts: string): string {
  const at = new Date(ts)
  if (Number.isNaN(at.getTime())) return ''
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

/** The caption's source line (24e). */
export function mediaSourceLabel(item: MediaItem): string {
  switch (item.source) {
    case 'you':
      return 'Attached by you'
    case 'tool':
      return 'Returned by a tool'
    case 'agent':
      return 'Named by the agent'
  }
}

/** The header of the popover and the gallery: `MEDIA · 14 · 7 tool`, or what the switch hides (24b, 24h). */
export function mediaCountLine(items: readonly MediaItem[], hideTool: boolean): string {
  const tool = toolMediaCount(items)
  const shown = hideTool ? items.length - tool : items.length
  if (tool === 0) return `MEDIA · ${shown}`
  return hideTool ? `MEDIA · ${shown} · ${tool} tool hidden` : `MEDIA · ${shown} · ${tool} tool`
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
