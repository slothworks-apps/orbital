import { Preferences } from '@capacitor/preferences'
import { loadPairing, savePairing } from './pairing'
import { pairingFromGroup, parseGroupRecord, reconcileGroup, storedMembership, type GroupRecord } from './parse'

/** The phone's device group (`GroupRecord`). `PAIRING_KEY` is kept beside it while the phone is in a group. */
export const GROUP_KEY = 'orbital.group'

/**
 * Set by every write of `GROUP_KEY` and never removed: a group record was
 * written on this phone once, so `PAIRING_KEY` (since then a mirror of its
 * first paired device) never stands in for the group id again (`reconcileGroup`).
 */
export const GROUP_SEEN_KEY = 'orbital.group.seen'

/**
 * The stored group, checked against the pairing beside it
 * (`reconcileGroup`): a phone paired with one Mac before groups gets that
 * Mac as its group, and a group the pairing no longer agrees with is
 * dropped. Null when the phone is in no group.
 */
export async function loadGroup(): Promise<GroupRecord | null> {
  const [{ value }, { value: seen }, pairing] = await Promise.all([
    Preferences.get({ key: GROUP_KEY }), Preferences.get({ key: GROUP_SEEN_KEY }), loadPairing(),
  ])
  const { record, stale } = reconcileGroup(parseGroupRecord(value), pairing, {
    seen: value !== null || seen !== null, membership: storedMembership(value),
  })
  // A group migrated afresh is written over at its first store; one with no pairing goes now.
  if (stale && !record) await clearGroup()
  return record
}

/**
 * The group, and `PAIRING_KEY` with its first device: the native shells
 * read that key's presence for the app lock's snapshot cover.
 */
export async function saveGroup(record: GroupRecord, phoneKey: Uint8Array): Promise<void> {
  await Preferences.set({ key: GROUP_SEEN_KEY, value: '1' })
  await Preferences.set({ key: GROUP_KEY, value: JSON.stringify(record) })
  const pairing = pairingFromGroup(record, phoneKey)
  if (pairing) await savePairing(pairing)
}

export function clearGroup(): Promise<void> {
  return Preferences.remove({ key: GROUP_KEY })
}
