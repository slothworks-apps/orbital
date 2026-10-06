import { create } from 'zustand'
import type { ChatMessage } from '../../lib/types'
import { useOrbital } from '../../store/store'
import { foldStands, type GateFold } from './gate'

const NO_MESSAGES: ChatMessage[] = []

/**
 * This phone's last answer to each session's gate, while the app runs: the
 * card folds into it (canvas 10b `ack`). The tail's key hook and the card
 * both read it, so it lives outside either.
 */
export const useGateFolds = create<{ folds: Record<string, GateFold> }>(() => ({ folds: {} }))

export function setGateFold(sessionId: string, fold: GateFold): void {
  useGateFolds.setState((s) => ({ folds: { ...s.folds, [sessionId]: fold } }))
}

/** The session's fold while it still ends the transcript (`foldStands`), else null. */
export function useGateFold(sessionId: string): GateFold | null {
  const fold = useGateFolds((s) => s.folds[sessionId] ?? null)
  const messages = useOrbital((s) => s.transcripts[sessionId] ?? NO_MESSAGES)
  return fold && foldStands(fold, messages) ? fold : null
}
