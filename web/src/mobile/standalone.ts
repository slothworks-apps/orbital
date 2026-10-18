import { EMPTY_ROSTER } from '@orbital/shared/remote/roster'
import type { Identity } from '@orbital/shared/remote/keys'
import type { PeerInfo } from '@orbital/shared/remote/groupClient'
import { holdGroup, newGroup } from './connect'
import { fingerprintFor } from './pairingFlow'
import { thisDevice } from './platform/device'
import { loadOrCreateIdentity } from './platform/identity'
import { clearEnded, clearUnpaired } from './platform/pairing'
import type { Pairing, StandaloneRelay } from './platform/parse'
import { registerPush } from './platform/push'
import { useMobile } from './state'
import { groupRef, type GroupHandle } from './transport/groupRef'

/** The relay a pairing names, as a standalone phone keeps it. */
export function standaloneRelay(pairing: Pick<Pairing, 'relay' | 'relaySecret'>): StandaloneRelay {
  return { relay: pairing.relay, ...(pairing.relaySecret !== undefined ? { relaySecret: pairing.relaySecret } : {}) }
}

/**
 * A phone the group's primary dissolved the group under, or removed (canvas
 * 50n), stays on its relay with its key: online, able to show its own code
 * (50i) or scan another's. It holds no group: a client with an empty roster,
 * stored nothing until a device pairs with it. A pairing made from its own
 * code makes it a paired phone again, as a scanned code does
 * (`runPairing`); a scan replaces this client with its own.
 */
export async function goStandalone(relay: StandaloneRelay): Promise<void> {
  if (useMobile.getState().pairing || groupRef.current) return
  const [identity, device] = await Promise.all([loadOrCreateIdentity(), thisDevice()])
  // A pairing, or another client, may have come while the key loaded.
  if (useMobile.getState().pairing || groupRef.current) return
  const handle = newGroup(
    { ...relay, group: { roster: EMPTY_ROSTER, paired: [], pendingRevokes: [] } },
    identity, device, { persist: false },
  )
  let adopting = false
  handle.group.on((event) => {
    if (event.type !== 'group' || adopting || groupRef.current !== handle || useMobile.getState().pairing) return
    const peer = handle.group.peers()[0]
    if (!peer) return
    adopting = true
    adopt(handle, peer, relay, identity).catch((err: unknown) => {
      adopting = false
      console.warn('[mobile] could not keep the pairing made from this phone\'s code', err)
    })
  })
  holdGroup(handle)
  useMobile.setState({ standaloneRelay: relay.relay })
  handle.group.start()
}

/** A device paired with the standalone phone through its code: the phone is paired again, its group stored from now on. */
async function adopt(handle: GroupHandle, peer: PeerInfo, relay: StandaloneRelay, identity: Identity): Promise<void> {
  await handle.persist()
  await Promise.all([clearUnpaired(), clearEnded()])
  if (groupRef.current !== handle) return
  const pairing: Pairing = {
    ...relay, mac: peer.id, macName: peer.name, fingerprint: fingerprintFor(peer.id, identity.publicKey), pairedAt: Date.now(),
  }
  useMobile.setState({ pairing, unpaired: false, groupEnded: null, standaloneRelay: null, macName: peer.name })
  void registerPush()
}
