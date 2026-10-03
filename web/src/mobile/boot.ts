import { App } from '@capacitor/app'
import type { RemoteClientEvent } from '@orbital/shared/remote/client'
import { configureApi } from '../lib/api'
import { configureImages } from '../lib/images'
import { configureSocket, getSocket } from '../lib/socket'
import { configureTranscriptPages, useOrbital, type ErrorsEvent, type SessionsEvent } from '../store/store'
import { connect, recheckOnForeground } from './connect'
import { wireCache } from './cacheWriter'
import { TRANSCRIPT_PAGE_SIZE } from './constants'
import { forgetEverything } from './forget'
import { seedNotifications, setActive, setRules, wireNotifications } from './notify'
import { readNotificationsCache, readSessionsCache } from './platform/cache'
import { readCachedImage, writeCachedImage } from './platform/imageCache'
import { loadPairing, loadUnpaired } from './platform/pairing'
import { installNotificationChannels, installPushListeners, registerPush } from './platform/push'
import { openFromNotice, pairGoneFor, useMobile } from './state'
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
  configureApi({ fetch: makeTunnelFetch(clientRef), upload: makeTunnelUpload(clientRef) })
  configureSocket({ WebSocketImpl: () => new TunnelSocket(clientRef) as unknown as WebSocket })
  configureImages({ resolve: makeImageResolver(clientRef, { read: readCachedImage, write: writeCachedImage }) })
  clientRef.on(onClientEvent)
  wireSocket()
  wireCache()
  await installLifecycle()

  const [pairing, unpaired, cached, rules] = await Promise.all([
    loadPairing(), loadUnpaired(), readSessionsCache(), readNotificationsCache(),
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
  })
  booted = true
  const open = pendingOpen
  pendingOpen = null
  if (!pairing || unpaired) return
  // Only a paired phone has sessions to open.
  open?.()
  await connect(pairing)
  void registerPush()
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
    await useOrbital.getState().loadSessions()
    // The Mac replays nothing on a new tunnel: its list is what the notifier knows from.
    seedNotifications(Object.values(useOrbital.getState().sessions))
    useMobile.setState({ listedAt: Date.now() })
    if (!id) return
    if (useOrbital.getState().historyLoaded[id]) await useOrbital.getState().reloadTranscript(id)
    else await useOrbital.getState().select(id)
  } catch {
    // The next open, or the next return to the foreground, tries again.
  }
}

async function installLifecycle(): Promise<void> {
  try {
    await App.addListener('appStateChange', ({ isActive }) => {
      setActive(isActive)
      if (isActive) void recheckOnForeground()
    })
    await App.addListener('backButton', () => {
      if (useMobile.getState().goBack() === 'exit') void App.minimizeApp()
    })
  } catch {
    // A desktop browser has no app lifecycle to listen to.
  }
}
