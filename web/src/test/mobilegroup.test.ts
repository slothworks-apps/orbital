import { describe, expect, it, vi } from 'vitest'
import { deviceId, fingerprint, generateIdentity } from '@orbital/shared/remote/keys'
import { EMPTY_ROSTER, describeDevice, foundRoster, type RosterState } from '@orbital/shared/remote/roster'
import type { Identity } from '@orbital/shared/remote/keys'
import { migratePairing, pairingFromGroup, parseGroupRecord, reconcileGroup, storedMembership, type Pairing } from '../mobile/platform/parse'
import { PersistQueue } from '../mobile/platform/persistQueue'
import { useMobile, type DeviceView } from '../mobile/state'
import { MAC_FEATURES, deviceSupports, sessionSupports } from '../mobile/version'

const phone = generateIdentity()
const macKey = generateIdentity().publicKey
const mac = deviceId(macKey)
const PAIRING: Pairing = { relay: 'https://relay.test', mac, macName: 'studio', fingerprint: 'f', pairedAt: 7, relaySecret: 's' }

/** A group whose primary is `primary`, naming `others` too, each described by the primary. */
function rosterOf(primary: Identity, ...others: string[]): RosterState {
  const roster = foundRoster(primary, 'desktop', others.map((id) => ({ id, kind: 'desktop' })), 3)!
  const ids = [deviceId(primary.publicKey), ...others]
  return {
    roster, left: [],
    descriptions: ids.map((id) => describeDevice(id, { name: id.slice(0, 6), os: 'macOS', links: true }, primary, 3)),
  }
}

describe('the stored group', () => {
  it('reads back what was written, and nothing that is not a group', () => {
    const record = migratePairing(PAIRING)
    expect(parseGroupRecord(JSON.stringify(record))).toEqual(record)
    for (const raw of [null, '', 'nope', '[]', '{}', JSON.stringify({ relay: 'ftp://x', group: record.group }), JSON.stringify({ relay: PAIRING.relay })]) {
      expect(parseGroupRecord(raw)).toBeNull()
    }
  })

  it('keeps the rows that read and drops the rest, never the whole group', () => {
    const raw = JSON.stringify({
      relay: PAIRING.relay, relaySecret: 3,
      group: { roster: 'bad', paired: [{ id: 'not-a-key' }, migratePairing(PAIRING).group.paired[0]], pendingRevokes: [mac, 'x'] },
    })
    const record = parseGroupRecord(raw)
    expect(record).toEqual({ relay: PAIRING.relay, group: { roster: EMPTY_ROSTER, paired: migratePairing(PAIRING).group.paired, pendingRevokes: [mac] } })
  })

  it('keeps the notification rules chosen on the phone, and drops ones that do not read', () => {
    const notifications = { needsInput: true, sessionEnded: false, sessionFailed: true, onlyWhenBackground: true, sound: false }
    const record = { ...migratePairing(PAIRING), notifications }
    expect(parseGroupRecord(JSON.stringify(record))).toEqual(record)
    expect(parseGroupRecord(JSON.stringify({ ...record, notifications: { sound: 'loud' } }))).toEqual(migratePairing(PAIRING))
  })

  it("turns a phone's one Mac into a group of it, on the same relay with the same secret", () => {
    expect(migratePairing(PAIRING)).toEqual({
      relay: PAIRING.relay, relaySecret: 's',
      group: {
        roster: EMPTY_ROSTER,
        paired: [{ id: mac, name: 'studio', kind: null, platform: '', pairedAt: 7, lastSeenAt: null }],
        pendingRevokes: [],
        membership: { group: mac, founding: null, version: 0, member: true },
      },
    })
    const { relaySecret: _, ...open } = PAIRING
    expect(migratePairing(open)).not.toHaveProperty('relaySecret')
  })

  it('reads as paired with its first device, or the first other member while the pairs form again', () => {
    const record = migratePairing(PAIRING)
    expect(pairingFromGroup(record, phone.publicKey)).toEqual({
      relay: PAIRING.relay, mac, macName: 'studio', fingerprint: fingerprint(macKey, phone.publicKey), pairedAt: 7, relaySecret: 's',
    })
    const self = deviceId(phone.publicKey)
    // The Mac is no member any more; the group's primary stands in.
    const primary = generateIdentity()
    const lost = { ...record, group: { roster: rosterOf(primary, self), paired: [], pendingRevokes: [] } }
    expect(pairingFromGroup(lost, phone.publicKey)?.mac).toBe(deviceId(primary.publicKey))
    // No roster and no pair: not in a group.
    expect(pairingFromGroup({ ...record, group: { roster: EMPTY_ROSTER, paired: [], pendingRevokes: [] } }, phone.publicKey)).toBeNull()
  })
})

