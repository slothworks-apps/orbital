import { describe, expect, it } from 'vitest'
import { accountViews, lookbackWords, planLabel, sunAccountKeys, thisDevice } from '../limits/accounts'
import type { ClaudeDirInfo, ClaudeDirLimits, MachineRef, RemoteStatus } from '../lib/types'

const NOW = Date.parse('2026-10-20T12:00:00Z')

function dir(id: number, name: string, over: Partial<ClaudeDirLimits> = {}): ClaudeDirLimits {
  return {
    id,
    name,
    account: null,
    tracked: true,
    readAt: new Date(NOW - 60_000).toISOString(),
    stale: false,
    windows: [],
    extraUsage: null,
    waits: [],
    ...over,
  }
}

const studio: MachineRef = { id: 'm1', name: 'build-box', kind: 'headless', os: 'linux', online: true, asOf: null }

function info(id: number, path: string, exists = true): ClaudeDirInfo {
  return { id, name: '', path, overriddenByEnv: false, isDefault: false, exists, account: null }
}

describe('planLabel', () => {
  it('capitalises the plan and has none for an unknown one', () => {
    expect(planLabel('max')).toBe('Max')
    expect(planLabel('pro')).toBe('Pro')
    expect(planLabel('team')).toBe('Team')
    expect(planLabel(' ')).toBeNull()
    expect(planLabel(null)).toBeNull()
    expect(planLabel(undefined)).toBeNull()
  })
})

describe('lookbackWords', () => {
  it('names the largest whole unit', () => {
    expect(lookbackWords(60 * 60_000)).toBe('the last hour')
    expect(lookbackWords(24 * 3_600_000)).toBe('the last day')
    expect(lookbackWords(48 * 3_600_000)).toBe('the last 2 days')
    expect(lookbackWords(6 * 3_600_000)).toBe('the last 6 hours')
    expect(lookbackWords(30 * 60_000)).toBe('the last 30 minutes')
    expect(lookbackWords(90 * 60_000)).toBe('the last 90 minutes')
    expect(lookbackWords(60_000)).toBe('the last minute')
  })
})

describe('accountViews', () => {
  it('lists the paths of this device’s directories and the names of a member’s', () => {
    const [view] = accountViews(
      [dir(1, 'Work', { account: 'jan@acme.com' }), dir(1, 'Work', { account: 'jan@acme.com', machine: studio })],
      { dirInfo: [info(1, '/Users/jan/.claude-work')], self: { id: 'self', name: 'studio-mbp', kind: 'desktop' }, now: NOW },
    )
    expect(view.dirs.map((d) => [d.key, d.name, d.path])).toEqual([
      ['self:1', 'Work', '~/.claude-work'],
      ['m1:1', 'Work', null],
    ])
    expect(view.devices.map((d) => [d.name, d.kind])).toEqual([
      ['studio-mbp', 'desktop'],
      ['build-box', 'headless'],
    ])
  })

  it('lists no devices while every directory is this device’s', () => {
    const views = accountViews([dir(1, 'Work', { account: 'a@x.io' }), dir(2, 'Personal', { account: 'b@x.io' })], {
      dirInfo: null,
      self: { id: 'self', name: 'studio-mbp', kind: 'desktop' },
      now: NOW,
    })
    expect(views.map((v) => v.devices)).toEqual([[], []])
  })

  it('gives monograms among each device’s own directories', () => {
    const views = accountViews(
      [
        dir(1, 'Work', { account: 'a@x.io' }),
        dir(2, 'Webby', { account: 'a@x.io' }),
        dir(1, 'Wonder', { account: 'b@x.io', machine: studio }),
      ],
      { dirInfo: null, self: null, now: NOW },
    )
    expect(views[0].dirs.map((d) => d.mono)).toEqual(['WO', 'WE'])
    expect(views[1].dirs.map((d) => d.mono)).toEqual(['W'])
    expect(views[0].devices.map((d) => d.name)).toEqual(['this device'])
    expect(views[1].devices.map((d) => d.name)).toEqual(['build-box'])
  })

  it('reads an old reading as stale and takes the plan of the reading shown', () => {
    const [view] = accountViews(
      [dir(1, 'Work', { account: 'a@x.io', plan: 'max', readAt: new Date(NOW - 3_600_000).toISOString() })],
      { dirInfo: null, self: null, now: NOW },
    )
    expect(view.stale).toBe(true)
    expect(view.plan).toBe('Max')
    expect(view.title).toBe('a@x.io')
  })

  it('gives suns only to accounts with plan windows', () => {
    const views = accountViews(
      [dir(1, 'Work', { account: 'a@x.io' }), dir(2, 'Usage', { account: 'b@x.io', tracked: false })],
      { dirInfo: null, self: null, now: NOW },
    )
    expect(sunAccountKeys(views)).toEqual(['a@x.io'])
  })
})

describe('thisDevice', () => {
  it('takes the roster’s own entry, else the Mac’s name', () => {
    const group = { members: [{ self: true, name: 'studio-mbp', kind: 'desktop' }] } as unknown as RemoteStatus['group']
    expect(thisDevice({ macName: 'Mac', group })).toEqual({ id: 'self', name: 'studio-mbp', kind: 'desktop' })
    const empty = { members: [] } as unknown as RemoteStatus['group']
    expect(thisDevice({ macName: 'Mac', group: empty })).toEqual({ id: 'self', name: 'Mac', kind: 'desktop' })
    expect(thisDevice(null)).toBeNull()
  })
})
