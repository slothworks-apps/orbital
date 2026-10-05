import type { HarnessEvent, SessionHarness } from '../../lib/types'
import { useOrbital } from '../../store/store'

const NO_EVENTS: HarnessEvent[] = []

/**
 * The session's live harness and its log, as the store holds them (read by
 * `useHarnessRows` when the screen opens, and again on every `harness`
 * event). Null while there is none, or none read yet.
 */
export function useHarness(sessionId: string): { harness: SessionHarness | null; events: HarnessEvent[] } {
  const harness = useOrbital((s) => s.harnesses[sessionId] ?? null)
  const events = useOrbital((s) => s.harnessEvents[sessionId] ?? NO_EVENTS)
  return { harness, events }
}
