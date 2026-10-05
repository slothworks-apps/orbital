import { useEffect, useMemo } from 'react'
import { withHarnessRows } from '../../lib/harnessSession'
import type { ApiSession, ChatMessage, SessionHarness } from '../../lib/types'
import { useOrbital } from '../../store/store'
import { keepHarness } from '../harness/harnessCache'
import { useHarness } from '../harness/useHarness'

/**
 * The transcript as the phone shows it: Orbital's harness messages and the
 * harness log's events as the desktop's dashed ◆ rows (spec
 * 2026-10-05-mobile-next § 1; desktop `Transcript.tsx` does the same). The
 * harness is read over the tunnel when the screen opens an Orbital session
 * — the store's `select` does not — and the store reads it again on every
 * `harness` event of the session's topic. Its log is paged back as far as
 * the transcript held reaches. Every live read is cached (`harness:<id>`),
 * and while the Mac sleeps the rows, the card and the sheet read that copy.
 */
export function useHarnessRows(
  session: Pick<ApiSession, 'id' | 'source'> | undefined,
  messages: ChatMessage[],
  exhausted: boolean,
  ready: boolean,
): ChatMessage[] {
  const id = session?.id
  // Only Orbital's own sessions can take a harness: it sends each step on itself.
  const orbital = session?.source === 'web'
  const live = useOrbital((s) => (id ? s.harnesses[id] : undefined))
  const moreEvents = useOrbital((s) => Boolean(id && s.harnessEventsMore[id]))
  const { harness, removed, events } = useHarness(id ?? '')

  useEffect(() => {
    if (id && orbital && ready && live === undefined) void useOrbital.getState().loadHarness(id)
  }, [id, orbital, ready, live])

  // What was read live is what the Mac asleep will show.
  useEffect(() => {
    if (id && orbital && ready && live !== undefined) keepHarness(id, { harness: live, removed, events }, Date.now())
  }, [id, orbital, ready, live, removed, events])

  const since = useMemo(() => {
    if (exhausted) return null
    const first = messages.find((m) => m.timestamp)
    return first?.timestamp ? Date.parse(first.timestamp) : null
  }, [messages, exhausted])
  const oldestEventAt = events.length > 0 ? events[events.length - 1].at : null
  useEffect(() => {
    if (id && ready && moreEvents && oldestEventAt !== null && (since === null || oldestEventAt > since)) {
      void useOrbital.getState().loadOlderHarnessEvents(id)
    }
  }, [id, ready, moreEvents, oldestEventAt, since])

  return useMemo(() => {
    if (!orbital) return messages
    const harnesses = [harness, removed].filter((h): h is SessionHarness => h != null)
    return withHarnessRows(messages, events, harnesses, since)
  }, [orbital, messages, events, harness, removed, since])
}
