import { create } from 'zustand'
import type { RemoteClient } from '@orbital/shared/remote/client'
import { fromBase64Url, identityFromSecret } from '@orbital/shared/remote/keys'
import { newClient } from './connect'
import { loadOtherMacs, removeOtherMac, saveOtherMac, type OtherMacPairing } from './platform/otherMacs'
import { clientRef } from './transport/clientRef'
import { MultiClient } from './transport/multiClient'

/** The Macs beside the main one, as Settings and the list show them (spec 2026-10-06-peer-macs-design § 4). */
export const useOtherMacs = create<{
  macs: { mac: string; name: string; online: boolean }[]
  /** The pairing screen is pairing another Mac, not the main one. */
  adding: boolean
}>(() => ({ macs: [], adding: false }))

/** The client in front of every Mac, made around the main Mac's when the first other Mac joins. */
function multi(): MultiClient | null {
  const current = clientRef.client
  if (!current) return null
  if (current instanceof MultiClient) return current
  const wrapped = new MultiClient(current, (mac) => void forgetOtherMac(mac, { revoked: true }))
  clientRef.wrap(wrapped)
  return wrapped
}

function publish(): void {
  const current = clientRef.client
  useOtherMacs.setState({ macs: current instanceof MultiClient ? current.macs() : [] })
}

function join(pairing: OtherMacPairing, client: RemoteClient): void {
  const front = multi()
  if (!front) {
    client.stop()
    return
  }
  front.add({ mac: pairing.mac, name: pairing.macName, client })
  client.on((event) => {
    if (event.type === 'ready' || event.type === 'presence') publish()
  })
  publish()
}

/** Every stored other Mac, linked; after the main Mac's `connect`. */
export async function connectOtherMacs(): Promise<void> {
  for (const pairing of await loadOtherMacs()) {
    const identity = identityFromSecret(fromBase64Url(pairing.secretKey))
    const client = newClient(pairing.relay, pairing.mac, identity, { expectPaired: true, relaySecret: pairing.relaySecret })
    join(pairing, client)
    client.start()
  }
}

/** A Mac just paired as another Mac: stored, and its live client joined in. */
export async function adoptOtherMac(pairing: OtherMacPairing, client: RemoteClient): Promise<void> {
  await saveOtherMac(pairing)
  join(pairing, client)
}

/** The user forgot it here, or it revoked this phone: its sessions leave the list. */
export async function forgetOtherMac(mac: string, { revoked = false }: { revoked?: boolean } = {}): Promise<void> {
  const current = clientRef.client
  if (current instanceof MultiClient) {
    // As "Pair a different Mac" does for the main one: the relay stops pushing for it.
    if (!revoked) current.otherClient(mac)?.pushToken('')
    current.remove(mac)
  }
  await removeOtherMac(mac)
  publish()
}
