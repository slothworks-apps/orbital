import { RemoteClient } from '@orbital/shared/remote/client'
import type { Identity } from '@orbital/shared/remote/keys'
import { loadOrCreateIdentity } from './platform/identity'
import type { Pairing } from './platform/parse'
import { RETRY_WINDOW_MS } from './constants'
import { isMacAsleep, useMobile } from './state'
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
 * false, since no pair exists yet and the relay would say so. `relaySecret`
 * is the relay's shared secret from the code, sent on every connect; none
 * for an open relay.
 */
export function newClient(
  relayUrl: string,
  mac: string,
  identity: Identity,
  { expectPaired, relaySecret }: { expectPaired: boolean; relaySecret?: string },
): RemoteClient {
  // The WebView's own WebSocket; `ws` plays it in the server's end-to-end test.
  return new RemoteClient({
    relayUrl, mac, identity, WebSocketImpl: WebSocket, app: mobileApp(), expectPaired, relaySecret,
  })
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
  useMobile.setState((s) => ({ rechecking: { asleep: isMacAsleep(s) } }))
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

/** The paired Mac's link, started and live behind `clientRef`. */
export async function connect(pairing: Pairing): Promise<RemoteClient> {
  const identity = await loadOrCreateIdentity()
  const client = newClient(pairing.relay, pairing.mac, identity, { expectPaired: true, relaySecret: pairing.relaySecret })
  clientRef.set(client)
  client.start()
  return client
}
