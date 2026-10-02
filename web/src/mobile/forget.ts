import { useOrbital } from '../store/store'
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
  clientRef.set(null)
  await Promise.all([clearPairing(), forgetIdentity(), clearCaches(), clearImageCache()])
  if (opts.unpaired) await setUnpaired(name)
  useOrbital.getState().seatSessions([], [])
  useMobile.setState({
    pairing: null, link: 'off', macOnline: false, ready: false, asOf: null, checkedAt: null,
    sessionId: null, mismatch: null, previous: null,
    unpaired: opts.unpaired,
    macName: opts.unpaired ? name : null,
    screen: opts.unpaired ? 'unpaired' : 'pairing',
  })
}
