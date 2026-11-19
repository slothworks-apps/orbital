import { create } from 'zustand'
import type { ChatMessage } from '../lib/types'

/**
 * The `/context` report that is open (the Mac's dialog, the phone's sheet),
 * and the sessions where this window or this phone asked for one (spec
 * 2026-11-19-context-report-dialog-design § When it opens).
 *
 * Typing `/context` is asking for the report, so the answer opens it by
 * itself — but only the answer to a `/context` sent from here. The ask is
 * kept per page load and per device, so history, a terminal session's answer
 * and one asked for from another device all leave it closed: they arrive
 * without an ask behind them.
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
  show(sessionId: string, message: ChatMessage): void
  close(): void
  /** A `/context` went out from this composer. */
  ask(sessionId: string): void
  /** It did not go out after all. */
  forget(sessionId: string): void
  /**
   * A `/context` answer arrived live. It settles the ask either way, so an
   * answer without a report (an older CLI) does not leave one standing for
   * the next `/context`, sent from wherever.
   */
  answered(sessionId: string, message: ChatMessage): void
}

export const useContextReport = create<ContextReportState>()((set, get) => ({
  open: null,
  asked: {},
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
  answered: (sessionId, message) => {
    if (!get().asked[sessionId]) return
    get().forget(sessionId)
    if (message.notice?.contextReport) get().show(sessionId, message)
  },
}))

/** Whether a live message is a `/context` answer: named so, or carrying the report. */
export function isContextAnswer(message: ChatMessage): boolean {
  return message.role === 'notice' && (message.notice?.command === '/context' || message.notice?.contextReport != null)
}
