import { App } from '@capacitor/app'
import type { RemoteClientEvent } from '@orbital/shared/remote/client'
import { configureApi } from '../lib/api'
import { configureImages } from '../lib/images'
import { configureSocket, getSocket } from '../lib/socket'
import { configureTranscriptPages, useOrbital, type ErrorsEvent, type SessionsEvent } from '../store/store'
import { connect, recheckOnForeground } from './connect'
import { wireCache } from './cacheWriter'
import { markSummarized, wireEndedFold } from './endedFold'
import { PHONE_OUTPUT_TAIL_BYTES, PHONE_SUBAGENT_PAGE, TRANSCRIPT_PAGE_SIZE } from './constants'
import { installFileOpen } from './files/open'
import { forgetEverything } from './forget'
import { lockAtStart } from './lock'
import { recheckScreenLock } from './lockFlow'
import { seedNotifications, setActive, setRules, wireNotifications } from './notify'
import { readNotificationsCache, readSessionsCache } from './platform/cache'
import { readCachedImage, writeCachedImage } from './platform/imageCache'
import { loadAppLock } from './platform/appLock'
import { readDeviceLock } from './platform/deviceLock'
import { loadPairing, loadUnpaired } from './platform/pairing'
import { installNotificationChannels, installPushListeners, registerPush } from './platform/push'
import { dismissTopSheet, isGated, lockEnabled, openFromNotice, pairGoneFor, useMobile } from './state'
import { clientRef } from './transport/clientRef'
import { makeImageResolver } from './transport/imageResolver'
import { makeTunnelFetch } from './transport/tunnelFetch'
import { TunnelSocket } from './transport/tunnelSocket'
import { makeTunnelUpload } from './transport/tunnelUpload'

/**
 * A notification tapped to start the app arrives while boot is still
 * choosing a screen; it waits here and runs once boot has chosen one.
 */
let booted = false
let pendingOpen: (() => void) | null = null

function afterBoot(open: () => void): void {
  if (booted) open()
  else pendingOpen = open
}

/**
 * Wires the phone once, before the first render (spec § 3): the four seams
 * pointed at the tunnel, the hub topics the list needs, the cache, the app
 * lifecycle, notifications, and the paired Mac's link when there is one.
 */
export async function boot(): Promise<void> {
  // First, before anything awaits: a cold start from a tap must find its listener (spec § 6.5).
  installPushListeners({
    openList: () => afterBoot(() => openFromNotice(() => useMobile.getState().go('list'))),
    openSession: (id) => afterBoot(() => openFromNotice(() => useMobile.getState().openSession(id))),
  })
  void installNotificationChannels()
  wireNotifications()
  configureTranscriptPages(TRANSCRIPT_PAGE_SIZE)
  configureApi({
    fetch: makeTunnelFetch(clientRef),
    upload: makeTunnelUpload(clientRef),
    // Each answer must fit one relay frame (spec 2026-10-05-mobile-next § 3).
    subagentPageSize: PHONE_SUBAGENT_PAGE,
    taskOutputMaxBytes: PHONE_OUTPUT_TAIL_BYTES,
  })
  configureSocket({ WebSocketImpl: () => new TunnelSocket(clientRef) as unknown as WebSocket })
  configureImages({ resolve: makeImageResolver(clientRef, { read: readCachedImage, write: writeCachedImage }) })
  installFileOpen()
  clientRef.on(onClientEvent)
  wireSocket()
  wireCache()
  wireEndedFold()
  await installLifecycle()

  // The device lock is read before the first screen: without a screen lock
  // 9s stands in front of everything, pairing included.
  const [pairing, unpaired, cached, rules, appLock, device] = await Promise.all([
    loadPairing(), loadUnpaired(), readSessionsCache(), readNotificationsCache(), loadAppLock(), readDeviceLock(),
  ])
  if (rules) setRules(rules.value)
  if (cached) {
    useOrbital.getState().seatSessions(cached.value.sessions, cached.value.tags)
    useMobile.setState({ asOf: cached.asOf })
  }
  useMobile.setState({
    pairing,
    unpaired: unpaired !== null,
    macName: pairing?.macName ?? unpaired?.macName ?? null,
    screen: unpaired ? 'unpaired' : pairing ? 'list' : 'pairing',
    appLock,
    screenLock: !device.secure,
    lockLabel: device.label,
    lock: lockAtStart(lockEnabled({ appLock, pairing })),
  })
  booted = true
  const open = pendingOpen
  pendingOpen = null
  if (!pairing || unpaired) return
  // Only a paired phone has sessions to open; behind 9s or 9t the tap waits (`openFromNotice`).
  open?.()
  try {
    await connect(pairing)
  } finally {
    // Whatever connect met: the client keeps the token for the link the next connect builds.
    void registerPush()
  }
}

