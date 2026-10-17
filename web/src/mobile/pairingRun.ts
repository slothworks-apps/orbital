import { CONNECT_TIMEOUT_MS, type TunnelEvent } from '@orbital/shared/remote/tunnel'
import type { JoinResult } from '@orbital/shared/remote/ceremony'
import type { GroupClient, GroupClientEvent } from '@orbital/shared/remote/groupClient'
import { PAIRING_TOKEN_TTL_MS, type QrPayload } from '@orbital/shared/remote/relayApi'
import { MIN_RELAY_VERSION, type RelayTooOld } from '@orbital/shared/remote/version'
import { relayVersionLabel } from '../lib/remote'
import { holdGroup, newGroup } from './connect'
import { PAIRED_HELLO_WAIT_MS } from './constants'
import { relayHost } from './format'
import { fingerprintFor } from './pairingFlow'
import { thisDevice } from './platform/device'
import { loadOrCreateIdentity } from './platform/identity'
import type { Pairing } from './platform/parse'
import { clearUnpaired } from './platform/pairing'
import { usePhoneTip } from './phoneTip'
import { useMobile } from './state'
import { groupRef, type GroupHandle } from './transport/groupRef'

/** A refusal told as canvas 50d tells it: a card with a title over its explanation. */
export type ErrorCard = { title: string; body: string }

/**
 * `error`: one line, or a 50d card. `confirm` names the device whose code
 * was scanned and its kind (canvas 50i: "Type K7F-Q2M on studio-mbp").
 * `expired`: the code ran out or was used up, or (`rejected`) the device
 * said no; `name` is that device. `offline`: the device that showed the
 * code is not on the relay; the code stays good until `expiresAt` (null:
 * the code did not say), and the same code can be tried again.
 */
export type PairingStep =
  | { kind: 'scan'; error: string | ErrorCard | null }
  | { kind: 'connecting' }
  | { kind: 'confirm'; macName: string; deviceKind: string; fingerprint: string; expiresAt: number }
  | { kind: 'paired'; macName: string; relayHost: string; fingerprint: string }
  | { kind: 'expired'; name: string; rejected: boolean }
  | { kind: 'offline'; name: string; expiresAt: number | null }

export const RELAY_UNREACHABLE = "Can't reach the relay in this code."
export const RELAY_BUSY = 'The relay is busy. Try again in a minute.'
/** A relay with `RELAY_SECRET` that refused the code's (a stale code, a re-keyed relay). Provisional copy. */
export const RELAY_REFUSED_SECRET = "The relay refused this code's secret. Show a fresh code on the Mac."
/**
 * A relay below `MIN_RELAY_VERSION`, at connect or in the redeem's answer.
 * Mid-pairing there is no app behind 9i to block, so 9e says it, in 11a's
 * words for the relay. Provisional: the canvas draws no 9e state for it.
 */
export function relayTooOldMessage(relayUrl: string, tooOld: RelayTooOld): string {
  const runs = relayVersionLabel(tooOld.relayVersion)
  return `The relay at ${relayHost(relayUrl)} is older than this app supports: ${runs}, this app needs relay ≥ ${tooOld.needed}. Whoever runs the relay updates its image.`
}
/** A run that threw — a Keystore read, a storage write — goes back to scan with this. */
export const PAIRING_FAILED = "Couldn't pair on this phone. Try again."
/** A code from a device of another group while this phone is in one: groups do not merge. Provisional copy. */
export const IN_GROUP = 'This phone is in a group already. Leave it first.'
/** A code from a device this phone is paired with already. */
export function alreadyPaired(name: string): string {
  return `This phone is already paired with ${name}.`
}

/** Resolves true on the first event `match` takes, false once `ms` pass. */
function waitFor<E>(on: (listener: (event: E) => void) => () => void, match: (event: E) => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve(false)
    }, ms)
    const off = on((event) => {
      if (!match(event)) return
      clearTimeout(timer)
      off()
      resolve(true)
    })
  })
}

