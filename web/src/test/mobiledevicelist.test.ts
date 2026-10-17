import { describe, expect, it } from 'vitest'
import type { MemberRow } from '@orbital/shared/remote/group'
import { LOCAL_DEVICE, devicesOn, namesShown, openingDevice, toggleDevice, type DeviceOption } from '../lib/devices'
import type { ApiSession, MachineRef } from '../lib/types'
import {
  asleepCards, asleepDevices, deviceAsleep, onDevices, phoneChips, phoneDeviceOptions, phoneOpeningDevice, sessionAsleep,
  sessionReady,
} from '../mobile/deviceList'
import { launchRequest } from '../mobile/newSession'
import type { DeviceView, MobileState } from '../mobile/state'

const NOW = Date.UTC(2026, 9, 17, 12)
const HOUR = 3_600_000

function source(over: Partial<DeviceView> & Pick<DeviceView, 'id' | 'name'>): DeviceView {
  return {
    kind: 'desktop', os: 'macos', online: true, ready: true, asOf: null, version: '0.30.0', capabilities: [], refused: null,
    ...over,
  }
}

function member(over: Partial<MemberRow> & Pick<MemberRow, 'id' | 'name'>): MemberRow {
  return {
    kind: 'desktop', os: 'macos', links: true, epoch: 1, addedBy: 'phone', addedAt: NOW - 24 * HOUR, describedAt: NOW,
    self: false, linked: true, online: true, pairByHand: false, state: 'online', seenAt: null,
    ...over,
  }
}

type S = Pick<ApiSession, 'machine' | 'status' | 'purpose'>

function on(id: string, status: ApiSession['status'] = 'idle', extra: Partial<MachineRef> = {}): S {
  return { status, purpose: undefined, machine: { id, name: id, kind: 'desktop', os: 'macos', online: true, asOf: null, ...extra } }
}

const studio = source({ id: 'studio', name: 'studio-mbp' })
const build = source({ id: 'build', name: 'build-box', kind: 'headless', os: 'linux' })
const air = source({ id: 'air', name: 'air-m3', online: false, ready: false, asOf: NOW - 2 * HOUR })
const gpu = source({
  id: 'gpu', name: 'gpu-01', kind: 'headless', online: true, ready: false,
  refused: { cause: 'mac', theirs: '0.20.0', needed: '0.24.0' },
})

function state(devices: DeviceView[], over: Partial<MobileState> = {}): Pick<MobileState, 'link' | 'rechecking' | 'devices' | 'macOnline' | 'ready'> {
  return { link: 'online', rechecking: null, devices, macOnline: devices.some((d) => d.online), ready: true, ...over }
}

describe('deviceAsleep', () => {
  it('is asleep only while the relay is up and says the device is away', () => {
    expect(deviceAsleep(state([studio, air]), 'air')).toBe(true)
    expect(deviceAsleep(state([studio, air]), 'studio')).toBe(false)
    // A relay link still coming up says nothing about any device.
    expect(deviceAsleep(state([studio, air], { link: 'connecting' }), 'air')).toBe(false)
  })

  it('never calls a device that refused this app, or one still linking, asleep', () => {
    expect(deviceAsleep(state([gpu]), 'gpu')).toBe(false)
    expect(deviceAsleep(state([source({ id: 'x', name: 'x', online: true, ready: false })]), 'x')).toBe(false)
  })

  it('holds the answer from before a check while it runs', () => {
    const held = state([studio, air], { link: 'connecting', rechecking: { asleep: false, asleepIds: ['air'] } })
    expect(deviceAsleep(held, 'air')).toBe(true)
    expect(deviceAsleep(held, 'studio')).toBe(false)
    expect(asleepDevices(state([studio, air, gpu]))).toEqual(['air'])
  })

  it('judges a session by its own device, and one of an unknown device by the whole group', () => {
    const s = state([studio, air])
    expect(sessionAsleep(s, 'air')).toBe(true)
    expect(sessionAsleep(s, 'studio')).toBe(false)
    // Unknown: the group as a whole is awake.
    expect(sessionAsleep(s, 'gone')).toBe(false)
    expect(sessionAsleep(state([air], { macOnline: false }), null)).toBe(true)
  })

  it('sends about a session only while its own device is up', () => {
    const s = state([studio, air])
    expect(sessionReady(s, 'studio')).toBe(true)
    expect(sessionReady(s, 'air')).toBe(false)
    expect(sessionReady({ ...s, ready: false }, null)).toBe(false)
  })
})

