import { Preferences } from '@capacitor/preferences'
import { loadPairing, savePairing } from './pairing'
import { migratePairing, pairingFromGroup, parseGroupRecord, type GroupRecord } from './parse'

/** The phone's device group (`GroupRecord`). `PAIRING_KEY` is kept beside it while the phone is in a group. */
export const GROUP_KEY = 'orbital.group'

/**
 * The stored group; a phone paired with one Mac before groups gets that
 * Mac as its group (`migratePairing`). Null when there is neither, or
 * neither reads.
 */
export async function loadGroup(): Promise<GroupRecord | null> {
  const { value } = await Preferences.get({ key: GROUP_KEY })
  const record = parseGroupRecord(value)
  if (record) return record
  const pairing = await loadPairing()
  return pairing ? migratePairing(pairing) : null
}

/**
 * The group, and `PAIRING_KEY` with its first device: the native shells
 * read that key's presence for the app lock's snapshot cover.
 */
export async function saveGroup(record: GroupRecord, phoneKey: Uint8Array): Promise<void> {
  await Preferences.set({ key: GROUP_KEY, value: JSON.stringify(record) })
  const pairing = pairingFromGroup(record, phoneKey)
  if (pairing) await savePairing(pairing)
}

export function clearGroup(): Promise<void> {
  return Preferences.remove({ key: GROUP_KEY })
}
