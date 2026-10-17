import { describe, expect, it } from 'vitest'
import { deviceId, generateIdentity, toBase64Url } from '@orbital/shared/remote/keys'
import { parsePairingCode } from '@orbital/shared/remote/relayApi'
import { addedByLine, deviceRows, kindOs, memberStateWords, oneWordCode, osLabel } from '../lib/devices'
import type { GroupMember } from '../lib/types'

const NOW = Date.now()

function member(patch: Partial<GroupMember> = {}): GroupMember {
  return {
    id: 'self-id', kind: 'desktop', name: 'studio-mbp', os: 'macos', links: true,
    epoch: 1, addedBy: 'self-id', addedAt: NOW, describedAt: NOW,
    self: false, linked: true, online: true, pairByHand: false, state: 'online', seenAt: null,
    ...patch,
  }
}

describe('memberStateWords', () => {
  it('reads self as this device', () => {
    expect(memberStateWords(member({ self: true, state: 'self' }), NOW)).toBe('this device')
  })

  it('reads online as online', () => {
    expect(memberStateWords(member({ state: 'online' }), NOW)).toBe('online')
  })

  it('reads offline with a seen time as offline, seen ago', () => {
    const twoHoursAgo = NOW - 2 * 60 * 60_000
    expect(memberStateWords(member({ state: 'offline', seenAt: twoHoursAgo }), NOW)).toBe('offline · seen 2h ago')
  })

  it('reads a time under a minute as seen just now, never "seen now ago"', () => {
    expect(memberStateWords(member({ state: 'offline', seenAt: NOW - 10_000 }), NOW)).toBe('offline · seen just now')
  })

  it('reads a time old enough to be a date without "ago"', () => {
    const longAgo = NOW - 90 * 24 * 60 * 60_000
    const words = memberStateWords(member({ state: 'offline', seenAt: longAgo }), NOW)
    expect(words).toMatch(/^offline · seen \S+ \d+$/)
    expect(words).not.toMatch(/ago$/)
  })

  it('reads offline with no seen time as bare offline', () => {
    expect(memberStateWords(member({ state: 'offline', seenAt: null }), NOW)).toBe('offline')
  })

  it('reads linking as linking…', () => {
    expect(memberStateWords(member({ state: 'linking' }), NOW)).toBe('linking…')
  })

  it('reads notLinked as pair by hand', () => {
    expect(memberStateWords(member({ state: 'notLinked' }), NOW)).toBe('not linked — pair by hand')
  })
})

describe('osLabel', () => {
  it('names the four known OSes', () => {
    expect(osLabel('macos')).toBe('macOS')
    expect(osLabel('linux')).toBe('Linux')
    expect(osLabel('ios')).toBe('iOS')
    expect(osLabel('android')).toBe('Android')
  })

  it('leaves an unknown OS as is', () => {
    expect(osLabel('windows')).toBe('windows')
    expect(osLabel('')).toBe('')
  })
})

describe('kindOs', () => {
  it('joins the kind and the OS label', () => {
    expect(kindOs('desktop', 'macos')).toBe('desktop · macOS')
    expect(kindOs('headless', 'linux')).toBe('headless · Linux')
  })

  it('drops the separator when the OS is unknown to this device yet', () => {
    expect(kindOs('headless', '')).toBe('headless')
  })
})

describe('addedByLine', () => {
  const self = member({ id: 'self-id', name: 'studio-mbp', self: true, addedBy: 'someone-else' })
  const build = member({ id: 'build-id', name: 'build-box', self: false })

  it('reads "started the group" for the member no one added', () => {
    const m = member({ id: 'air-id', addedBy: 'air-id' })
    expect(addedByLine(m, [m])).toBe('started the group')
  })

  it('names the adder "this device" when it is the self entry in members', () => {
    const m = member({ id: 'air-id', addedBy: 'self-id' })
    expect(addedByLine(m, [self, m])).toBe('added by this device')
  })

  it('names the adder from the roster when it is some other live member', () => {
    const m = member({ id: 'air-id', addedBy: 'build-id' })
    expect(addedByLine(m, [build, m])).toBe('added by build-box')
  })

  it('falls back to the first 8 characters of an adder no longer in the group', () => {
    const m = member({ id: 'air-id', addedBy: 'deadbeef12345678' })
    expect(addedByLine(m, [m])).toBe('added by deadbeef')
  })
})

describe('oneWordCode', () => {
  it('round-trips a QR payload through the shared parsePairingCode', () => {
    const mac = deviceId(generateIdentity().publicKey)
    const qr = {
      v: 1 as const, relay: 'https://relay.example.org', mac, name: 'studio', token: 'tok',
      secret: toBase64Url(new Uint8Array(16).fill(1)),
    }
    const json = JSON.stringify(qr)
    expect(parsePairingCode(oneWordCode(json))).toEqual(qr)
  })
})

describe('deviceRows', () => {
  const self = member({ id: 'self-id', name: 'studio-mbp', self: true, state: 'self' })
  const build = member({ id: 'build-id', name: 'build-box' })

  it('a phone paired with another member reads paired with its adder, with no presence', () => {
    const phone = member({
      id: 'p1', kind: 'phone', os: 'ios', links: false, linked: false, state: 'offline', addedBy: 'build-id',
    })
    const row = deviceRows([self, build, phone], [], NOW).find((r) => r.id === 'p1')!
    expect(row.state).toBe('elsewhere')
    expect(row.words).toBe('paired with build-box')
  })

  it('names an adder no longer in the group by its short id', () => {
    const phone = member({
      id: 'p1', kind: 'phone', os: 'ios', links: false, linked: false, state: 'online', addedBy: 'deadbeef12345678',
    })
    expect(deviceRows([self, phone], [], NOW)[0].words).toBe('paired with deadbeef')
  })

  it('a desktop that does not link yet keeps its own state words', () => {
    const desk = member({ id: 'd1', links: false, linked: false, state: 'offline' })
    expect(deviceRows([self, desk], [], NOW)[0]).toMatchObject({ state: 'offline', words: 'offline' })
  })

  it('a phone paired here keeps its presence', () => {
    const phone = member({ id: 'p1', kind: 'phone', os: 'ios', links: false, linked: true, state: 'offline' })
    expect(deviceRows([self, phone], [], NOW)[0]).toMatchObject({ state: 'offline', words: 'offline' })
  })

  it('an unlisted device seen under a minute ago reads seen just now', () => {
    const rows = deviceRows([self], [{
      id: 'old', name: 'Galaxy', platform: 'android', kind: null, pairedAt: NOW, lastSeenAt: NOW - 5_000, online: false,
      needsUpdate: null,
    }], NOW)
    expect(rows[0].words).toBe('offline · seen just now')
  })
})
