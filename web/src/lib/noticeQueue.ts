import type { ComponentType } from 'react'
import { create } from 'zustand'

/**
 * The notice toast's queue (canvas `Feature - Notice toast` 1a, 1c, 2a–2d):
 * what Orbital has to say that is not about a session, one message at a time.
 * The Mac and the phone each keep their own (`store/mapNotices`,
 * `mobile/notices`); nothing seen on one is marked on the other.
 *
 * - One shows at a time, chosen by kind and then age: feedback › update ›
 *   changelog › relay & pairing › usage limit › tips; within a kind, oldest
 *   first. `feedback` is the Mac's reply to what the user just did
 *   (`ui/FeedbackNotice`): it shows at once, and the message it covers waits
 *   in the dots until it ends.
 * - × or any action ends a message for good. Ending is the message's own
 *   business — it knows where its "seen" lives and persists it there — and
 *   then it leaves the queue with `dismiss`.
 * - A message that no longer applies is `dismiss`ed by its feature before it
 *   shows, and drops out unseen.
 * - A kind may have states (canvas `Feature - App update`): its message
 *   swaps its words in place, and only its last state ends it. Until then it
 *   keeps the slot — the messages behind it wait, and their dots stay.
 * - No notice goes by itself; only a reply may (`ui/FeedbackNotice`).
 */

/** In the order they show. `feedback`, `update` and `tip` have messages so far; the rest are reserved. */
export const NOTICE_KINDS = ['feedback', 'update', 'changelog', 'pairing', 'usage', 'tip'] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]

export interface NoticeEntry {
  /** Pushing an id already queued is a no-op. */
  id: string
  kind: NoticeKind
  /** When it was queued: oldest first within a kind. */
  at: number
  /** Renders the message in the platform's shell; `close` ends it on screen. */
  Body: ComponentType<{ close: () => void }>
}

const rank = (kind: NoticeKind): number => NOTICE_KINDS.indexOf(kind)

/** The queue in showing order, `entry` added unless its id is already there. */
export function enqueueNotice(queue: readonly NoticeEntry[], entry: NoticeEntry): readonly NoticeEntry[] {
  if (queue.some((e) => e.id === entry.id)) return queue
  return [...queue, entry].sort((a, b) => rank(a.kind) - rank(b.kind) || a.at - b.at)
}

export function dequeueNotice(queue: readonly NoticeEntry[], id: string): readonly NoticeEntry[] {
  return queue.some((e) => e.id === id) ? queue.filter((e) => e.id !== id) : queue
}

/** How many dots stand for the queue at most; the rest are a number. */
export const NOTICE_DOTS_MAX = 5

/**
 * The passive dots above the toast (1c DOTS): none for a single message; for
 * two or more, the one showing filled first, then one hollow per waiting
 * message up to `NOTICE_DOTS_MAX` dots, and the remainder as `+N`.
 * `covered`: a reply is showing over them (3a, 3c), so none of the `count`
 * is the one showing and every dot is hollow.
 */
export function noticeDots(
  count: number,
  covered = false,
): { dots: ('current' | 'waiting')[]; more: number } {
  if (count < 2) return { dots: [], more: 0 }
  const shown = Math.min(count, NOTICE_DOTS_MAX)
  return {
    dots: Array.from({ length: shown }, (_, i) => (i === 0 && !covered ? 'current' : 'waiting')),
    more: count - shown,
  }
}

export interface NoticeQueueState {
  queue: readonly NoticeEntry[]
  push(entry: Omit<NoticeEntry, 'at'>): void
  dismiss(id: string): void
}

/** One queue: the Mac's or the phone's. */
export function createNoticeQueue() {
  return create<NoticeQueueState>()((set) => ({
    queue: [],
    push: (entry) => set((s) => ({ queue: enqueueNotice(s.queue, { ...entry, at: Date.now() }) })),
    dismiss: (id) => set((s) => ({ queue: dequeueNotice(s.queue, id) })),
  }))
}
