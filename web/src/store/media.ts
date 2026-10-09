import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../lib/api'
import { messageCarriesMedia } from '../lib/media'
import type { ChatMessage, MediaItem } from '../lib/types'
import { useOrbital } from './store'

/**
 * A session's media on this client (spec 2026-10-09-session-media-design):
 * the list the server last answered, the per-session Hide tool images
 * switch, which panel body is showing the gallery, and a Show in transcript
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
  /** Hide tool images, per session — mirrored from `localStorage`. */
  hideTool: Record<string, boolean>
  /** The session whose panel body shows Media instead of Transcript (24d). */
  gallery: string | null
  /** Show in transcript, waiting for the transcript to find the message. */
  jump: { sessionId: string; messageId: string; seq: number } | null
  load(sessionId: string): Promise<void>
  setHideTool(sessionId: string, hide: boolean): void
  setGallery(sessionId: string | null): void
  showInTranscript(sessionId: string, messageId: string): void
  /** The transcript is done with `jump` — found and scrolled, or given up. */
  endJump(seq: number): void
}

const HIDE_TOOL_KEY = (sessionId: string) => `orbital.media.hideTool.${sessionId}`

function readHideTool(sessionId: string): boolean {
  try {
    return globalThis.localStorage?.getItem(HIDE_TOOL_KEY(sessionId)) === '1'
  } catch {
    return false
  }
}

function writeHideTool(sessionId: string, hide: boolean): void {
  try {
    if (hide) globalThis.localStorage?.setItem(HIDE_TOOL_KEY(sessionId), '1')
    else globalThis.localStorage?.removeItem(HIDE_TOOL_KEY(sessionId))
  } catch {
    /* storage off: the switch holds for this window only */
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
  hideTool: {},
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

  setHideTool(sessionId, hide) {
    writeHideTool(sessionId, hide)
    set((s) => ({ hideTool: { ...s.hideTool, [sessionId]: hide } }))
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

/** The switch for one session, read through from `localStorage` the first time. */
export function useHideTool(sessionId: string): [boolean, (hide: boolean) => void] {
  const hide = useMedia((s) => s.hideTool[sessionId] ?? readHideTool(sessionId))
  const setHideTool = useMedia((s) => s.setHideTool)
  return [hide, (next: boolean) => setHideTool(sessionId, next)]
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
 * Closed, only a message that brings media asks — that is how the header
 * readout appears with the first item. The first mount asks once when no
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
      if (watching || arrived.some(messageCarriesMedia)) void useMedia.getState().load(sessionId)
    })
  }, [sessionId, watching])

  return items
}
