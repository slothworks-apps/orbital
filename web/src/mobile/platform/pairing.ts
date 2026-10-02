import { Preferences } from '@capacitor/preferences'
import { parsePairing, type Pairing } from './parse'

export const PAIRING_KEY = 'orbital.pairing'
/** Set when the Mac revoked this phone: 9h shows on every launch until a new pairing (spec § 4). Holds the Mac's name for 9h's copy. */
export const UNPAIRED_KEY = 'orbital.unpaired'

export async function loadPairing(): Promise<Pairing | null> {
  const { value } = await Preferences.get({ key: PAIRING_KEY })
  return parsePairing(value)
}

export function savePairing(pairing: Pairing): Promise<void> {
  return Preferences.set({ key: PAIRING_KEY, value: JSON.stringify(pairing) })
}

export function clearPairing(): Promise<void> {
  return Preferences.remove({ key: PAIRING_KEY })
}

export async function loadUnpaired(): Promise<{ macName: string } | null> {
  const { value } = await Preferences.get({ key: UNPAIRED_KEY })
  return value === null ? null : { macName: value }
}

export function setUnpaired(macName: string): Promise<void> {
  return Preferences.set({ key: UNPAIRED_KEY, value: macName })
}

export function clearUnpaired(): Promise<void> {
  return Preferences.remove({ key: UNPAIRED_KEY })
}
