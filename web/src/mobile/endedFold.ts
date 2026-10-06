import { api } from '../lib/api'
import { useOrbital } from '../store/store'
import { useMobile } from './state'

/**
 * The list's ENDED fold (canvas 10a), read only when it is opened: the
 * phone's list asks the Mac to leave unpinned ended sessions out
 * (`ended: 'exclude'`) and gets a count of them instead, so a long history of
 * finished sessions costs nothing until someone looks at it.
 */

/**
 * Ended sessions the store holds that the Mac's summary already counts: they
 * were ended when the list was read and reached the store some other way
 * since — opened from a notification, republished by a rename on the Mac.
 * Sessions that ended while the phone watched are not here; the header adds
 * them to the summary's count.
 */
const counted = new Set<string>()

/** Whether the summary already counts this held ended session (`endedHeading`). */
export function countedBySummary(id: string): boolean {
  return counted.has(id)
}

/**
 * Called right after a list without the fold was seated: every unpinned ended
 * session held now came from outside that list, so the summary read with it
 * counts it.
 */
export function markSummarized(): void {
  counted.clear()
  for (const session of Object.values(useOrbital.getState().sessions)) {
    if (session.status === 'ended' && !session.pinnedAt) counted.add(session.id)
  }
}

/** Follows the store: an ended session first heard of now is counted already; one seen running is not. */
export function wireEndedFold(): () => void {
  return useOrbital.subscribe((state, prev) => {
    if (state.sessions === prev.sessions) return
    for (const session of Object.values(state.sessions)) {
      if (session.status !== 'ended') counted.delete(session.id)
      else if (!(session.id in prev.sessions)) counted.add(session.id)
    }
  })
}

/** A forgotten Mac's sessions say nothing about the next one's. */
export function forgetEndedFold(): void {
  counted.clear()
}

let loading: Promise<void> | null = null

/** Reads the fold once and adds it to the store; a failure leaves it unread, for the next opening to ask again. */
export function loadEndedFold(): Promise<void> {
  if (useMobile.getState().endedLoaded) return Promise.resolve()
  loading ??= (async () => {
    try {
      const page = await api.listSessionPage({ ended: 'only' })
      useOrbital.getState().mergeSessions(page.sessions)
      useMobile.setState({ endedLoaded: true })
    } catch {
      // Offline or refused: the header keeps the summary's count.
    } finally {
      loading = null
    }
  })()
  return loading
}
