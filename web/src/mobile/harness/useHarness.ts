import { useEffect } from 'react'
import type { HarnessEvent, SessionHarness } from '../../lib/types'
import { useOrbital } from '../../store/store'
import { loadHarnessCache, useHarnessCache } from './harnessCache'

const NO_EVENTS: HarnessEvent[] = []

export interface HeldHarness {
  harness: SessionHarness | null
  removed: SessionHarness | null
  events: HarnessEvent[]
  /** When the cached copy was read live; null for the store's own, live one. */
  asOf: number | null
}

/**
 * The session's harness and its log: the store's once it has read them
 * (`useHarnessRows` asks when the screen opens, the store again on every
 * `harness` event), else the copy cached the last time they were read live —
 * what the card and the sheet show while the Mac sleeps (canvas 10c). Null
 * while there is neither.
 */
export function useHarness(sessionId: string): HeldHarness {
  const live = useOrbital((s) => s.harnesses[sessionId])
  const liveRemoved = useOrbital((s) => s.harnessRemoved[sessionId] ?? null)
  const liveEvents = useOrbital((s) => s.harnessEvents[sessionId] ?? NO_EVENTS)
  const cached = useHarnessCache((s) => s.held[sessionId])

  useEffect(() => {
    if (sessionId && live === undefined) void loadHarnessCache(sessionId)
  }, [sessionId, live])

  if (live !== undefined) return { harness: live, removed: liveRemoved, events: liveEvents, asOf: null }
  if (cached) return { ...cached.value, asOf: cached.asOf }
  return { harness: null, removed: null, events: NO_EVENTS, asOf: null }
}
