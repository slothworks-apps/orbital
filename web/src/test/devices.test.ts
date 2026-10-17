import { describe, expect, it } from 'vitest'
import { deviceId, generateIdentity, toBase64Url } from '@orbital/shared/remote/keys'
import { parsePairingCode } from '@orbital/shared/remote/relayApi'
import { addedByLine, kindOs, memberStateWords, oneWordCode, osLabel } from '../lib/devices'
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
  const build = member({ id: 'build-id', name: 'build-box', self: false })

  it('names the adder from the roster when it is known', () => {
    const m = member({ id: 'air-id', addedBy: 'build-id' })
    expect(addedByLine(m, [build, m])).toBe('added by build-box')
  })

  it('falls back to the first 8 characters of an adder no longer in the group', () => {
    const m = member({ id: 'air-id', addedBy: 'deadbeef12345678' })
    expect(addedByLine(m, [m])).toBe('added by deadbeef')
  })

  it('is null for the device that started the group', () => {
    const m = member({ id: 'self-id', self: true, addedBy: 'self-id' })
    expect(addedByLine(m, [m])).toBeNull()
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
