import { useOrbital } from '../store/store'
import { cancelCacheWrite } from './cacheWriter'
import { clearCaches } from './platform/cache'
import { forgetIdentity } from './platform/identity'
import { clearImageCache } from './platform/imageCache'
import { clearPairing, setUnpaired } from './platform/pairing'
import { useMobile } from './state'
import { clientRef } from './transport/clientRef'

/**
 * Everything this phone knows about its Mac goes: the link, the pairing,
 * the identity, the caches (spec § 4). `unpaired` is the Mac's doing — a
 * revoke reached us — and 9h then shows on every launch until a new
 * pairing. Without it the user chose "Pair a different Mac" (9f), and the
 * scanner comes next.
 */
export async function forgetEverything(opts: { unpaired: boolean }): Promise<void> {
  const { macName, pairing } = useMobile.getState()
  const name = macName ?? pairing?.macName ?? ''
  // Not live and not paired from here on, so neither a write still waiting
  // nor the reseat below can put this Mac back into the cache.
  useMobile.setState({ ready: false, pairing: null })
  cancelCacheWrite()
  clientRef.set(null)
  // The flag before the pairing goes: a kill in between still lands on 9h, not the scanner.
  if (opts.unpaired) await setUnpaired(name)
  await clearPairing()
  await Promise.all([forgetIdentity(), clearCaches(), clearImageCache()])
  useOrbital.getState().seatSessions([], [])
  // No store action leaves a session without side effects, so the old Mac's
  // selection and transcripts are dropped here: the next pairing's resync
  // must not `select()` a session that Mac owns.
  useOrbital.setState((s) => ({
    transcripts: {}, historyLoaded: {}, ui: { ...s.ui, selectedId: null, fileViewer: null },
  }))
  useMobile.setState({
    pairing: null, link: 'off', macOnline: false, ready: false, asOf: null, checkedAt: null,
    sessionId: null, mismatch: null, previous: null,
    unpaired: opts.unpaired,
    macName: opts.unpaired ? name : null,
    screen: opts.unpaired ? 'unpaired' : 'pairing',
  })
}
