import { fingerprint, publicKeyOf } from '@orbital/shared/remote/keys'
import { QrPayload } from '@orbital/shared/remote/relayApi'
import { isHttpUrl } from './platform/parse'

/**
 * A scanned or pasted code (9e), or null when it is not an Orbital pairing
 * code this phone can use. Checked before anything connects: a relay that
 * is not http(s) or a Mac id that is not a key never reaches the network.
 */
export function parseQrText(text: string): QrPayload | null {
  let data: unknown
  try {
    data = JSON.parse(text.trim())
  } catch {
    return null
  }
  const parsed = QrPayload.safeParse(data)
  if (!parsed.success) return null
  const qr = parsed.data
  if (!isHttpUrl(qr.relay) || publicKeyOf(qr.mac) === null || qr.token === '' || qr.secret === '') return null
  return qr
}

export type RedeemVerdict = 'wait' | 'expired' | 'busy' | 'network'

/**
 * What a `/pair/redeem` answer means for 9e (relay/src/pairing.ts): 200 only
 * says the relay passed it on, so the Mac's answer is still to come; 404
 * (unknown or used token), 409 (the Mac went offline, which also uses the
 * token up) and a refused signature cannot pair this code; 429 is the
 * relay's rate limit; anything else is the relay not being there.
 */
export function redeemOutcome(status: number): RedeemVerdict {
  if (status === 200) return 'wait'
  if (status === 429) return 'busy'
  if (status === 0 || status >= 500) return 'network'
  return 'expired'
}

/** The six characters both screens show (9e, 9o). */
export function fingerprintFor(mac: string, phoneKey: Uint8Array): string {
  const macKey = publicKeyOf(mac)
  if (!macKey) throw new Error('mac is not a device id')
  return fingerprint(macKey, phoneKey)
}
