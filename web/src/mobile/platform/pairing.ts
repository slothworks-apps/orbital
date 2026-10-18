import { Preferences } from '@capacitor/preferences'
import type { GroupEnded } from '@orbital/shared/remote/group'
import { parseEnded, parsePairing, type Pairing } from './parse'

/** The native shells read its presence too, for the app lock's snapshot cover (`APP_LOCK_KEY`). */
export const PAIRING_KEY = 'orbital.pairing'
/** Set when the Mac revoked this phone: 9h shows on every launch until a new pairing (spec § 4). Holds the Mac's name for 9h's copy. */
export const UNPAIRED_KEY = 'orbital.unpaired'
/**
 * Set when the group's primary dissolved the group or removed this phone
 * (`GroupEnded`): the notice under THIS PHONE (canvas 50n) stays until OK or
 * a new pairing.
 */
export const ENDED_KEY = 'orbital.groupEnded'

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

/** The notice of the group's ending, or null; one that does not read is none. */
export async function loadEnded(): Promise<GroupEnded | null> {
  const { value } = await Preferences.get({ key: ENDED_KEY })
  return parseEnded(value)
}

export function saveEnded(ended: GroupEnded): Promise<void> {
  return Preferences.set({ key: ENDED_KEY, value: JSON.stringify(ended) })
}

export function clearEnded(): Promise<void> {
  return Preferences.remove({ key: ENDED_KEY })
}
