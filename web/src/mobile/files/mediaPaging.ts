import { matchMediaItem, positionIn } from '../../lib/media'
import type { MediaItem } from '../../lib/types'
import type { PushedOf } from '../state'
import type { FileKind } from './route'

/**
 * Which listed media item a pushed file is (spec 2026-10-09-session-media-design
 * § Phone, Viewer): the one the gallery named, or — for a press in the
 * session's own transcript — the item its ref or path stands for, so the
 * viewer pages through the session's media from there. Undefined when it is
 * none: a file opened from a subagent's transcript or a task's output names
 * files the session's list does not hold, and keeps 10d's paging through its
 * message.
 */
export function mediaItemFor(
  item: Pick<PushedOf<'file'>, 'path' | 'ref' | 'cwd' | 'messageId' | 'mediaId'>,
  items: readonly MediaItem[] | undefined,
  fromSession: boolean,
): MediaItem | undefined {
  if (!items) return undefined
  if (item.mediaId !== undefined) return items.find((m) => m.id === item.mediaId)
  if (!fromSession) return undefined
  if (item.ref) return matchMediaItem(items, { kind: 'ref', ref: item.ref, messageId: item.messageId })
  if (item.path) return matchMediaItem(items, { kind: 'path', path: item.path, cwd: item.cwd, messageId: item.messageId })
  return undefined
}

/**
 * Where a swipe from `currentId` lands in `order` — the items Hide tool
 * images leaves standing, oldest first. A swipe stops at either end rather
 * than wrapping: on a phone the edge is where the finger expects it. The
 * current item may be one the switch has just hidden; it then counts from
 * the item that took its place (`positionIn`).
 */
export function stepMedia(order: readonly MediaItem[], all: readonly MediaItem[], currentId: string, delta: number): string | null {
  const at = positionIn(order, all, currentId)
  if (at < 0) return null
  return order[Math.min(order.length - 1, Math.max(0, at + delta))].id
}

/**
 * The listed item the file screen pages from (`mediaItemFor`), for what it
 * pushed: an image or a PDF by its ref or path, or a generated view the
 * gallery named by its id — a view has neither (spec
 * 2026-11-18-generated-views-design § Media).
 */
export function pagedMediaFor(
  item: Pick<PushedOf<'file'>, 'path' | 'ref' | 'cwd' | 'messageId' | 'mediaId'>,
  kind: FileKind | null,
  items: readonly MediaItem[] | undefined,
  fromSession: boolean,
): MediaItem | undefined {
  if (kind === 'image' || kind === 'pdf') return mediaItemFor(item, items, fromSession)
  if (item.mediaId === undefined) return undefined
  const named = mediaItemFor(item, items, fromSession)
  return named?.kind === 'view' ? named : undefined
}
