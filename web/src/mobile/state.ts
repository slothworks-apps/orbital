import { create } from 'zustand'
import type { LinkStatus, RemoteClientEvent } from '@orbital/shared/remote/client'
import type { Pairing } from './platform/parse'
import { MIN_SERVER_VERSION, isSupportedServer } from './version'

/** Navigation is in-memory state, not URLs (spec § 5). */
export type Screen = 'pairing' | 'list' | 'session' | 'settings' | 'new' | 'unpaired' | 'mismatch'

/**
 * Relay `error` codes that mean this phone's pair no longer exists (spec
 * § 4); anything else is not about the pair. `bad_secret` is the client's
 * word for a relay secret the relay refused: the relay was re-keyed, and only
 * a new code carries the new secret (ADR the-relay-takes-a-shared-secret).
 */
export const UNPAIRED_RELAY_ERRORS: ReadonlySet<string> = new Set(['not_paired', 'unknown_device', 'bad_secret'])

export interface MobileState {
  screen: Screen
  /** Where 9e's Cancel and the back button return to from pairing. */
  previous: Screen | null
  sessionId: string | null
  /** The relay link (9a header: `connecting` is the dim dot). */
  link: LinkStatus
  macOnline: boolean
  /** A live tunnel: cipher and the Mac's hello. */
  ready: boolean
  /** When live data last arrived; what the offline card's "as of" reads. */
  asOf: number | null
  /** When the last Retry or foreground check finished ("checked just now"). */
  checkedAt: number | null
  /**
   * Set while a Retry or a foreground check is in flight, holding what
   * `isMacAsleep` answered when it began: the check rebuilds the relay link,
   * and the drop it makes on the way must not flash the offline card.
   */
  rechecking: { asleep: boolean } | null
  /** When the Mac's session list was last read over the tunnel (9e's "N live sessions are waiting."). */
  listedAt: number | null
  mismatch: { macVersion: string | null; needed: string } | null
  unpaired: boolean
  pairing: Pairing | null
  macName: string | null
}

export const initialMobileState: MobileState = {
  screen: 'pairing', previous: null, sessionId: null, link: 'off', macOnline: false, ready: false,
  asOf: null, checkedAt: null, rechecking: null, listedAt: null,
  mismatch: null, unpaired: false, pairing: null, macName: null,
}

/**
 * The Mac is away while the relay is not (spec § 5, "Transport states"): the
 * 9a offline card and 9b's offline transcript. A relay still connecting is
 * the header's dim dot and nothing else; while a check runs (`rechecking`)
 * the answer from before it holds.
 */
export function isMacAsleep(state: Pick<MobileState, 'link' | 'macOnline' | 'rechecking'>): boolean {
  if (state.rechecking) return state.rechecking.asleep
  return state.link === 'online' && !state.macOnline
}

/** The pair is over, by the Mac's hand or the relay's word (spec § 4). */
export function isPairGone(event: RemoteClientEvent): boolean {
  return (
    (event.type === 'bye' && event.reason === 'revoked') ||
    event.type === 'unpaired' ||
    (event.type === 'relay_error' && UNPAIRED_RELAY_ERRORS.has(event.code))
  )
}

/**
 * Whether a notice — 9g's View, a local notification's tap, a relay push's
 * tap — may take the reader anywhere: only with a pair that works. Unpaired,
 * mismatched or not yet paired, the screen showing is the only one there is.
 */
export function mayOpenFromNotice(state: Pick<MobileState, 'pairing' | 'unpaired' | 'mismatch'>): boolean {
  return state.pairing !== null && !state.unpaired && state.mismatch === null
}

/**
 * `isPairGone` for this phone as it stands. A refused relay secret ends a
 * pair only when one is stored: mid-pairing there is none to lose, and the
 * pairing run reports the refusal on its own screen instead of 9h.
 */
export function pairGoneFor(event: RemoteClientEvent, pairing: Pairing | null): boolean {
  if (event.type === 'relay_error' && event.code === 'bad_secret' && pairing === null) return false
  return isPairGone(event)
}

/** What one client event changes (spec § 5: offline, 9h, 9i). Pure; `useMobile.apply` writes it. */
export function reduce(state: MobileState, event: RemoteClientEvent, now: number): Partial<MobileState> {
  if (pairGoneFor(event, state.pairing)) {
    return { screen: 'unpaired', unpaired: true, sessionId: null, pairing: null, ready: false }
  }
  switch (event.type) {
    case 'status':
      return { link: event.status }
    case 'presence':
      return { macOnline: event.macOnline }
    case 'ready':
      return event.ready ? { ready: true, asOf: now } : { ready: false }
    case 'hub':
      return { asOf: now }
    case 'hello':
      if (!isSupportedServer(event.server)) {
        return {
          screen: 'mismatch', macName: event.macName,
          mismatch: { macVersion: event.server, needed: MIN_SERVER_VERSION },
        }
      }
      return { mismatch: null, macName: event.macName, ...(state.screen === 'mismatch' ? { screen: 'list' as const } : {}) }
    case 'bye':
      // The Mac refused our protocol version; it says no more than that.
      return {
        screen: 'mismatch',
        mismatch: { macVersion: state.mismatch?.macVersion ?? null, needed: MIN_SERVER_VERSION },
      }
    default:
      return {}
  }
}

/** The hardware back button (spec § 5): one level up; from the list, out of the app. */
export function back(state: MobileState): Partial<MobileState> | 'exit' {
  switch (state.screen) {
    case 'session':
      return { screen: 'list', sessionId: null }
    case 'settings':
    case 'new':
      return { screen: 'list' }
    case 'pairing':
      // Paired already (back on "Paired with", or while it waits for hello): the list, not where pairing began.
      if (state.pairing) return { screen: 'list', previous: null }
      return state.previous ? { screen: state.previous, previous: null } : 'exit'
    default:
      return 'exit'
  }
}

interface MobileActions {
  apply(event: RemoteClientEvent): void
  go(screen: Screen): void
  openSession(id: string): void
  goBack(): 'exit' | 'stayed'
}

export const useMobile = create<MobileState & MobileActions>()((set, get) => ({
  ...initialMobileState,
  apply: (event) => set(reduce(get(), event, Date.now())),
  go: (screen) => set((s) => ({ screen, previous: s.screen })),
  openSession: (id) => set({ screen: 'session', sessionId: id }),
  goBack: () => {
    const next = back(get())
    if (next === 'exit') return 'exit'
    set(next)
    return 'stayed'
  },
}))

/**
 * The one guard 9g's View, a local notification's tap and a relay push's tap
 * share: `open` runs only while `mayOpenFromNotice`; otherwise the tap is
 * ignored.
 */
export function openFromNotice(open: () => void): void {
  if (mayOpenFromNotice(useMobile.getState())) open()
}