describe('phoneChips', () => {
  it('gives a chip per device that hosts sessions, never the phone, counting what has not ended', () => {
    const sessions = [on('studio'), on('studio', 'working'), on('studio', 'ended'), on('build'), on('air')]
    const chips = phoneChips(state([studio, build, air, gpu]), sessions)
    expect(chips.map((c) => [c.id, c.count, c.offline, c.update])).toEqual([
      ['studio', 2, false, false],
      ['build', 1, false, false],
      ['air', 1, true, false],
      ['gpu', 0, false, true],
    ])
    expect(chips.some((c) => c.id === LOCAL_DEVICE)).toBe(false)
  })

  it('leaves a harness draft out of the count', () => {
    const draft = { ...on('studio'), purpose: 'harness_draft' } as S
    expect(phoneChips(state([studio]), [draft, on('studio')])[0].count).toBe(1)
  })

  it('works with the desktop filter: the last chip on stays on, names show with two on', () => {
    const chips = phoneChips(state([studio, build]), [])
    let hidden = toggleDevice([], 'studio', chips)
    expect(devicesOn(chips, hidden)).toEqual(['build'])
    expect(namesShown(chips, hidden)).toBe(false)
    hidden = toggleDevice(hidden, 'build', chips)
    expect(devicesOn(chips, hidden)).toEqual(['build'])
    expect(namesShown(chips, [])).toBe(true)
  })

  it('filters by the chips that are on, keeping a session no chip names', () => {
    const chips = phoneChips(state([studio, build]), [])
    const loose = { status: 'idle', purpose: undefined } as S
    const list = [on('studio'), on('build'), loose, on('gone')]
    expect(onDevices(list, chips, ['build'])).toEqual([list[1], loose, list[3]])
    expect(onDevices(list, chips, ['studio', 'build'])).toEqual(list)
  })
})

describe('asleepCards', () => {
  it('gives a card per asleep device whose chip is on, dated by when it last sent', () => {
    const s = state([studio, air, source({ id: 'mini', name: 'mini', online: false, ready: false })])
    const chips = phoneChips(s, [])
    expect(asleepCards(s, chips, ['studio', 'air', 'mini'], NOW)).toEqual([
      { id: 'air', name: 'air-m3', line: 'showing what it last sent · as of 2 h ago' },
      { id: 'mini', name: 'mini', line: 'showing what it last sent' },
    ])
    expect(asleepCards(s, chips, ['studio', 'mini'], NOW).map((c) => c.id)).toEqual(['mini'])
  })
})

describe('phoneDeviceOptions', () => {
  it('lists every device with the reason an inert one cannot take a session, then members not paired here', () => {
    const linking = source({ id: 'lnk', name: 'lnk', online: true, ready: false })
    const options = phoneDeviceOptions(state([studio, build, air, gpu, linking]), [
      member({ id: 'phone', name: 'Pixel', kind: 'phone', self: true, state: 'self' }),
      member({ id: 'studio', name: 'studio-mbp' }),
      member({ id: 'mini', name: 'mini-office', state: 'notLinked', linked: false }),
      member({ id: 'pad', name: 'other phone', kind: 'phone' }),
    ], NOW)
    expect(options.map((o) => [o.id, o.inert, o.sub])).toEqual([
      ['studio', false, 'desktop · macOS'],
      ['build', false, 'headless · Linux'],
      ['air', true, 'asleep · seen 2 h ago'],
      ['gpu', true, 'update Orbital on gpu-01'],
      ['lnk', true, 'linking…'],
      ['mini', true, 'not linked — pair by hand'],
    ])
  })
})

describe('the device New session opens on', () => {
  const opt = (id: string, inert = false): DeviceOption => ({ id, label: id, name: id, kind: 'desktop', sub: '', inert })

  it('is the last one launched on while it can take a session, else the first awake', () => {
    const options = [opt('air', true), opt('studio'), opt('build')]
    expect(phoneOpeningDevice(options, 'build')).toBe('build')
    expect(phoneOpeningDevice(options, 'air')).toBe('studio')
    expect(phoneOpeningDevice(options, null)).toBe('studio')
    expect(phoneOpeningDevice(options, 'gone')).toBe('studio')
  })

  it('is the first listed when none is awake, and none with no devices', () => {
    expect(phoneOpeningDevice([opt('air', true), opt('gpu', true)], null)).toBe('air')
    expect(phoneOpeningDevice([], 'air')).toBeNull()
  })

  it('keeps the desktop on this device when nothing else applies', () => {
    expect(openingDevice([opt(LOCAL_DEVICE), opt('build')], null)).toBe(LOCAL_DEVICE)
    expect(openingDevice([opt(LOCAL_DEVICE), opt('build')], 'build')).toBe('build')
  })
})

describe('launchRequest', () => {
  const base = { cwd: ' ~/web ', prompt: 'go', files: [], mode: 'acceptEdits' as const, model: null, claudeDirId: null, refs: [] }

  it('names the chosen device and checks the directory first', () => {
    expect(launchRequest({ ...base, machine: 'build' })).toEqual({
      cwd: '~/web', prompt: 'go', permissionMode: 'acceptEdits', model: undefined, requireDirectory: true, machine: 'build',
    })
  })

  it('leaves the device out before one is known, and adds only what the form holds', () => {
    const body = launchRequest({ ...base, machine: null, claudeDirId: 2, refs: ['r1'], model: 'opus' })
    expect(body).not.toHaveProperty('machine')
    expect(body).toMatchObject({ claudeDirId: 2, attachments: ['r1'], model: 'opus' })
    expect(launchRequest({ ...base, machine: null })).not.toHaveProperty('attachments')
  })
})
