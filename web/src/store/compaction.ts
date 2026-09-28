import { create } from 'zustand'
import { compactConfirmCount } from '../lib/compaction'
import { useOrbital } from './store'

/**
 * The two pieces of UI state context compaction adds (spec
 * 2026-09-28-context-compaction-design), kept out of the main store because
 * nothing else reads them:
 *
 * - `confirm`: a `/compact` waiting on the "subagents are running" dialog.
 *   Every route that sends one — the composer, the map's `/compact` badge,
 *   `/compact again` via the composer — goes through `sendCompactAware`.
 * - `reveal`: a session whose newest failed-compaction mark the transcript
 *   should scroll to, set by the map's `COMPACT FAILED` badge.
 */
interface CompactionUiState {
  confirm: { sessionId: string; text: string; count: number } | null
  reveal: string | null
  setConfirm(confirm: CompactionUiState['confirm']): void
  setReveal(sessionId: string | null): void
}

export const useCompactionUi = create<CompactionUiState>((set) => ({
  confirm: null,
  reveal: null,
  setConfirm: (confirm) => set({ confirm }),
  setReveal: (reveal) => set({ reveal }),
}))

/**
 * Sends `text` to the session, unless it is a `/compact` that has to be
 * confirmed first — then it parks it on the dialog and reports `false`, so a
 * caller that clears its draft on send can keep it for a Cancel.
 */
export function sendCompactAware(sessionId: string, text: string): boolean {
  const session = useOrbital.getState().sessions[sessionId]
  const count = compactConfirmCount(text, session)
  if (count > 0) {
    useCompactionUi.getState().setConfirm({ sessionId, text, count })
    return false
  }
  void useOrbital.getState().sendPrompt(sessionId, text)
  return true
}
