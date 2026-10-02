import { App } from '@capacitor/app'
import type { RemoteClientEvent } from '@orbital/shared/remote/client'
import { configureApi } from '../lib/api'
import { configureImages } from '../lib/images'
import { configureSocket, getSocket } from '../lib/socket'
import { useOrbital, type ErrorsEvent, type SessionsEvent } from '../store/store'
import { connect } from './connect'
import { CACHE_WRITE_DEBOUNCE_MS, RETRY_WINDOW_MS, TRANSCRIPT_PAGE_SIZE } from './constants'
import { forgetEverything } from './forget'
import { readSessionsCache, writeSessionsCache, writeTranscriptCache } from './platform/cache'
import { readCachedImage, writeCachedImage } from './platform/imageCache'
import { loadPairing, loadUnpaired } from './platform/pairing'
import { isPairGone, useMobile } from './state'
import { clientRef } from './transport/clientRef'
import { makeImageResolver } from './transport/imageResolver'
import { makeTunnelFetch } from './transport/tunnelFetch'
import { TunnelSocket } from './transport/tunnelSocket'

/**
 * Wires the phone once, before the first render (spec § 3): the three seams
 * pointed at the tunnel, the hub topics the list needs, the cache, the app
 * lifecycle, and the paired Mac's link when there is one.
 */
export async function boot(): Promise<void> {
  configureApi({ fetch: makeTunnelFetch(clientRef) })
  configureSocket({ WebSocketImpl: () => new TunnelSocket(clientRef) as unknown as WebSocket })
  configureImages({ resolve: makeImageResolver(clientRef, { read: readCachedImage, write: writeCachedImage }) })
  clientRef.on(onClientEvent)
  wireSocket()
  wireCache()
  await installLifecycle()

  const [pairing, unpaired, cached] = await Promise.all([loadPairing(), loadUnpaired(), readSessionsCache()])
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
  if (pairing && !unpaired) await connect(pairing)
}

function onClientEvent(event: RemoteClientEvent): void {
  useMobile.getState().apply(event)
  if (isPairGone(event)) {
    // Deleted on first contact, then 9h (spec § 4).
    void forgetEverything({ unpaired: true })
    return
  }
  if (event.type === 'hub') refetchDropped(event.frame)
}

/** A hub frame too large for one relay frame arrives as `dropped` (parent § 7): read that session's page again. */
function refetchDropped(frame: unknown): void {
  const f = frame as { topic?: unknown; event?: unknown } | null
  if (f?.event !== 'dropped' || typeof f.topic !== 'string' || !f.topic.startsWith('session:')) return
  void useOrbital.getState().reloadTranscript(f.topic.slice('session:'.length))
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
    if (!id) return
    if (useOrbital.getState().historyLoaded[id]) await useOrbital.getState().reloadTranscript(id)
    else await useOrbital.getState().select(id)
  } catch {
    // The next open, or the next return to the foreground, tries again.
  }
}

/** Writes what is live to the cache, so the next offline launch has something honest to show. */
function wireCache(): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  useOrbital.subscribe((state, prev) => {
    if (!useMobile.getState().ready) return
    const id = state.ui.selectedId
    const changed =
      state.sessions !== prev.sessions ||
      state.tags !== prev.tags ||
      (id !== null && state.transcripts[id] !== prev.transcripts[id])
    if (!changed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void persist()
    }, CACHE_WRITE_DEBOUNCE_MS)
  })
}

async function persist(): Promise<void> {
  const { sessions, tags, ui, transcripts } = useOrbital.getState()
  const now = Date.now()
  try {
    await writeSessionsCache({ sessions: Object.values(sessions), tags }, now)
    const id = ui.selectedId
    const messages = id ? transcripts[id] : undefined
    if (id && messages) await writeTranscriptCache(id, messages.slice(-TRANSCRIPT_PAGE_SIZE), now)
  } catch (err) {
    console.warn('orbital: could not write the offline cache', err)
  }
}

async function installLifecycle(): Promise<void> {
  try {
    await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void foreground()
    })
    await App.addListener('backButton', () => {
      if (useMobile.getState().goBack() === 'exit') void App.minimizeApp()
    })
  } catch {
    // A desktop browser has no app lifecycle to listen to.
  }
}

/** Android kills a backgrounded socket without a word: on return, never trust it (parent § 4). */
async function foreground(): Promise<void> {
  if (!clientRef.client) return
  const online = await clientRef.recheck(RETRY_WINDOW_MS)
  useMobile.setState({ checkedAt: Date.now(), macOnline: online })
}
