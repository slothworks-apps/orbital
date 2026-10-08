import type { ComponentType } from 'react'
import { create } from 'zustand'

/**
 * The notices shown at the top centre of the map (`ui/MapNotice`,
 * `ui/MapNoticeHost`): one-time or occasional things the app has to say that
 * are not a session's — the notifications tip first (spec
 * 2026-10-08-notifications-off-by-default-design), an update being available
 * later. One shows at a time; the rest wait in the order they came.
 *
 * A feature pushes an entry whose `Body` renders a `MapNotice` with its own
 * content and state, and calls `close` when it is done; the host fades it out
 * and shows the next. An entry decides for itself whether it ever comes back —
 * the queue keeps no memory of what was shown.
 */
export interface MapNoticeEntry {
  /** Pushing an id already queued is a no-op. */
  id: string
  Body: ComponentType<{ close: () => void }>
}

export function enqueueNotice(queue: readonly MapNoticeEntry[], entry: MapNoticeEntry): readonly MapNoticeEntry[] {
  return queue.some((e) => e.id === entry.id) ? queue : [...queue, entry]
}

export function dequeueNotice(queue: readonly MapNoticeEntry[], id: string): readonly MapNoticeEntry[] {
  return queue.some((e) => e.id === id) ? queue.filter((e) => e.id !== id) : queue
}

interface MapNoticesState {
  queue: readonly MapNoticeEntry[]
  push(entry: MapNoticeEntry): void
  dismiss(id: string): void
}

export const useMapNotices = create<MapNoticesState>()((set) => ({
  queue: [],
  push: (entry) => set((s) => ({ queue: enqueueNotice(s.queue, entry) })),
  dismiss: (id) => set((s) => ({ queue: dequeueNotice(s.queue, id) })),
}))
