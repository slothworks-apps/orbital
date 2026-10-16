import { Capacitor } from '@capacitor/core'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { identityBackend, parseIdentity, parsePairing, type Pairing } from './parse'

/**
 * The Macs this phone is paired with beside the main one (spec
 * 2026-10-06-peer-macs-design § 4), each with its own identity: the relay
 * holds one socket per device. Kept with the identity in secure storage,
 * since every entry carries a secret key.
 */
export const OTHER_MACS_KEY = 'orbital.otherMacs'

export type OtherMacPairing = Pairing & { secretKey: string }

function secure(): boolean {
  return identityBackend(Capacitor.isNativePlatform()) === 'secure'
}

async function read(): Promise<string | null> {
  return secure() ? SecureStorage.getItem(OTHER_MACS_KEY) : localStorage.getItem(OTHER_MACS_KEY)
}

async function write(macs: OtherMacPairing[]): Promise<void> {
  const value = JSON.stringify(macs)
  if (secure()) await SecureStorage.setItem(OTHER_MACS_KEY, value)
  else localStorage.setItem(OTHER_MACS_KEY, value)
}

/** Anything unreadable is left out, as a bad pairing is (`parsePairing`). */
export function parseOtherMacs(raw: string | null): OtherMacPairing[] {
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
  if (!Array.isArray(data)) return []
  return data.flatMap((entry: unknown) => {
    const pairing = parsePairing(JSON.stringify(entry))
    const secretKey = (entry as { secretKey?: unknown } | null)?.secretKey
    if (!pairing || typeof secretKey !== 'string' || !parseIdentity(secretKey)) return []
    return [{ ...pairing, secretKey }]
  })
}

export async function loadOtherMacs(): Promise<OtherMacPairing[]> {
  return parseOtherMacs(await read())
}

export async function saveOtherMac(mac: OtherMacPairing): Promise<void> {
  const rest = (await loadOtherMacs()).filter((m) => m.mac !== mac.mac)
  await write([...rest, mac])
}

export async function removeOtherMac(mac: string): Promise<void> {
  await write((await loadOtherMacs()).filter((m) => m.mac !== mac))
}

export async function clearOtherMacs(): Promise<void> {
  if (secure()) await SecureStorage.removeItem(OTHER_MACS_KEY)
  else localStorage.removeItem(OTHER_MACS_KEY)
}
