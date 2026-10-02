import { RemoteClient } from '@orbital/shared/remote/client'
import type { Identity } from '@orbital/shared/remote/keys'
import { loadOrCreateIdentity } from './platform/identity'
import type { Pairing } from './platform/parse'
import { clientRef } from './transport/clientRef'

/**
 * What `hello` calls this app: the shell's version (mobile/package.json).
 * A function, not a constant: a module-level read of the build-time global
 * would throw in any test that imports this file.
 */
export function mobileApp(): string {
  return `orbital-mobile/${__MOBILE_VERSION__}`
}

/**
 * `expectPaired` is true only for a client built from a stored pairing: the
 * relay then says when that pair is gone. A client built while pairing passes
 * false, since no pair exists yet and the relay would say so.
 */
export function newClient(
  relayUrl: string,
  mac: string,
  identity: Identity,
  { expectPaired }: { expectPaired: boolean },
): RemoteClient {
  // The WebView's own WebSocket; `ws` plays it in the server's end-to-end test.
  return new RemoteClient({ relayUrl, mac, identity, WebSocketImpl: WebSocket, app: mobileApp(), expectPaired })
}

/** The paired Mac's link, started and live behind `clientRef`. */
export async function connect(pairing: Pairing): Promise<RemoteClient> {
  const identity = await loadOrCreateIdentity()
  const client = newClient(pairing.relay, pairing.mac, identity, { expectPaired: true })
  clientRef.set(client)
  client.start()
  return client
}