function onClientEvent(event: RemoteClientEvent): void {
  // Read before `apply`, which clears the pairing when the pair is gone.
  const gone = pairGoneFor(event, useMobile.getState().pairing)
  useMobile.getState().apply(event)
  if (gone) {
    // Deleted on first contact, then 9h (spec § 4).
    forgetEverything({ unpaired: true }).catch((err: unknown) => console.warn('[mobile] could not forget the pair', err))
    return
  }
  if (event.type === 'hub') refetchDropped(event.frame)
  // A new pair: the relay has a row for this device now, and the token can go to it.
  if (event.type === 'paired') void registerPush()
}

/** A hub frame too large for one relay frame arrives as `dropped` (parent § 7): read that session's page again. */
function refetchDropped(frame: unknown): void {
  const f = frame as { topic?: unknown; event?: unknown } | null
  if (f?.event !== 'dropped' || typeof f.topic !== 'string' || !f.topic.startsWith('session:')) return
  const id = f.topic.slice('session:'.length)
  useOrbital.getState().reloadTranscript(id).catch((err: unknown) => console.warn('[mobile] could not reload a dropped transcript', err))
}

function wireSocket(): void {
  const socket = getSocket()
  socket.subscribe('sessions', (msg: SessionsEvent) => useOrbital.getState().queueSessionsEvent(msg))
  socket.subscribe('errors', (msg: ErrorsEvent) => useOrbital.getState().applyErrorsEvent(msg))
  // Every open is a new tunnel, and nothing said while it was down is replayed (parent § 4).
  socket.onStatusChange((status) => {
    if (status === 'open') void resync()
  })
}

/** The list and the open transcript, read again over the tunnel. */
export async function resync(): Promise<void> {
  try {
    const id = useOrbital.getState().ui.selectedId
    // The ENDED fold, once opened, is read again with the list: the seat
    // replaces the map, and the fold would close itself otherwise.
    const endedToo = useMobile.getState().endedLoaded
    const endedSummary = await useOrbital.getState().loadSessions({ endedToo })
    if (!endedToo) markSummarized()
    // The Mac replays nothing on a new tunnel: its list is what the notifier knows from.
    seedNotifications(Object.values(useOrbital.getState().sessions))
    // No summary is a Mac that sent every session: nothing is left to read.
    useMobile.setState({ listedAt: Date.now(), endedSummary, endedLoaded: endedToo || endedSummary === null })
    if (!id) return
    if (useOrbital.getState().historyLoaded[id]) {
      // What ended while the tunnel was down, and the session itself when the list left it out.
      await Promise.all([useOrbital.getState().reloadTranscript(id), useOrbital.getState().loadSessionHistory(id)])
    } else await useOrbital.getState().select(id)
  } catch {
    // The next open, or the next return to the foreground, tries again.
  }
}

async function installLifecycle(): Promise<void> {
  try {
    await App.addListener('appStateChange', ({ isActive }) => {
      setActive(isActive)
      if (!isActive) {
        // At once, before the system takes the app-switcher snapshot.
        useMobile.getState().leaveForeground()
        return
      }
      useMobile.getState().returnToForeground()
      // Checked again on every return: 9s says so, and a lock set meanwhile lifts it.
      void recheckScreenLock()
      void recheckOnForeground()
    })
    await App.addListener('backButton', () => {
      // Behind 9s or 9t nothing underneath may be navigated: back leaves the app.
      if (isGated(useMobile.getState())) {
        void App.minimizeApp()
        return
      }
      if (dismissTopSheet()) return
      if (useMobile.getState().goBack() === 'exit') void App.minimizeApp()
    })
  } catch {
    // A desktop browser has no app lifecycle to listen to.
  }
}
