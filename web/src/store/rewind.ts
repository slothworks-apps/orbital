import { create } from 'zustand'
import { api } from '../lib/api'
import { nothingPending, rewindStartFailure } from '../lib/rewind'
import type { ChatMessage } from '../lib/types'
import { useOrbital } from './store'

/**
 * Rewind's UI state (spec 2026-09-29-rewind-design § Behaviour; canvas
 * `Feature - Rewind v2` 27a–27c), kept out of the main store the way
 * compaction's is — nothing but the panel and the transcript read it.
 *
 * - `pick`: the session in pick mode. One at a time: pick mode belongs to the
 *   panel a window shows, and a window shows one session.
 * - `picked`: the row picked, held while the stop dialog asks
 *   (`confirming`) and while the pick is on its way to the server — the
 *   transcript keeps its ring and preview meanwhile (27b: "the picked message
 *   keeps its ring behind the scrim").
 *
 * The pending rewind itself is not here: it is the server's
 * (`ApiSession.rewindPending`), so the detached window, a reload and a
 * restart all show the same state.
 */
export interface RewindPick {
  sessionId: string
  messageId: string
  uuid: string
  hiddenCount: number
  confirming: boolean
}

interface RewindUiState {
  pick: string | null
  picked: RewindPick | null
  /** ↶ next to Send: toggles pick mode for `sessionId`. */
  togglePick(sessionId: string): void
  /** Esc, Cancel, a send, a session switch. */
  leavePick(): void
  /** "Keep running": the pick is dropped and nothing is sent. */
  dismissConfirm(): void
}

export const useRewindUi = create<RewindUiState>((set, get) => ({
  pick: null,
  picked: null,
  togglePick: (sessionId) => {
    if (get().picked) return
    set({ pick: get().pick === sessionId ? null : sessionId })
  },
  leavePick: () => {
    if (get().pick !== null) set({ pick: null })
  },
  dismissConfirm: () => {
    if (get().picked?.confirming) set({ picked: null })
  },
}))

/**
 * Whether the session has something running that the rewind would end — a
 * turn, a background task, a subagent. Then the stop dialog asks first
 * (spec § Behaviour 4); otherwise the pick goes straight through.
 */
function needsConfirmation(sessionId: string): boolean {
  const session = useOrbital.getState().sessions[sessionId]
  if (!session) return false
  return (
    session.status === 'working' ||
    (session.backgroundTasks ?? []).some((t) => t.state === 'running') ||
    session.subagents.some((s) => s.state !== 'ended')
  )
}

/** A row clicked in pick mode. */
export function pickRewindTarget(sessionId: string, message: ChatMessage, hiddenCount: number): void {
  if (!message.uuid) return
  const picked: RewindPick = {
    sessionId,
    messageId: message.id,
    uuid: message.uuid,
    hiddenCount,
    confirming: needsConfirmation(sessionId),
  }
  useRewindUi.setState({ pick: null, picked })
  if (!picked.confirming) void startRewind(picked)
}

/** "Stop and rewind": the server stops the session itself. */
export function confirmRewind(): void {
  const picked = useRewindUi.getState().picked
  if (!picked?.confirming) return
  const next = { ...picked, confirming: false }
  useRewindUi.setState({ picked: next })
  void startRewind(next)
}

/**
 * Asks the server for the rewind. On success the transcript is cut before the
 * picked message at once (the server's own `transcript_reset` re-reads it as
 * well), the composer takes the picked text, and the session carries the
 * pending row until the upsert confirms it. A refusal here never shows the
 * pending state: the transcript and the draft stay as they were, and the
 * toast says why (canvas 27c, RULES).
 */
async function startRewind(picked: RewindPick): Promise<void> {
  const { sessionId, uuid, hiddenCount, messageId } = picked
  const store = useOrbital.getState()
  const draft = store.composerDrafts[sessionId] ?? ''
  try {
    const { text } = await api.startRewind(sessionId, { uuid, hiddenCount, draft })
    useOrbital.setState((state) => {
      const session = state.sessions[sessionId]
      const held = state.transcripts[sessionId]
      const cut = held?.findIndex((m) => m.id === messageId) ?? -1
      return {
        ...(session
          ? { sessions: { ...state.sessions, [sessionId]: { ...session, rewindPending: { hiddenCount, text } } } }
          : {}),
        // The rows from the pick on go now; a reload would keep a just-sent
        // turn the file has not echoed, and that turn may be the one picked.
        ...(held && cut >= 0 ? { transcripts: { ...state.transcripts, [sessionId]: held.slice(0, cut) } } : {}),
      }
    })
    useOrbital.getState().setComposerDraft(sessionId, text)
    void useOrbital.getState().reloadTranscript(sessionId).catch(() => {
      // The server's own reset re-reads it; nothing to add.
    })
  } catch (err) {
    useOrbital.setState({ toast: { kind: 'error', message: rewindStartFailure(err) } })
  } finally {
    if (useRewindUi.getState().picked?.messageId === messageId) useRewindUi.setState({ picked: null })
  }
}

/**
 * "Cancel rewind" (spec § Behaviour 6): the hidden messages come back and the
 * composer gets back the draft it held before the pick, exactly. Answered
 * "nothing pending", the rewind is already gone — sent, refused, or
 * cancelled in the other window — and the strip just goes.
 */
export async function cancelRewind(sessionId: string): Promise<void> {
  const clearPending = () =>
    useOrbital.setState((state) => {
      const session = state.sessions[sessionId]
      return session ? { sessions: { ...state.sessions, [sessionId]: { ...session, rewindPending: null } } } : {}
    })
  try {
    const { draft } = await api.cancelRewind(sessionId)
    clearPending()
    useOrbital.getState().setComposerDraft(sessionId, draft)
    void useOrbital.getState().reloadTranscript(sessionId).catch(() => {})
  } catch (err) {
    if (nothingPending(err)) {
      clearPending()
      return
    }
    const message = err instanceof Error && err.message ? err.message : 'Failed to cancel the rewind'
    useOrbital.setState({ toast: { kind: 'error', message } })
  }
}
