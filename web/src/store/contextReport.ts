import { create } from 'zustand'
import type { ChatMessage } from '../lib/types'

/**
 * The `/context` report that is open (the Mac's dialog, the phone's sheet),
 * and the sessions where this window or this phone asked for one (spec
 * 2026-11-19-context-report-dialog-design § When it opens).
 *
 * Typing `/context` is asking for the report, so the answer opens it by
 * itself — but only the answer to a `/context` sent from here, and only while
 * that session is the one on screen here. The ask is kept per page load and
 * per device, so history, a terminal session's answer and one asked for from
 * another device all leave it closed: they arrive without an ask behind
 * them. An answer that comes while the session is not on screen settles the
 * ask and leaves the row in the transcript.
 */
export interface OpenContextReport {
  sessionId: string
  /** The `/context` notice, as it was when it opened: a report is a snapshot. */
  message: ChatMessage
}

interface ContextReportState {
  open: OpenContextReport | null
  /** Sessions with a `/context` sent from here whose answer has not come yet. */
  asked: Record<string, true>
  /**
   * The session whose transcript is on screen here: the Mac's selected
   * session (the main window's detail panel, or a detached window's one
   * session), the phone's session screen while nothing is pushed over it and
   * no lock stands in front of it. Null when none is.
   */
  onScreen: string | null
  show(sessionId: string, message: ChatMessage): void
  close(): void
  /** A `/context` went out from this composer. */
  ask(sessionId: string): void
  /** It did not go out after all. */
  forget(sessionId: string): void
  /**
   * Every ask goes: after a reconnect, an answer that came while the socket
   * was down arrives as history, and its ask would be left standing.
   */
  forgetAll(): void
  /**
   * `sessionId` is on screen; the returned function says it no longer is
   * (and does nothing if another has taken its place meanwhile).
   */
  view(sessionId: string): () => void
  /**
   * A `/context` answer arrived live. It settles the ask either way, so an
   * answer without a report (an older CLI) or one that came while the
   * session was off screen does not leave one standing for the next
   * `/context`, sent from wherever.
   */
  answered(sessionId: string, message: ChatMessage): void
}

export const useContextReport = create<ContextReportState>()((set, get) => ({
  open: null,
  asked: {},
  onScreen: null,
  show: (sessionId, message) => set({ open: { sessionId, message } }),
  close: () => set({ open: null }),
  ask: (sessionId) => set((s) => ({ asked: { ...s.asked, [sessionId]: true } })),
  forget: (sessionId) => {
    if (!get().asked[sessionId]) return
    set((s) => {
      const asked = { ...s.asked }
      delete asked[sessionId]
      return { asked }
    })
  },
  forgetAll: () => {
    if (Object.keys(get().asked).length > 0) set({ asked: {} })
  },
  view: (sessionId) => {
    set({ onScreen: sessionId })
    return () => {
      if (get().onScreen === sessionId) set({ onScreen: null })
    }
  },
  answered: (sessionId, message) => {
    if (!get().asked[sessionId]) return
    get().forget(sessionId)
    if (message.notice?.contextReport && get().onScreen === sessionId) get().show(sessionId, message)
  },
}))

/** Whether a live message is a `/context` answer: named so, or carrying the report. */
export function isContextAnswer(message: ChatMessage): boolean {
  return message.role === 'notice' && (message.notice?.command === '/context' || message.notice?.contextReport != null)
}
