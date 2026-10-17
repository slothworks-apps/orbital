import { Preferences } from '@capacitor/preferences'
import { loadPairing, savePairing } from './pairing'
import { pairingFromGroup, parseGroupRecord, reconcileGroup, type GroupRecord } from './parse'

/** The phone's device group (`GroupRecord`). `PAIRING_KEY` is kept beside it while the phone is in a group. */
export const GROUP_KEY = 'orbital.group'

/**
 * The stored group, checked against the pairing beside it
 * (`reconcileGroup`): a phone paired with one Mac before groups gets that
 * Mac as its group, and a group the pairing no longer agrees with is
 * dropped. Null when the phone is in no group.
 */
export async function loadGroup(): Promise<GroupRecord | null> {
  const [{ value }, pairing] = await Promise.all([Preferences.get({ key: GROUP_KEY }), loadPairing()])
  const { record, stale } = reconcileGroup(parseGroupRecord(value), pairing)
  // A group migrated afresh is written over at its first store; one with no pairing goes now.
  if (stale && !record) await clearGroup()
  return record
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
