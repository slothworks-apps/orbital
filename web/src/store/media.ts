import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../lib/api'
import { mediaArrived, parseHiddenSources, type MediaSourceKey } from '../lib/media'
import type { ChatMessage, MediaItem } from '../lib/types'
import { useOrbital } from './store'

/**
 * A session's media on this client (spec 2026-10-09-session-media-design):
 * the list the server last answered, the per-session Sources filter
 * (canvas `Feature - Media tiles` 26a), which panel body is showing the gallery, and a Show in transcript
 * on its way to the transcript. Kept out of the main store because nothing
 * else reads it; the phone reads the same store for its gallery.
 *
 * Nothing polls. The list is asked for once when a panel first shows the
 * session (the header readout has to know whether there is any media),
 * again whenever the popover or the gallery opens, on every new message
 * while either is open, and on a new message that itself carries media.
 */
interface MediaState {
  /** The server's last answer per session, oldest first. Absent until one arrived. */
  lists: Record<string, MediaItem[]>
  /** The sources the filter turned off, per session — mirrored from `localStorage`, so per device too. */
  hidden: Record<string, MediaSourceKey[]>
  /** The session whose panel body shows Media instead of Transcript (24d). */
  gallery: string | null
  /** Show in transcript, waiting for the transcript to find the message. */
  jump: { sessionId: string; messageId: string; seq: number } | null
  load(sessionId: string): Promise<void>
  setHidden(sessionId: string, hidden: MediaSourceKey[]): void
  setGallery(sessionId: string | null): void
  showInTranscript(sessionId: string, messageId: string): void
  /** The transcript is done with `jump` — found and scrolled, or given up. */
  endJump(seq: number): void
}

const HIDDEN_KEY = (sessionId: string) => `orbital.media.hidden.${sessionId}`
/** What Hide tool images stored, read once so a session keeps what it hid. */
const LEGACY_HIDE_TOOL_KEY = (sessionId: string) => `orbital.media.hideTool.${sessionId}`

function readHidden(sessionId: string): MediaSourceKey[] {
  try {
    const storage = globalThis.localStorage
    if (!storage) return []
    return parseHiddenSources(storage.getItem(HIDDEN_KEY(sessionId)), storage.getItem(LEGACY_HIDE_TOOL_KEY(sessionId)) === '1')
  } catch {
    return []
  }
}

function writeHidden(sessionId: string, hidden: MediaSourceKey[]): void {
  try {
    globalThis.localStorage?.setItem(HIDDEN_KEY(sessionId), JSON.stringify(hidden))
    globalThis.localStorage?.removeItem(LEGACY_HIDE_TOOL_KEY(sessionId))
  } catch {
    /* storage off: the filter holds for this window only */
  }
}

/**
 * One request per session at a time. A load asked for while one is out is
 * remembered and run once that one lands, so the answer is never older than
 * the last thing that asked.
 */
const inFlight = new Map<string, { again: boolean; done: Promise<void> }>()
let jumpSeq = 0

export const useMedia = create<MediaState>((set, get) => ({
  lists: {},
  hidden: {},
  gallery: null,
  jump: null,

  load(sessionId) {
    const running = inFlight.get(sessionId)
    if (running) {
      running.again = true
      return running.done
    }
    const entry = { again: false, done: Promise.resolve() }
    entry.done = (async () => {
      try {
        do {
          entry.again = false
          try {
            const items = await api.sessionMedia(sessionId)
            set((s) => ({ lists: { ...s.lists, [sessionId]: items } }))
          } catch {
            // The last answer stands; the next open or message asks again.
          }
        } while (entry.again)
      } finally {
        inFlight.delete(sessionId)
      }
    })()
    inFlight.set(sessionId, entry)
    return entry.done
  },

  setHidden(sessionId, hidden) {
    writeHidden(sessionId, hidden)
    set((s) => ({ hidden: { ...s.hidden, [sessionId]: hidden } }))
  },

  setGallery(gallery) {
    if (get().gallery !== gallery) set({ gallery })
  },

  showInTranscript(sessionId, messageId) {
    jumpSeq += 1
    set({ jump: { sessionId, messageId, seq: jumpSeq }, gallery: null })
  },

  endJump(seq) {
    if (get().jump?.seq === seq) set({ jump: null })
  },
}))

/** What `localStorage` held, read once per session so every reader gets the same array back. */
const read = new Map<string, MediaSourceKey[]>()
function storedHidden(sessionId: string): MediaSourceKey[] {
  let hidden = read.get(sessionId)
  if (!hidden) {
    hidden = readHidden(sessionId)
    read.set(sessionId, hidden)
  }
  return hidden
}

/** The filter for one session, read through from `localStorage` the first time. */
export function useHiddenSources(sessionId: string): [MediaSourceKey[], (hidden: MediaSourceKey[]) => void] {
  const hidden = useMedia((s) => s.hidden[sessionId] ?? storedHidden(sessionId))
  const setHidden = useMedia((s) => s.setHidden)
  return [hidden, (next: MediaSourceKey[]) => setHidden(sessionId, next)]
}

/** The last settled message of a transcript — a streamed row counts once it is complete. */
function lastSettledId(messages: readonly ChatMessage[] | undefined): string | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i].partial) return messages[i].id
  }
  return null
}

/**
 * Keeps one session's list current for whoever shows it. `watching` is true
 * while the popover or the gallery is open: then every new message asks
 * again, so a file named a moment ago, or one deleted since, shows as it is.
 * Closed, only messages that bring media ask (`mediaArrived`) — that is how
 * the header readout appears with the first item. The first mount asks once when no
 * answer is held yet.
 *
 * New messages are what the transcript already hears over the session's WS
 * topic; this listens to the same store rather than to the socket.
 */
export function useSessionMedia(sessionId: string | null, watching: boolean): MediaItem[] | undefined {
  const items = useMedia((s) => (sessionId ? s.lists[sessionId] : undefined))

  useEffect(() => {
    if (!sessionId) return
    if (watching || useMedia.getState().lists[sessionId] === undefined) void useMedia.getState().load(sessionId)
  }, [sessionId, watching])

  useEffect(() => {
    if (!sessionId) return
    let last = lastSettledId(useOrbital.getState().transcripts[sessionId])
    return useOrbital.subscribe((state) => {
      const messages = state.transcripts[sessionId]
      const next = lastSettledId(messages)
      if (next === last) return
      const from = last === null ? -1 : (messages?.findIndex((m) => m.id === last) ?? -1)
      last = next
      if (!messages) return
      const arrived = messages.slice(from + 1)
      if (watching || mediaArrived(arrived, messages)) void useMedia.getState().load(sessionId)
    })
  }, [sessionId, watching])

  return items
}