/** The device whose code was redeemed confirming it, rejecting it, or the code running out first. */
function waitForJoin(group: GroupClient, device: string, ms: number): Promise<'joined' | 'rejected' | 'timeout'> {
  let rejected = false
  return waitFor<GroupClientEvent>(
    (listener) => group.on(listener),
    (e) => {
      if (e.type === 'join_failed' && e.peer === device) rejected = true
      return rejected || (e.type === 'joined' && e.peer === device)
    },
    ms,
  ).then((done) => (!done ? 'timeout' : rejected ? 'rejected' : 'joined'))
}

/**
 * Ends a run's link, as 9e's Cancel and leaving the screen do: a phone not
 * in a group yet drops the client the run built; a phone in one keeps its
 * group and only stops waiting for the device it was joining.
 */
export function cancelPairing(): void {
  if (useMobile.getState().pairing) {
    groupRef.current?.group.cancelJoin()
    return
  }
  groupRef.set(null)
}

/**
 * 9e from a parsed code to "Paired with" (spec § 5): the phone joins the
 * group of the device that showed the code (`GroupClient.join`) — on a
 * fresh client on the code's relay when it is in no group yet — and that
 * device confirms it; then the channel and its hello. `report` hears every
 * step. `cancelled` is asked after every wait; a cancelled run reports
 * nothing more — its caller has already closed the link. Never rejects: a
 * run that throws reports scan with `PAIRING_FAILED`, and drops the client
 * it built if the app still holds it.
 */
export async function runPairing(
  qr: QrPayload,
  report: (step: PairingStep) => void,
  cancelled: () => boolean,
): Promise<void> {
  const held: { handle: GroupHandle | null } = { handle: null }
  try {
    await pair(qr, report, cancelled, held)
  } catch (err) {
    // The error only: never the code, whose text carries the pairing secret.
    console.warn('[mobile] pairing failed', err)
    if (cancelled()) return
    if (held.handle && groupRef.current === held.handle) groupRef.set(null)
    // A phone in a group keeps it, and stops waiting for the device it was joining.
    else if (!held.handle) groupRef.current?.group.cancelJoin()
    report({ kind: 'scan', error: PAIRING_FAILED })
  }
}

/**
 * What 9e says to a join the relay or the group did not take, in canvas
 * 50d's words where it has them. `busy`: the relay's last answer was 429,
 * which the ceremony reads as `relay_error`.
 */
export function joinRefused(
  answer: Exclude<JoinResult, { device: string }>,
  qr: QrPayload,
  ourRelay: string,
  tooOld: RelayTooOld | null,
  busy: boolean,
): PairingStep {
  switch (answer.error) {
    case 'bad_code':
      // An unknown, used or expired code.
      return { kind: 'expired', name: qr.name, rejected: false }
    case 'peer_offline':
      // 50d C: the relay leaves the code open, so it is tried again once the device is back.
      return { kind: 'offline', name: qr.name, expiresAt: answer.expiresAt ?? qr.expiresAt ?? null }
    case 'relay_too_old':
      return { kind: 'scan', error: relayTooOldMessage(qr.relay, tooOld ?? { relayVersion: null, needed: MIN_RELAY_VERSION }) }
    case 'in_group':
      return { kind: 'scan', error: IN_GROUP }
    case 'other_relay':
      // 50d B: a phone moves relays only by leaving its group, so no switch is offered.
      return {
        kind: 'scan',
        error: {
          title: `${qr.name} uses another relay`,
          body: `It's on ${relayHost(answer.relay)}; this phone is on ${relayHost(ourRelay)}. Both need the same one.`,
        },
      }
    case 'already_paired':
      return { kind: 'scan', error: alreadyPaired(qr.name) }
    case 'offline':
      return { kind: 'scan', error: RELAY_UNREACHABLE }
    case 'relay_error':
      return { kind: 'scan', error: busy ? RELAY_BUSY : RELAY_UNREACHABLE }
    default:
      return { kind: 'scan', error: PAIRING_FAILED }
  }
}

