import { CONNECT_TIMEOUT_MS, type RemoteClient, type RemoteClientEvent } from '@orbital/shared/remote/client'
import { PAIRING_TOKEN_TTL_MS, type QrPayload } from '@orbital/shared/remote/relayApi'
import type { RelayTooOld } from '@orbital/shared/remote/version'
import { newClient } from './connect'
import { PAIRED_HELLO_WAIT_MS } from './constants'
import { fingerprintFor, redeemOutcome } from './pairingFlow'
import { thisDevice } from './platform/device'
import { loadOrCreateIdentity } from './platform/identity'
import type { Pairing } from './platform/parse'
import { clearUnpaired, savePairing } from './platform/pairing'
import { useMobile } from './state'
import { clientRef } from './transport/clientRef'

export type PairingStep =
  | { kind: 'scan'; error: string | null }
  | { kind: 'connecting' }
  | { kind: 'confirm'; macName: string; fingerprint: string; expiresAt: number }
  | { kind: 'paired'; macName: string; relayHost: string; fingerprint: string }
  | { kind: 'expired' }

export const RELAY_UNREACHABLE = "Can't reach the relay in this code."
export const RELAY_BUSY = 'The relay is busy. Try again in a minute.'
/** A relay with `RELAY_SECRET` that refused the code's (a stale code, a re-keyed relay). Provisional copy. */
export const RELAY_REFUSED_SECRET = "The relay refused this code's secret. Show a fresh code on the Mac."
/**
 * A relay below `MIN_RELAY_VERSION`, at connect or in the redeem's answer.
 * Mid-pairing there is no app behind 9i to block, so 9e says it. Provisional
 * copy (spec 2026-10-07-version-compatibility-design § 5).
 */
export function relayTooOldMessage(relayUrl: string, tooOld: RelayTooOld): string {
  return `The relay at ${new URL(relayUrl).host} runs ${tooOld.relayVersion}; this app needs ${tooOld.needed} or newer. Whoever runs the relay has to update it.`
}
/** A run that threw — a Keystore read, a storage write — goes back to scan with this. */
export const PAIRING_FAILED = "Couldn't pair on this phone. Try again."

function waitFor(client: RemoteClient, match: (event: RemoteClientEvent) => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve(false)
    }, ms)
    const off = client.on((event) => {
      if (!match(event)) return
      clearTimeout(timer)
      off()
      resolve(true)
    })
  })
}

/**
 * 9e from a parsed code to "Paired with" (spec § 5): a relay link to the
 * code's relay, the redeem with this phone's name, the Mac's confirm, then
 * the handshake and hello. `report` hears every step. `cancelled` is asked
 * after every wait; a cancelled run reports nothing more — its caller has
 * already closed the link. Never rejects: a run that throws reports scan
 * with `PAIRING_FAILED`, and drops its client if it still holds the app's.
 */
export async function runPairing(
  qr: QrPayload,
  report: (step: PairingStep) => void,
  cancelled: () => boolean,
): Promise<void> {
  const held: { client: RemoteClient | null } = { client: null }
  try {
    await pair(qr, report, cancelled, held)
  } catch (err) {
    // The error only: never the code, whose text carries the pairing secret.
    console.warn('[mobile] pairing failed', err)
    if (cancelled()) return
    if (held.client && clientRef.client === held.client) clientRef.set(null)
    report({ kind: 'scan', error: PAIRING_FAILED })
  }
}

async function pair(
  qr: QrPayload,
  report: (step: PairingStep) => void,
  cancelled: () => boolean,
  held: { client: RemoteClient | null },
): Promise<void> {
  report({ kind: 'connecting' })
  const identity = await loadOrCreateIdentity()
  // Before any client exists: a Cancel during the key load leaves nothing behind.
  if (cancelled()) return
  const fingerprint = fingerprintFor(qr.mac, identity.publicKey)
  const client = newClient(qr.relay, qr.mac, identity, { expectPaired: false, relaySecret: qr.relaySecret })
  held.client = client
  clientRef.set(client)
  // A refused secret or a relay too old ends the wait too: the client has
  // stopped, and waiting out the timeout would say "can't reach".
  let refused = false
  let tooOld: RelayTooOld | null = null
  const online = waitFor(
    client,
    (e) => {
      if (e.type === 'relay_error' && e.code === 'bad_secret') refused = true
      if (e.type === 'relay_too_old') tooOld = { relayVersion: e.relayVersion, needed: e.needed }
      return refused || tooOld !== null || (e.type === 'status' && e.status === 'online')
    },
    CONNECT_TIMEOUT_MS,
  )
  client.start()
  const reached = await online
  if (cancelled()) return
  if (!reached || refused || tooOld) {
    clientRef.set(null)
    const error = tooOld ? relayTooOldMessage(qr.relay, tooOld) : refused ? RELAY_REFUSED_SECRET : RELAY_UNREACHABLE
    report({ kind: 'scan', error })
    return
  }

  report({ kind: 'confirm', macName: qr.name, fingerprint, expiresAt: Date.now() + PAIRING_TOKEN_TTL_MS })
  // Listening before the redeem goes out: the Mac's answer must not slip past.
  const outcome = client.waitForPairing(PAIRING_TOKEN_TTL_MS)
  const device = await thisDevice()
  // Before the redeem: a cancelled run must not use up the token or ask the Mac.
  if (cancelled()) return
  const answer = await client.redeem(qr.token, qr.secret, device.name, device.platform)
  if (cancelled()) return
  if (answer.relayTooOld) {
    clientRef.set(null)
    report({ kind: 'scan', error: relayTooOldMessage(qr.relay, answer.relayTooOld) })
    return
  }
  const verdict = redeemOutcome(answer.status)
  if (verdict !== 'wait') {
    clientRef.set(null)
    report(
      verdict === 'expired'
        ? { kind: 'expired' }
        : { kind: 'scan', error: verdict === 'busy' ? RELAY_BUSY : RELAY_UNREACHABLE },
    )
    return
  }
  const result = await outcome
  if (cancelled()) return
  if (result !== 'paired') {
    clientRef.set(null)
    report({ kind: 'expired' })
    return
  }

  const pairing: Pairing = { relay: qr.relay, mac: qr.mac, macName: qr.name, fingerprint, pairedAt: Date.now() }
  // Only when the code had one: a code from an open relay stores what it always did.
  if (qr.relaySecret !== undefined) pairing.relaySecret = qr.relaySecret
  await Promise.all([savePairing(pairing), clearUnpaired()])
  useMobile.setState({ pairing, unpaired: false, macName: qr.name })
  // The tunnel follows `paired` within moments; "Paired with" waits for it, bounded, and shows either way.
  if (!client.ready) await waitFor(client, (e) => e.type === 'hello', PAIRED_HELLO_WAIT_MS)
  if (cancelled()) return
  report({ kind: 'paired', macName: qr.name, relayHost: new URL(qr.relay).host, fingerprint })
}
