import { describe, expect, it } from 'vitest'
import { deviceId, generateIdentity, toBase64Url } from '@orbital/shared/remote/keys'
import { parsePairingCode } from '@orbital/shared/remote/relayApi'
import {
  LOCAL_DEVICE, addedByLine, asOfLabel, deviceChips, deviceOf, deviceRows, devicesOn, kindOs, memberStateWords,
  isMemberOffline, namesShown, oneWordCode, osLabel, showDeviceRow, toggleDevice,
  agoWords, deviceLock, ideHere, pillWords, runsOn, sessionOfUrl, stateAsOf, withMachineOffline,
} from '../lib/devices'
import { ApiError } from '../lib/api'
import type { GroupMember, IdeContext, MachineRef } from '../lib/types'

const NOW = Date.now()

function member(patch: Partial<GroupMember> = {}): GroupMember {
  return {
    id: 'self-id', kind: 'desktop', name: 'studio-mbp', os: 'macos', links: true,
    epoch: 1, addedBy: 'self-id', addedAt: NOW, describedAt: NOW,
    self: false, linked: true, online: true, pairByHand: false, state: 'online', seenAt: null, tooOld: false,
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
    // Same Intl call as `timeAgo` in format.ts, so this holds under any locale.
    const expectedDate = new Date(longAgo).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const words = memberStateWords(member({ state: 'offline', seenAt: longAgo }), NOW)
    expect(words).toBe(`offline · seen ${expectedDate}`)
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

  it('reads a too-old Orbital as what to do about it, whatever its presence', () => {
    expect(memberStateWords(member({ name: 'gpu-01', state: 'online', tooOld: true }), NOW)).toBe('update Orbital on gpu-01')
    expect(memberStateWords(member({ name: 'gpu-01', state: 'offline', seenAt: NOW, tooOld: true }), NOW))
      .toBe('update Orbital on gpu-01')
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

describe('device chips (canvas 50e)', () => {
  const self = member({ id: 'me', name: 'studio-mbp', self: true, state: 'self' })
  const roster = [
    self,
    member({ id: 'build', name: 'build-box', kind: 'headless', os: 'linux', state: 'online' }),
    member({ id: 'phone', name: 'pixel', kind: 'phone', os: 'android', state: 'online' }),
    member({ id: 'air', name: 'air-m3', state: 'offline', seenAt: NOW }),
    member({ id: 'new', name: 'new-box', kind: 'headless', state: 'linking' }),
    member({ id: 'hand', name: 'hand-box', kind: 'headless', state: 'notLinked' }),
    member({ id: 'gpu', name: 'gpu-01', kind: 'headless', state: 'linking', tooOld: true }),
  ]

  it('gives this device first, then linked non-phones and too-old ones in roster order', () => {
    const chips = deviceChips(roster)
    expect(chips.map((c) => c.id)).toEqual([LOCAL_DEVICE, 'build', 'air', 'gpu'])
    expect(chips[0]).toMatchObject({ label: 'This device', name: 'studio-mbp', offline: false, update: false })
    expect(chips.find((c) => c.id === 'air')).toMatchObject({ label: 'air-m3', offline: true, update: false })
    expect(chips.find((c) => c.id === 'gpu')).toMatchObject({ offline: false, update: true })
  })

  it('is just this device with the remote off, and the row stays hidden', () => {
    expect(deviceChips(undefined).map((c) => c.id)).toEqual([LOCAL_DEVICE])
    expect(showDeviceRow(deviceChips(undefined))).toBe(false)
    expect(showDeviceRow(deviceChips([self, roster[2]]))).toBe(false)
    expect(showDeviceRow(deviceChips(roster))).toBe(true)
  })

  it('reads a session without a machine as this device', () => {
    expect(deviceOf({})).toBe(LOCAL_DEVICE)
    expect(deviceOf({ machine: { id: 'build', name: 'build-box', kind: 'headless', os: 'linux', online: true, asOf: null } }))
      .toBe('build')
  })

  const chips = deviceChips(roster)

  it('devicesOn ignores hidden ids no chip names any more', () => {
    expect(devicesOn(chips, ['gone', 'air'])).toEqual([LOCAL_DEVICE, 'build', 'gpu'])
  })

  it('devicesOn never leaves none on: the one left on disappearing turns them all back on', () => {
    const two = deviceChips([self, roster[1]])
    // `build` was the one on; it stops linking and loses its chip.
    expect(devicesOn(deviceChips([self]), [LOCAL_DEVICE])).toEqual([LOCAL_DEVICE])
    expect(devicesOn(two, [LOCAL_DEVICE, 'build'])).toEqual([LOCAL_DEVICE, 'build'])
  })

  it('toggleDevice turns a chip off and back on', () => {
    const off = toggleDevice([], 'build', chips)
    expect(off).toEqual(['build'])
    expect(toggleDevice(off, 'build', chips)).toEqual([])
  })

  it('toggleDevice refuses to turn off the last chip on', () => {
    const hidden = [LOCAL_DEVICE, 'build', 'air']
    expect(toggleDevice(hidden, 'gpu', chips)).toBe(hidden)
  })

  it('toggleDevice keeps a stale id, so a member that drops out keeps its choice', () => {
    expect(toggleDevice(['gone'], 'build', chips)).toEqual(['gone', 'build'])
  })

  it('namesShown needs the row and two chips on', () => {
    expect(namesShown(chips, [])).toBe(true)
    expect(namesShown(chips, ['build', 'air'])).toBe(true)
    expect(namesShown(chips, ['build', 'air', 'gpu'])).toBe(false)
    expect(namesShown(deviceChips([self]), [])).toBe(false)
  })
})

describe('asOfLabel', () => {
  const machine = (patch: Partial<MachineRef>): MachineRef => ({
    id: 'air', name: 'air-m3', kind: 'desktop', os: 'macos', online: false, asOf: NOW - 2 * 60 * 60_000, ...patch,
  })

  it('dates an offline machine the way the canvas spells it', () => {
    expect(asOfLabel(machine({}), NOW)).toBe('as of 2 h')
    expect(asOfLabel(machine({ asOf: NOW - 5 * 60_000 }), NOW)).toBe('as of 5 m')
  })

  it('is null online, for this device and with nothing to date it by', () => {
    expect(asOfLabel(machine({ online: true, asOf: null }), NOW)).toBeNull()
    expect(asOfLabel(undefined, NOW)).toBeNull()
    expect(asOfLabel(machine({ asOf: null }), NOW)).toBeNull()
  })
})

describe('isMemberOffline', () => {
  it('reads a 409 member_offline, and nothing else', () => {
    expect(isMemberOffline(new ApiError('{"error":"member_offline"}', 409))).toBe(true)
    expect(isMemberOffline(new ApiError('{"error":"busy"}', 409))).toBe(false)
    expect(isMemberOffline(new ApiError('{"error":"member_offline"}', 500))).toBe(false)
    expect(isMemberOffline(new Error('member_offline'))).toBe(false)
    expect(isMemberOffline('member_offline')).toBe(false)
  })
})

describe('another device in the detail panel (canvas 50f)', () => {
  const MIN = 60_000
  const machine = (patch: Partial<MachineRef> = {}): MachineRef => ({
    id: 'build', name: 'build-box', kind: 'headless', os: 'linux', online: true, asOf: null, ...patch,
  })
  const self = member({ id: 'self-id', self: true, state: 'self' })
  const build = (patch: Partial<GroupMember> = {}) =>
    member({ id: 'build', name: 'build-box', kind: 'headless', os: 'linux', addedBy: 'self-id', ...patch })

  describe('agoWords', () => {
    it('spells the age the way the panel prints it', () => {
      expect(agoWords(NOW - 10_000, NOW)).toBe('just now')
      expect(agoWords(NOW - 12 * MIN, NOW)).toBe('12 min ago')
      expect(agoWords(NOW - 2 * 60 * MIN, NOW)).toBe('2 h ago')
      expect(agoWords(NOW - 3 * 24 * 60 * MIN, NOW)).toBe('3 d ago')
    })
  })

  describe('deviceLock', () => {
    it('never locks a session of this device', () => {
      expect(deviceLock({}, [self, build({ state: 'offline' })], NOW)).toBeNull()
    })

    it('does not lock a member that is up', () => {
      expect(deviceLock({ machine: machine() }, [self, build()], NOW)).toBeNull()
      expect(deviceLock({ machine: machine() }, undefined, NOW)).toBeNull()
    })

    it('locks an offline member with when it was last seen', () => {
      const lock = deviceLock(
        { machine: machine({ online: false, asOf: NOW - 30 * MIN }) },
        [self, build({ state: 'offline', seenAt: NOW - 12 * MIN })],
        NOW,
      )
      expect(lock).toEqual({
        title: 'build-box is offline',
        body: 'Last seen 12 min ago. Everything it sent is here to read; the composer opens again when build-box is back.',
      })
    })

    it('dates by the session when the roster does not list the member, and leaves the date out with none', () => {
      expect(deviceLock({ machine: machine({ online: false, asOf: NOW - 5 * MIN }) }, [self], NOW)?.body)
        .toMatch(/^Last seen 5 min ago\. /)
      expect(deviceLock({ machine: machine({ online: false }) }, [self], NOW)?.body)
        .toBe('Everything it sent is here to read; the composer opens again when build-box is back.')
    })

    it('locks once the roster has the member offline, before the session says so', () => {
      expect(deviceLock({ machine: machine() }, [self, build({ state: 'offline' })], NOW)?.title)
        .toBe('build-box is offline')
    })

    it('asks for an update on a member too old to be driven, whatever its presence', () => {
      expect(deviceLock({ machine: machine() }, [self, build({ tooOld: true })], NOW)).toEqual({
        title: 'Update Orbital on build-box',
        body: 'Its Orbital is too old to be driven from here. Reading still works.',
      })
    })
  })

  describe('runsOn and pillWords', () => {
    it('reads an online member with who added it', () => {
      const card = runsOn({ machine: machine() }, [self, build()], NOW)
      expect(card).toEqual({
        name: 'build-box', kind: 'headless', os: 'linux', dot: 'live', words: 'online · added by this device',
      })
      expect(pillWords({ machine: machine() }, [self, build()])).toBe('build-box')
    })

    it('reads an offline member with when it was seen', () => {
      const s = { machine: machine({ online: false, asOf: NOW - 12 * MIN }) }
      expect(runsOn(s, [self], NOW)).toMatchObject({ dot: 'offline', words: 'offline · seen 12 min ago' })
      expect(pillWords(s, [self])).toBe('build-box · offline')
    })

    it('reads a member too old as needing an update', () => {
      const members = [self, build({ tooOld: true })]
      expect(runsOn({ machine: machine() }, members, NOW)).toMatchObject({
        dot: 'update', words: 'update Orbital on build-box',
      })
      expect(pillWords({ machine: machine() }, members)).toBe('build-box · update')
    })

    it("names this device's own pill by its roster entry", () => {
      expect(runsOn({}, [self], NOW)).toMatchObject({ name: 'studio-mbp', dot: 'live', words: 'this device' })
      expect(pillWords({}, [self])).toBe('studio-mbp')
    })
  })

  describe('stateAsOf', () => {
    it('dates an offline device and nothing else', () => {
      expect(stateAsOf(machine({ online: false, asOf: NOW - 12 * MIN }), NOW)).toBe('AS OF 12 MIN AGO')
      expect(stateAsOf(machine(), NOW)).toBeNull()
      expect(stateAsOf(undefined, NOW)).toBeNull()
      expect(stateAsOf(machine({ online: false }), NOW)).toBeNull()
    })
  })

  describe('withMachineOffline', () => {
    it("marks only that device's sessions offline, keeping a date they had", () => {
      const sessions: Record<string, { machine?: MachineRef }> = {
        a: { machine: machine() },
        b: { machine: machine({ online: false, asOf: NOW - MIN }) },
        c: { machine: machine({ id: 'air' }) },
        d: {},
      }
      const next = withMachineOffline(sessions, 'build', NOW)
      expect(next.a.machine).toMatchObject({ online: false, asOf: NOW })
      expect(next.b).toBe(sessions.b)
      expect(next.c).toBe(sessions.c)
      expect(next.d).toBe(sessions.d)
    })

    it('returns the same object when nothing changes', () => {
      const sessions: Record<string, { machine?: MachineRef }> = { d: {} }
      expect(withMachineOffline(sessions, 'build', NOW)).toBe(sessions)
    })
  })

  describe('sessionOfUrl', () => {
    it('reads the session the way the server routes it', () => {
      expect(sessionOfUrl('/api/sessions/abc%3A1/interrupt')).toBe('abc:1')
      expect(sessionOfUrl('/api/sessions/abc')).toBe('abc')
      expect(sessionOfUrl('/api/files/preview?session=xyz&path=a')).toBe('xyz')
      expect(sessionOfUrl('/api/settings')).toBeNull()
      expect(sessionOfUrl(undefined)).toBeNull()
    })
  })

  describe('ideHere', () => {
    it("drops the editor of another device's session", () => {
      const ide = { ideName: 'VS Code' } as IdeContext
      expect(ideHere({ ide })).toBe(ide)
      expect(ideHere({ ide, machine: machine() })).toBeNull()
      expect(ideHere(undefined)).toBeNull()
    })
  })
})
