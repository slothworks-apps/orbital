import { useOrbital } from '../store/store'
import { cancelCacheWrite } from './cacheWriter'
import { forgetEndedFold } from './endedFold'
import { useBanner } from './notify'
import { clearCaches } from './platform/cache'
import { forgetIdentity } from './platform/identity'
import { clearImageCache } from './platform/imageCache'
import { clearDeliveredNotifications } from './platform/localNotify'
import { clearFileCache } from './files/fileCache'
import { clearHarnessCache } from './harness/harnessCache'
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
  // The user's choice, not the Mac's: the old relay still has this phone's
  // row and would go on pushing for that Mac. An empty token stops it — sent
  // on the live link, best-effort, before the link goes. After a revoke the
  // Mac no longer lists the phone, so nothing would be pushed anyway.
  if (!opts.unpaired) {
    try {
      clientRef.client?.pushToken('')
    } catch (err) {
      console.warn('[mobile] could not clear the push token on the old relay', err)
    }
  }
  clientRef.set(null)
  // Nothing about the old Mac stays on screen or in the shade.
  useBanner.getState().dismiss()
  void clearDeliveredNotifications()
  if (opts.unpaired) {
    try {
      // The flag before the pairing goes: a kill in between still lands on 9h, not the scanner.
      await setUnpaired(name)
    } catch (err) {
      console.warn('[mobile] could not mark the Mac unpaired', err)
    }
  }
  // Independent of each other and of the flag above: one failing clear must not skip the rest.
  const clears = await Promise.allSettled([
    clearPairing(), forgetIdentity(), clearCaches(), clearImageCache(), clearHarnessCache(), clearFileCache(),
  ])
  for (const result of clears) {
    if (result.status === 'rejected') console.warn('[mobile] could not clear everything stored for the Mac', result.reason)
  }
  // No store action leaves a session without side effects, so the old Mac's
  // selection, transcripts and harnesses are dropped here: the next pairing's resync
  // must not `select()` a session that Mac owns. Before the seat, which
  // would otherwise keep the selected session.
  useOrbital.setState((s) => ({
    transcripts: {}, historyLoaded: {}, ui: { ...s.ui, selectedId: null, fileViewer: null },
    harnesses: {}, harnessRemoved: {}, harnessEvents: {}, harnessEventsMore: {},
  }))
  useOrbital.getState().seatSessions([], [])
  forgetEndedFold()
  useMobile.setState({
    pairing: null, link: 'off', macOnline: false, ready: false,
    asOf: null, checkedAt: null, rechecking: null, listedAt: null, endedSummary: null, endedLoaded: false,
    sessionId: null, pushed: [], composerIntent: null, mismatch: null, previous: null,
    unpaired: opts.unpaired,
    macName: opts.unpaired ? name : null,
    screen: opts.unpaired ? 'unpaired' : 'pairing',
  })
}
