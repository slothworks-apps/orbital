import { describe, expect, it } from 'vitest'
import { updateCheckLine, updateNoticeContent } from '../lib/appUpdate'
import type { UpdatePrompt, UpdateExtras } from '../lib/desktop'
import { channelStatusLine, stampOriginName, stillAhead, updateChannel } from '../lib/updateChannel'

// Canvas `Feature - Experimental updates`; spec 2026-11-02-experimental-release-channel-design.

describe('updateChannel', () => {
  it('is experimental only for the exact word', () => {
    expect(updateChannel({ update_channel: 'experimental' })).toBe('experimental')
    for (const value of [undefined, 'stable', 'Experimental', '']) expect(updateChannel({ update_channel: value })).toBe('stable')
  })
})

describe('stillAhead', () => {
  it('is ahead only of a known, lower regular release', () => {
    expect(stillAhead('0.37.0', '0.36.2')).toBe(true)
    expect(stillAhead('0.37.0', '0.37.0')).toBe(false)
    expect(stillAhead('0.37.0', '0.37.1')).toBe(false)
    // Compared by number, not as text.
    expect(stillAhead('0.10.0', '0.9.9')).toBe(true)
    expect(stillAhead('0.37.0', null)).toBe(false)
    expect(stillAhead('0.37.0', undefined)).toBe(false)
  })
})

describe('channelStatusLine', () => {
  const day = (at: number) => `day${at}`
  const base = { installed: '0.37.0', latestRegular: '0.36.2', day }

  it('on, says where and when it was turned on in a group, and since when alone', () => {
    const stamp = { at: 28, origin: 'studio' }
    expect(channelStatusLine({ ...base, on: true, inGroup: true, stamp, originName: 'studio-mbp' }))
      .toBe('on · turned on from studio-mbp, day28')
    expect(channelStatusLine({ ...base, on: true, inGroup: false, stamp, originName: 'studio-mbp' })).toBe('on since day28')
  })

  it('on, leaves out what is not known, and says nothing while the stamp is read', () => {
    expect(channelStatusLine({ ...base, on: true, inGroup: true, stamp: { at: null, origin: 'x' }, originName: 'nuc' }))
      .toBe('on · turned on from nuc')
    // A member no longer in the group: no name to give.
    expect(channelStatusLine({ ...base, on: true, inGroup: true, stamp: { at: 28, origin: 'gone' }, originName: null }))
      .toBe('on since day28')
    expect(channelStatusLine({ ...base, on: true, inGroup: false, stamp: null, originName: null })).toBe('on')
    expect(channelStatusLine({ ...base, on: true, inGroup: true, stamp: undefined, originName: null })).toBeNull()
  })

  it('off, names the version kept only while this Mac runs ahead of the regular release', () => {
    expect(channelStatusLine({ ...base, on: false, inGroup: true, stamp: null, originName: null }))
      .toBe('off · the group stays on 0.37.0 until the regular release reaches it')
    expect(channelStatusLine({ ...base, on: false, inGroup: false, stamp: null, originName: null }))
      .toBe('off · this Mac stays on 0.37.0 until the regular release reaches it')
    for (const latestRegular of ['0.37.0', '0.38.0', null]) {
      expect(channelStatusLine({ ...base, latestRegular, on: false, inGroup: true, stamp: null, originName: null })).toBeNull()
    }
  })
})

describe('stampOriginName', () => {
  const members = [{ id: 'a', name: 'air-m3', self: true }, { id: 'b', name: 'nuc' }]
  it('names this device for no origin or its own id, a member by id, and nobody it does not know', () => {
    expect(stampOriginName(null, members)).toBe('air-m3')
    expect(stampOriginName('a', members)).toBe('air-m3')
    expect(stampOriginName('b', members)).toBe('nuc')
    expect(stampOriginName('c', members)).toBeNull()
    expect(stampOriginName(null, [])).toBeNull()
  })
})

describe('the prompt while experimental is on', () => {
  const v = '0.37.1'
  const states: (UpdatePrompt & UpdateExtras)[] = [
    { phase: 'available', version: v, totalMB: 131 },
    { phase: 'downloading', version: v, percent: 40, totalMB: 131 },
    { phase: 'ready', version: v, workingCount: 2, buttons: 'two' },
    { phase: 'closed', version: v },
    { phase: 'downloading', version: v, percent: 40, totalMB: 131, remote: { by: 'Pixel 8', working: 1 } },
    { phase: 'waiting', version: v, workingCount: 1, remote: { by: 'Pixel 8', working: 1, wait: true } },
    { phase: 'restarting', version: v, remote: { by: 'Pixel 8', working: 0 } },
  ]

  it('names it after the version and before any state, and changes nothing else', () => {
    for (const state of states) {
      const off = updateNoticeContent(state)!
      const on = updateNoticeContent(state, { experimental: true })!
      expect(on.label, state.phase).toBe(off.label.replace(`ORBITAL ${v}`, `ORBITAL ${v} · EXPERIMENTAL`))
      expect({ ...on, label: '' }).toEqual({ ...off, label: '' })
    }
  })

  it('calls a build the check found an experimental release', () => {
    const line = updateCheckLine({
      checking: false, answer: null, prompt: { phase: 'available', version: v, totalMB: 1 }, checkedAt: 1, now: 2, experimental: true,
    })
    expect(line).toBe(`Orbital ${v} found, an experimental release · offered on the map`)
  })
})
