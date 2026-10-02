import { create } from 'zustand'
import type { LinkStatus, RemoteClientEvent } from '@orbital/shared/remote/client'
import type { Pairing } from './platform/parse'
import { MIN_SERVER_VERSION, isSupportedServer } from './version'

/** Navigation is in-memory state, not URLs (spec § 5). */
export type Screen = 'pairing' | 'list' | 'session' | 'settings' | 'unpaired' | 'mismatch'

/**
 * Relay `error` codes that mean this phone's pair no longer exists (spec
 * § 4). The relay sends none of them today; this is where one goes when it
 * does, and anything else is not about the pair.
 */
export const UNPAIRED_RELAY_ERRORS: ReadonlySet<string> = new Set(['not_paired', 'unknown_device'])

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
  mismatch: { macVersion: string | null; needed: string } | null
  unpaired: boolean
  pairing: Pairing | null
  macName: string | null
}

export const initialMobileState: MobileState = {
  screen: 'pairing', previous: null, sessionId: null, link: 'off', macOnline: false, ready: false,
  asOf: null, checkedAt: null, mismatch: null, unpaired: false, pairing: null, macName: null,
}

/** The pair is over, by the Mac's hand or the relay's word (spec § 4). */
export function isPairGone(event: RemoteClientEvent): boolean {
  return (
    (event.type === 'bye' && event.reason === 'revoked') ||
    event.type === 'unpaired' ||
    (event.type === 'relay_error' && UNPAIRED_RELAY_ERRORS.has(event.code))
  )
}

/** What one client event changes (spec § 5: offline, 9h, 9i). Pure; `useMobile.apply` writes it. */
export function reduce(state: MobileState, event: RemoteClientEvent, now: number): Partial<MobileState> {
  if (isPairGone(event)) {
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
      return { screen: 'list' }
    case 'pairing':
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