describe('reconcileGroup', () => {
  const otherKey = generateIdentity()
  const other = deviceId(otherKey.publicKey)
  const group = { ...migratePairing(PAIRING), group: { ...migratePairing(PAIRING).group, roster: rosterOf(otherKey) } }

  it('boots the group when the pairing beside it agrees, by a paired device or a live member', () => {
    expect(reconcileGroup(group, PAIRING)).toEqual({ record: group, stale: false })
    // Pairs lost and forming again: the pairing names a member the roster still holds.
    const lost = { ...group, group: { ...group.group, paired: [] } }
    expect(reconcileGroup(lost, { ...PAIRING, mac: other })).toEqual({ record: lost, stale: false })
  })

  it('migrates a phone from before groups', () => {
    expect(reconcileGroup(null, PAIRING)).toEqual({ record: migratePairing(PAIRING), stale: false })
    expect(reconcileGroup(null, null)).toEqual({ record: null, stale: false })
  })

  it('drops a group with no pairing beside it: an older bundle forgot the Mac', () => {
    expect(reconcileGroup(group, null)).toEqual({ record: null, stale: true })
  })

  it('starts afresh from a pairing for a device the group does not hold, keeping the group id the record held', () => {
    const fresh: Pairing = { ...PAIRING, mac: deviceId(generateIdentity().publicKey), macName: 'laptop' }
    const membership = { group: other, founding: 'f', version: 4, member: true }
    const withId = { ...group, group: { ...group.group, membership } }
    const { record, stale } = reconcileGroup(withId, fresh)
    expect(stale).toBe(true)
    expect(record?.group.paired.map((d) => d.id)).toEqual([fresh.mac])
    // Never the pairing's device as the group: that is only the first paired device since groups.
    expect(record?.group.membership).toEqual(membership)
    // A device the roster no longer names is not held either, nor a device on another relay.
    const removed = { ...group, group: { ...group.group, paired: [], roster: rosterOf(generateIdentity()) } }
    expect(reconcileGroup(removed, { ...PAIRING, mac: other }).stale).toBe(true)
    expect(reconcileGroup(group, { ...PAIRING, relay: 'https://other.test' }).stale).toBe(true)
  })

  it('migrates from the pairing only when no group record was ever written; one that does not read keeps its group id', () => {
    // A record was written once (the marker), and is gone now: the pairing's device is a pair, not the group.
    const gone = reconcileGroup(null, PAIRING, { seen: true, membership: null }).record!
    expect(gone.group.paired.map((d) => d.id)).toEqual([mac])
    expect(gone.group.membership).toBeUndefined()
    // A record that does not read as a whole keeps the group id it still holds.
    const kept = { group: other, founding: 'f', version: 2, member: true }
    const raw = JSON.stringify({ relay: 'not a url', group: { membership: kept } })
    expect(parseGroupRecord(raw)).toBeNull()
    expect(storedMembership(raw)).toEqual(kept)
    expect(reconcileGroup(null, PAIRING, { seen: true, membership: storedMembership(raw) }).record?.group.membership).toEqual(kept)
    expect(storedMembership('nope')).toBeNull()
  })

})

describe('PersistQueue', () => {
  it('writes one at a time and ends on the last state, skipping the ones in between', async () => {
    const written: number[] = []
    let release: () => void = () => {}
    const queue = new PersistQueue<number>(async (value) => {
      await new Promise<void>((r) => {
        release = r
      })
      written.push(value)
    })
    queue.push(1)
    queue.push(2)
    queue.push(3)
    release()
    await vi.waitFor(() => expect(written).toEqual([1]))
    release()
    await queue.idle()
    expect(written).toEqual([1, 3])
  })

  it('writes nothing more once closed, and tells a failed write', async () => {
    const write = vi.fn(async (value: number) => {
      if (value === 1) throw new Error('disk')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const queue = new PersistQueue<number>(write)
    queue.push(1)
    await queue.idle()
    expect(queue.lastError).toBeInstanceOf(Error)
    queue.push(2)
    await queue.idle()
    expect(queue.lastError).toBeNull()
    queue.close()
    queue.push(3)
    await queue.idle()
    expect(write.mock.calls.map(([v]) => v)).toEqual([1, 2])
    warn.mockRestore()
  })
})

describe('per-device features', () => {
  const device = (id: string, version: string | null): DeviceView => ({
    id, name: id, kind: 'desktop', os: 'macOS', online: true, ready: true, asOf: null, version, capabilities: [], refused: null,
  })
  const devices = [device('new', MAC_FEATURES.media), device('old', '0.25.0'), device('quiet', null)]

  it("reads each device's own version", () => {
    expect(deviceSupports('media', 'new', devices)).toBe(true)
    expect(deviceSupports('media', 'old', devices)).toBe(false)
    // Nothing is asked of a device not yet known, or not in the group.
    expect(deviceSupports('media', 'quiet', devices)).toBe(false)
    expect(deviceSupports('media', 'gone', devices)).toBe(false)
  })

  it('judges a session by the device it runs on', () => {
    useMobile.setState({ devices, macVersion: MAC_FEATURES.media })
    const owners: Record<string, string> = { a: 'new', b: 'old' }
    const ownerOf = (id: string) => owners[id] ?? null
    expect(sessionSupports('media', 'a', ownerOf)).toBe(true)
    expect(sessionSupports('media', 'b', ownerOf)).toBe(false)
    // A session whose device is not known yet, or none, goes by the default member.
    expect(sessionSupports('media', 'c', ownerOf)).toBe(true)
    expect(sessionSupports('media', null, ownerOf)).toBe(true)
    useMobile.setState({ macVersion: '0.25.0' })
    expect(sessionSupports('media', 'c', ownerOf)).toBe(false)
  })
})
