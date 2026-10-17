import { describe, expect, it } from 'vitest'
import type { MemberRow } from '@orbital/shared/remote/group'
import { joinSentence } from '../lib/joinRequest'
import { ownCodeLeft, phoneRows, removalLeavesAlone } from '../mobile/devices'
import type { DeviceView } from '../mobile/state'

const NOW = Date.UTC(2026, 9, 17, 12)
const HOUR = 3_600_000

function member(over: Partial<MemberRow> & Pick<MemberRow, 'id' | 'name'>): MemberRow {
  return {
    kind: 'desktop', os: 'macos', links: true, epoch: 1, addedBy: 'phone', addedAt: NOW - 24 * HOUR, describedAt: NOW,
    self: false, linked: true, online: true, pairByHand: false, state: 'online', seenAt: null,
    ...over,
  }
}

function source(over: Partial<DeviceView> & Pick<DeviceView, 'id' | 'name'>): DeviceView {
  return {
    kind: 'desktop', os: 'macos', online: true, ready: true, asOf: null, version: '0.9.0', capabilities: [], refused: null,
    ...over,
  }
}

describe('phoneRows', () => {
  const self = member({ id: 'phone', name: 'Pixel 8', kind: 'phone', os: 'android', self: true, state: 'self' })

  it('lists every member but this phone, and names this phone as the adder', () => {
    const rows = phoneRows([self, member({ id: 'studio', name: 'studio-mbp', addedBy: 'studio' }), member({ id: 'air', name: 'air-m3' })], [], NOW)
    expect(rows.map((r) => [r.name, r.added])).toEqual([
      ['studio-mbp', 'started the group'],
      ['air-m3', 'added by this phone'],
    ])
    expect(rows[1].kindOs).toBe('desktop · macOS')
  })

  it('says asleep where the desktop says offline, dated as the desktop dates it', () => {
    const [row] = phoneRows([self, member({ id: 'air', name: 'air-m3', state: 'offline', online: false, seenAt: NOW - 2 * HOUR })], [], NOW)
    expect(row.state).toBe('offline')
    expect(row.words).toBe('asleep · seen 2h ago')
  })

  it('offers pair by hand only for a member that does not link with this phone yet', () => {
    const rows = phoneRows([
      self,
      member({ id: 'mini', name: 'mini-office', linked: false, pairByHand: true, state: 'notLinked' }),
      member({ id: 'rpi', name: 'rpi-lab', kind: 'headless', linked: false, state: 'linking' }),
    ], [], NOW)
    expect(rows.map((r) => r.notLinked)).toEqual([true, false])
  })

  it('marks a member this phone refused as too old, whatever its presence', () => {
    const studio = member({ id: 'studio', name: 'studio-mbp' })
    const refused = source({ id: 'studio', name: 'studio-mbp', refused: { cause: 'mac', theirs: '0.1.0', needed: '0.2.0' } })
    const [row] = phoneRows([self, studio], [refused], NOW)
    expect(row.state).toBe('update')
    expect(row.words).toBe('update Orbital on studio-mbp')
    // A device refusing this app is this app's update, not the device's.
    const app = source({ id: 'studio', name: 'studio-mbp', refused: { cause: 'app', theirs: null, needed: '0.3.0' } })
    expect(phoneRows([self, studio], [app], NOW)[0].state).toBe('online')
  })

  it('lists a paired Mac from before groups, which sends no roster', () => {
    const rows = phoneRows([self], [source({ id: 'old', name: 'old-mac', online: false, asOf: NOW - 3 * HOUR })], NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'old', name: 'old-mac', state: 'offline', added: 'paired with this phone' })
    expect(rows[0].words).toBe('asleep · seen 3h ago')
  })
})

describe('ownCodeLeft', () => {
  it('counts down in m:ss, then asks for a new code', () => {
    expect(ownCodeLeft(NOW + 102_000, NOW)).toMatchObject({ line: 'expires in 1:42 · one device per code', expired: false })
    // A part second rounds up: an open code never reads 0:00.
    expect(ownCodeLeft(NOW + 200, NOW).line).toBe('expires in 0:01 · one device per code')
    expect(ownCodeLeft(NOW, NOW)).toMatchObject({ line: 'expired · make a new code', expired: true, fraction: 0 })
  })
})

describe('joinSentence', () => {
  it('names the OS from a Node platform or an OS name alike, and drops it when unknown', () => {
    expect(joinSentence({ name: 'imac-home', kind: 'desktop', platform: 'darwin' })).toBe('imac-home (desktop, macOS) wants to join')
    expect(joinSentence({ name: 'Pixel', kind: 'phone', platform: 'android' })).toBe('Pixel (phone, Android) wants to join')
    expect(joinSentence({ name: 'box', kind: 'headless', platform: '' })).toBe('box (headless) wants to join')
  })
})

describe('removalLeavesAlone', () => {
  const self = member({ id: 'phone', name: 'Pixel 8', kind: 'phone', os: 'android', self: true, state: 'self' })
  const studio = member({ id: 'studio', name: 'studio-mbp' })

  it('is a leave when the device removed is the last one this phone reaches', () => {
    expect(removalLeavesAlone([self, studio], [source({ id: 'studio', name: 'studio-mbp' })], 'studio')).toBe(true)
  })

  it('is not while another member links, or this phone is paired with it', () => {
    const air = member({ id: 'air', name: 'air-m3', linked: false, state: 'linking' })
    expect(removalLeavesAlone([self, studio, air], [], 'studio')).toBe(false)
    const paired = member({ id: 'old', name: 'old-mac', links: false, linked: true })
    expect(removalLeavesAlone([self, studio, paired], [], 'studio')).toBe(false)
  })

  it('counts a member that neither links nor is paired here as nobody to reach', () => {
    const ghost = member({ id: 'ghost', name: 'ghost', links: false, linked: false })
    expect(removalLeavesAlone([self, studio, ghost], [], 'studio')).toBe(true)
  })

  it('counts a paired Mac from before groups, which the roster does not list', () => {
    expect(removalLeavesAlone([self, studio], [source({ id: 'old', name: 'old-mac' })], 'studio')).toBe(false)
    expect(removalLeavesAlone([self], [source({ id: 'old', name: 'old-mac' })], 'old')).toBe(true)
  })
})
