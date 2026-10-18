import { osName } from '@orbital/shared/remote/device'
import { GroupClient, MemoryGroupStorage } from '@orbital/shared/remote/groupClient'
import type { Identity } from '@orbital/shared/remote/keys'
import { thisDevice } from './platform/device'
import { saveGroup } from './platform/group'
import { loadOrCreateIdentity } from './platform/identity'
import type { GroupRecord } from './platform/parse'
import { PersistQueue } from './platform/persistQueue'
import { registerPush } from './platform/push'
import { RETRY_WINDOW_MS } from './constants'
import { asleepDevices } from './deviceList'
import { isMacAsleep, useMobile, type MobileState } from './state'
import { clientRef } from './transport/clientRef'
import { GroupFederation } from './transport/groupFederation'
import { groupRef, type GroupHandle } from './transport/groupRef'

/**
 * What `hello` calls this app: the shell's version (mobile/package.json).
 * A function, not a constant: a module-level read of the build-time global
 * would throw in any test that imports this file.
 */
export function mobileApp(): string {
  return `orbital-mobile/${__MOBILE_VERSION__}`
}

/**
 * The phone's group client on `record`'s relay, with the federation over it,
 * not yet started nor held. `persist` false is a join in progress: nothing is
 * stored until it pairs (`GroupHandle.persist`). Its events reach the app's
 * state only while it is the one `groupRef` holds.
 */
export function newGroup(
  record: GroupRecord,
  identity: Identity,
  device: { name: string; platform: string },
  { persist }: { persist: boolean },
): GroupHandle {
  const storage = MemoryGroupStorage.fromJSON(record.group)
  const queue = new PersistQueue<GroupRecord>((value) => saveGroup(value, identity.publicKey))
  let persisting = persist
  let notifications = record.notifications
  const snapshot = (): GroupRecord => ({
    relay: record.relay, ...(record.relaySecret !== undefined ? { relaySecret: record.relaySecret } : {}), group: storage.toJSON(),
    ...(notifications !== undefined ? { notifications } : {}),
  })
  // The last relay request's status: the ceremony reads a busy relay (429) as any other failure.
  let lastStatus: number | null = null
  const group = new GroupClient({
    // The WebView's own WebSocket.
    relayUrl: record.relay, relaySecret: record.relaySecret, identity, WebSocketImpl: WebSocket,
    fetchImpl: async (input, init) => {
      const res = await fetch(input, init)
      lastStatus = res.status
      return res
    },
    app: mobileApp(), os: osName(device.platform), name: device.name, storage,
    onStored: () => {
      if (persisting) queue.push(snapshot())
    },
    log: (message) => console.info(`[group] ${message}`),
  })
  const federation = new GroupFederation(group, {
    notifications: notifications ?? null,
    onNotifications: (chosen) => {
      notifications = chosen
      if (persisting) queue.push(snapshot())
    },
  })
  const handle: GroupHandle = {
    group, federation,
    relayBusy: () => lastStatus === 429,
    persist: async () => {
      persisting = true
      queue.push(snapshot())
      await queue.idle()
      const failed = queue.lastError
      if (failed) throw failed instanceof Error ? failed : new Error('could not store the device group')
    },
    close: async () => {
      persisting = false
      queue.close()
      await queue.idle()
    },
  }
  const live = () => groupRef.current === handle
  federation.onMembers(() => {
    if (live()) useMobile.getState().setDevices(federation.sources())
  })
  group.on((event) => {
    if (!live()) return
    if (event.type === 'group') useMobile.setState(groupState(group))
    if (event.type === 'unreachable') useMobile.setState({ unreachable: event.unreachable })
    // A new pair: the relay has a row for it now, and the token can go to it.
    if (event.type === 'joined') void registerPush()
    // Only a refusal changes anything there; every other event would only wake the subscribers.
    if (event.type === 'bye' && event.reason !== 'revoked') useMobile.getState().applyGroup(event)
  })
  return handle
}

/** Holds `handle` as the app's group: `clientRef` carries its federation, the state shows its devices. */
export function holdGroup(handle: GroupHandle): void {
  groupRef.set(handle)
  useMobile.getState().setDevices(handle.federation.sources())
  useMobile.setState(groupState(handle.group))
}

/** Reads the group into the state again: the ceremony drops a code that ran out without a word. */
export function refreshGroupState(): void {
  const handle = groupRef.current
  if (handle) useMobile.setState(groupState(handle.group))
}

/** What the state shows of the group: its members, a device asking to join, this phone's open code and what it refused. */
export function groupState(
  group: GroupClient,
): Pick<MobileState, 'members' | 'pendingPair' | 'ownCode' | 'refusedPair' | 'unreachable'> {
  return {
    members: group.members(), pendingPair: group.pendingPair, ownCode: group.pairing, refusedPair: group.refusedPair,
    unreachable: group.unreachable,
  }
}

/**
 * Guards overlapping `recheckMac` calls (a foreground check racing a Retry
 * tap): each call takes the next token, and only the call still holding the
 * latest one when its answer lands may clear `rechecking` or write it.
 */
let recheckToken = 0

/**
 * One bounded presence check (9a's Retry, 9i's Try again, every return to
 * the foreground; `windowMs` is RETRY_WINDOW_MS). The relay link is rebuilt
 * on the way, so `rechecking` holds the offline presentation steady until
 * the answer is in (`isMacAsleep`).
 */
export async function recheckMac(windowMs: number): Promise<boolean> {
  const token = ++recheckToken
  useMobile.setState((s) => ({ rechecking: { asleep: isMacAsleep(s), asleepIds: asleepDevices(s) } }))
  try {
    const online = await clientRef.recheck(windowMs)
    // A superseded call never writes; nor does one outlived by forgetEverything.
    if (token === recheckToken && useMobile.getState().pairing) {
      useMobile.setState({ checkedAt: Date.now(), macOnline: online })
    }
    return online
  } finally {
    if (token === recheckToken) useMobile.setState({ rechecking: null })
  }
}

/**
 * A return to the foreground (parent § 4: Android kills a backgrounded
 * socket without a word). A tunnel still ready is left alone: the client's
 * silence watchdog (`TUNNEL_SILENCE_TIMEOUT_MS`) already drops a dead one
 * while a tunnel is up, and rebuilding it here would cut whatever is in
 * flight — a photo's `putBlob` started the moment the camera or the
 * gallery handed back. Without a ready tunnel, the bounded check runs as
 * 9a's Retry does.
 */
export async function recheckOnForeground(): Promise<void> {
  if (!clientRef.client || clientRef.ready) return
  await recheckMac(RETRY_WINDOW_MS)
}

/** The stored group, started and live behind `clientRef`. */
export async function connect(record: GroupRecord): Promise<GroupClient> {
  const [identity, device] = await Promise.all([loadOrCreateIdentity(), thisDevice()])
  const handle = newGroup(record, identity, device, { persist: true })
  holdGroup(handle)
  handle.group.start()
  return handle.group
}
