import { create } from 'zustand'
import type { ChatMessage, ContextReport } from '../lib/types'

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
/** One report as the dialog draws it: what it says, when it was taken and how it came. */
export interface ReportSnapshot {
  report: ContextReport
  /** When it was taken (ISO), or null when the row carries no time. */
  takenAt: string | null
  /**
   * The CLI's printout, the `/context` notice's `text` — the dialog's As
   * text. Null for a report that came from the Mac's keeper or was taken on
   * demand: no printout travels with it, and none is made up.
   */
  text: string | null
}

/**
 * What the read-out already knows when it opens the report (canvas 71a/71c):
 * the figure, the window and the model. The dialog draws its headline and
 * window bar from it at once; only the split waits.
 */
export interface ReportPreview {
  used: number
  window: number
  model: string | null
}

/**
 * Why no report was taken (canvas 71c, 71e): the session did not answer in
 * time, it refused or cannot count, or the Mac could not be reached — on the
 * phone, the Mac asleep.
 */
export type ReportFailure = 'timeout' | 'failed' | 'asleep' | 'unreachable'

/**
 * Where an opening came from, which is what its footer says (canvas 71d):
 * the transcript's `/context` row, or the context read-out — for a session
 * that runs, one that has ended, or one a terminal holds.
 */
export type ReportOrigin = 'row' | 'readout' | 'ended' | 'terminal'

/**
 * The report that is open. `ready` has its snapshot; `loading` is being
 * taken (or fetched) and draws the preview; `failed` says why, offers Try
 * again and the earlier report if there is one. One opening keeps its `key`
 * from loading to arrival, so the dialog is not drawn anew and the split
 * crossfades in (canvas 71c).
 */
export interface OpenContextReport {
  sessionId: string
  key: string
  phase: 'loading' | 'ready' | 'failed'
  origin: ReportOrigin
  /** The report drawn, once `ready`. */
  snapshot: ReportSnapshot | null
  /** What the read-out knew: the headline while `loading` or `failed`; null when it knew nothing. */
  preview: ReportPreview | null
  /** Whether `loading` is a fresh count (words say so) or only a fetch of the kept report. */
  counting?: boolean
  failure?: ReportFailure
  /** `failed` only: the session's latest report, offered beside Try again. */
  earlier?: ReportSnapshot | null
}

/** A `/context` answer as the report it opens, or null when it carries none. */
export function openingOf(sessionId: string, message: ChatMessage): OpenContextReport | null {
  const snapshot = snapshotOf(message)
  if (!snapshot) return null
  return { sessionId, key: message.id, phase: 'ready', origin: 'row', snapshot, preview: null }
}

/** A `/context` answer's report, with its time and printout, or null when it carries none. */
export function snapshotOf(message: ChatMessage): ReportSnapshot | null {
  const report = message.notice?.contextReport
  if (!report) return null
  return { report, takenAt: message.timestamp ?? null, text: message.text ?? null }
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
  /** Opens a `/context` answer's report; one without a report opens nothing. */
  show(sessionId: string, message: ChatMessage): void
  /** Opens a report that is not a transcript message: one from the read-out (`takeReport`). */
  showReport(open: OpenContextReport): void
  /** The failed opening shows its earlier report instead. */
  showEarlier(): void
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
  show: (sessionId, message) => {
    const open = openingOf(sessionId, message)
    if (open) set({ open })
  },
  showReport: (open) => set({ open }),
  showEarlier: () => {
    const open = get().open
    if (open?.phase !== 'failed' || !open.earlier) return
    set({ open: { ...open, phase: 'ready', snapshot: open.earlier, failure: undefined, earlier: undefined } })
  },
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