async function pair(
  qr: QrPayload,
  report: (step: PairingStep) => void,
  cancelled: () => boolean,
  held: { handle: GroupHandle | null },
): Promise<void> {
  report({ kind: 'connecting' })
  const identity = await loadOrCreateIdentity()
  // Before any client exists: a Cancel during the key load leaves nothing behind.
  if (cancelled()) return
  const fingerprint = fingerprintFor(qr.mac, identity.publicKey)
  // Its name goes into the client's hello and is sealed into the join.
  const device = await thisDevice()
  if (cancelled()) return
  // A phone in a group joins through its own client, which refuses another group's code.
  const current = useMobile.getState().pairing ? groupRef.current : null
  const handle = current ?? newGroup(
    {
      relay: qr.relay, ...(qr.relaySecret !== undefined ? { relaySecret: qr.relaySecret } : {}),
      group: { roster: [], paired: [], pendingRevokes: [] },
    },
    identity, device, { persist: false },
  )
  const { group, federation } = handle
  // Dropped on the way out of a run that fails: a phone in a group keeps its own.
  const fail = (step: PairingStep) => {
    if (current) group.cancelJoin()
    else groupRef.set(null)
    report(step)
  }
  // A refused secret or a relay too old ends the wait too: the client has
  // stopped, and waiting out the timeout would say "can't reach".
  let refused = false
  let tooOld: RelayTooOld | null = null
  const offTooOld = group.on((e) => {
    if (e.type === 'relay_error' && e.code === 'bad_secret') refused = true
    if (e.type === 'relay_too_old') tooOld = { relayVersion: e.relayVersion, needed: e.needed }
  })
  try {
    if (!current) {
      held.handle = handle
      holdGroup(handle)
    }
    if (group.status !== 'online') {
      const online = waitFor<GroupClientEvent>(
        (listener) => group.on(listener),
        (e) => refused || tooOld !== null || (e.type === 'status' && e.status === 'online'),
        CONNECT_TIMEOUT_MS,
      )
      if (!current) group.start()
      const reached = await online
      if (cancelled()) return
      if (!reached || refused || tooOld) {
        fail({ kind: 'scan', error: tooOld ? relayTooOldMessage(qr.relay, tooOld) : refused ? RELAY_REFUSED_SECRET : RELAY_UNREACHABLE })
        return
      }
    }

    report({
      kind: 'confirm', macName: qr.name, deviceKind: qr.kind ?? 'desktop', fingerprint,
      expiresAt: Math.min(qr.expiresAt ?? Infinity, Date.now() + PAIRING_TOKEN_TTL_MS),
    })
    // Listening before the join goes out: the device's answer must not slip past.
    const outcome = waitForJoin(group, qr.mac, PAIRING_TOKEN_TTL_MS)
    const answer = await group.join(JSON.stringify(qr))
    if (cancelled()) return
    if ('error' in answer) {
      // A phone in a group joins on its own relay; a fresh client is on the code's.
      const ours = current ? useMobile.getState().pairing?.relay ?? qr.relay : qr.relay
      fail(joinRefused(answer, qr, ours, tooOld ?? group.relayTooOld, handle.relayBusy()))
      return
    }
    const result = await outcome
    if (cancelled()) return
    if (result !== 'joined') {
      fail({ kind: 'expired', name: qr.name, rejected: result === 'rejected' })
      return
    }

    const pairing: Pairing = { relay: qr.relay, mac: qr.mac, macName: qr.name, fingerprint, pairedAt: Date.now() }
    // Only when the code had one: a code from an open relay stores what it always did.
    if (qr.relaySecret !== undefined) pairing.relaySecret = qr.relaySecret
    // The notifications tip becomes due with a pairing (spec
    // 2026-10-08-notifications-off-by-default-design § 5), before the list can show.
    await Promise.all([handle.persist(), clearUnpaired(), usePhoneTip.getState().markPending()])
    // A phone already in a group keeps what it shows; a new one is in the group of the device it joined.
    if (!current) useMobile.setState({ pairing, unpaired: false, macName: qr.name })
    // The channel follows the pair within moments; "Paired with" waits for it, bounded, and shows either way.
    if (!federation.ready) {
      await waitFor<TunnelEvent>((listener) => federation.on(listener), (e) => e.type === 'ready' && e.ready, PAIRED_HELLO_WAIT_MS)
    }
    if (cancelled()) return
    report({ kind: 'paired', macName: qr.name, relayHost: new URL(qr.relay).host, fingerprint })
  } finally {
    offTooOld()
  }
}
