import { useOrbital } from '../store/store'
import { cancelCacheWrite } from './cacheWriter'
import { forgetEndedFold } from './endedFold'
import { useBanner } from './notify'
import { clearCaches } from './platform/cache'
import { forgetIdentity } from './platform/identity'
import { clearImageCache } from './platform/imageCache'
import { clearDeliveredNotifications } from './platform/localNotify'
import { clearFileCache } from './files/fileCache'
import { clearRecentFiles } from './files/recentFiles'
import { clearHarnessCache } from './harness/harnessCache'
import { clearGroup } from './platform/group'
import { clearPairing, setUnpaired } from './platform/pairing'
import { useMobile } from './state'
import { clientRef } from './transport/clientRef'
import { groupRef } from './transport/groupRef'

/** Why the phone could not leave its group: the relay is not reached, or the group could not be written. */
export type LeaveResult = { ok: true } | { error: 'offline' | 'failed' }

/** "Leave this group" when it cannot leave: the other devices must hear of it, through the relay. Provisional copy. */
export const LEAVE_OFFLINE = "Can't reach the relay. Try again when this phone is online."
export const LEAVE_FAILED = "Couldn't leave the group on this phone. Try again."

/**
 * "Leave this group" (canvas 50i): the phone leaves its group — every member
 * hears of it and its pairs go at the relay — then forgets everything as
 * `forgetEverything` does, but keeps its key: the key is its id, and a new
 * group can take it. Refused while the relay is not online.
 */
export async function leaveGroup(): Promise<LeaveResult> {
  const handle = groupRef.current
  if (handle) {
    const left = await handle.group.leave()
    if ('error' in left) return { error: left.error === 'offline' ? 'offline' : 'failed' }
  } else {
    // No group running (its connect failed): the members go on listing this phone until they remove it.
    console.warn('[mobile] leaving with no group running; the other devices are not told')
  }
  await forgetEverything({ unpaired: false })
  return { ok: true }
}

/**
 * The way out when leaving is refused because the relay cannot be reached,
 * perhaps for good: the phone forgets its group as leaving does, without
 * telling anyone. The other devices go on listing it until someone removes
 * it there.
 */
export async function forgetGroupHere(): Promise<void> {
  console.warn('[mobile] forgetting the group on this phone only; the other devices are not told')
  await forgetEverything({ unpaired: false })
}

/**
 * Everything this phone knows about its group goes: the link, the stored
 * group and pairing, the caches (spec § 4). `unpaired` is the group's doing
 * — it removed this phone — and 9h then shows on every launch until a new
 * pairing; the key goes too, as before groups. Without it the user left
 * (`leaveGroup`), the key stays, and the scanner comes next.
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
  // Nothing more is written for the group: a write still waiting would put it back after the clear.
  const handle = groupRef.current
  // Whatever client is held goes with it: `groupRef.set` clears `clientRef` too.
  groupRef.set(null)
  try {
    await handle?.close()
  } catch (err) {
    console.warn('[mobile] could not stop storing the group', err)
  }
  clearRecentFiles()
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
    clearGroup(), clearPairing(), ...(opts.unpaired ? [forgetIdentity()] : []),
    clearCaches(), clearImageCache(), clearHarnessCache(), clearFileCache(),
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
    devices: [], refusals: {}, members: [], pendingPair: null, ownCode: null, macVersion: null,
    unpaired: opts.unpaired,
    macName: opts.unpaired ? name : null,
    screen: opts.unpaired ? 'unpaired' : 'pairing',
  })
}
