import { describe, expect, it, vi } from 'vitest'
import { deviceId, fingerprint, generateIdentity } from '@orbital/shared/remote/keys'
import type { RosterEntry } from '@orbital/shared/remote/roster'
import { migratePairing, pairingFromGroup, parseGroupRecord, type Pairing } from '../mobile/platform/parse'
import { PersistQueue } from '../mobile/platform/persistQueue'
import { useMobile, type DeviceView } from '../mobile/state'
import { MAC_FEATURES, deviceSupports, sessionSupports } from '../mobile/version'

const phone = generateIdentity()
const macKey = generateIdentity().publicKey
const mac = deviceId(macKey)
const PAIRING: Pairing = { relay: 'https://relay.test', mac, macName: 'studio', fingerprint: 'f', pairedAt: 7, relaySecret: 's' }

function entry(id: string, patch: Partial<RosterEntry> = {}): RosterEntry {
  return { id, kind: 'desktop', name: id.slice(0, 6), os: 'macOS', links: true, epoch: 1, addedBy: id, addedAt: 3, describedAt: 3, ...patch }
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
    expect(record).toEqual({ relay: PAIRING.relay, group: { roster: [], paired: migratePairing(PAIRING).group.paired, pendingRevokes: [mac] } })
  })

  it("turns a phone's one Mac into a group of it, on the same relay with the same secret", () => {
    expect(migratePairing(PAIRING)).toEqual({
      relay: PAIRING.relay, relaySecret: 's',
      group: {
        roster: [],
        paired: [{ id: mac, name: 'studio', kind: null, platform: '', pairedAt: 7, lastSeenAt: null }],
        pendingRevokes: [],
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
    const lost = {
      ...record,
      group: { roster: [entry(self, { kind: 'phone' }), entry(mac, { removedAt: 9, removedBy: mac }), entry(deviceId(generateIdentity().publicKey))], paired: [], pendingRevokes: [] },
    }
    expect(pairingFromGroup(lost, phone.publicKey)?.mac).toBe(lost.group.roster[2].id)
    // Only itself, or only removed members: not in a group.
    expect(pairingFromGroup({ ...record, group: { roster: [entry(self)], paired: [], pendingRevokes: [] } }, phone.publicKey)).toBeNull()
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
