import { describe, expect, it } from 'vitest'
import { groupSharing, listSeparator, rowIsDeviceOnly, scopeOfKeys } from '../lib/settingsScope'
import type { GroupMember } from '../lib/types'

function member(patch: Partial<GroupMember> = {}): GroupMember {
  return {
    id: 'm', kind: 'desktop', name: 'mini', os: 'macos', links: true,
    addedAt: 0, addedVersion: 1, primary: false,
    self: false, linked: true, online: true, pairByHand: false, state: 'online', seenAt: null, tooOld: false,
    settingsSync: true,
    ...patch,
  }
}

const self = member({ id: 'self', name: 'studio', self: true })

describe('scopeOfKeys', () => {
  it('reads a section from the classification of the keys its rows edit', () => {
    expect(scopeOfKeys(['default_model', 'confirm_before_clear'])).toBe('shared')
    expect(scopeOfKeys(['default_project_dir', 'delete_sessions_older_than_days'])).toBe('device')
    expect(scopeOfKeys(['default_model', 'default_project_dir'])).toBe('mixed')
  })

  it('takes a key no list names as this device’s own', () => {
    expect(scopeOfKeys(['a_setting_from_a_later_release'])).toBe('device')
  })

  it('gives a section of read-only rows no scope', () => {
    expect(scopeOfKeys([])).toBeNull()
  })
})

describe('rowIsDeviceOnly', () => {
  it('marks a row only when none of its keys is shared', () => {
    expect(rowIsDeviceOnly(['default_project_dir'])).toBe(true)
    expect(rowIsDeviceOnly(['default_project_dir', 'default_model'])).toBe(false)
    expect(rowIsDeviceOnly([])).toBe(false)
  })
})

describe('groupSharing', () => {
  it('shows nothing alone, with phones only, or before the first status', () => {
    expect(groupSharing(undefined).shown).toBe(false)
    expect(groupSharing([self]).shown).toBe(false)
    expect(groupSharing([self, member({ id: 'p', kind: 'phone', settingsSync: undefined })]).shown).toBe(false)
  })

  it('names this device first, then every Mac and server that shares, never a phone', () => {
    const sharing = groupSharing([
      member({ id: 'gpu', name: 'gpu-01', kind: 'headless' }),
      member({ id: 'p', name: 'pixel', kind: 'phone', settingsSync: undefined }),
      self,
      member({ id: 'air', name: 'air' }),
    ])
    expect(sharing).toEqual({ shown: true, names: ['studio', 'gpu-01', 'air'], old: [] })
  })

  it('shows the marks with only old Macs, naming them apart', () => {
    const sharing = groupSharing([
      self,
      member({ id: 'old', name: 'old-mini', settingsSync: false }),
      member({ id: 'older', name: 'older-mini', tooOld: true, settingsSync: false }),
    ])
    expect(sharing).toEqual({
      shown: true,
      names: ['studio'],
      old: [{ id: 'old', name: 'old-mini' }, { id: 'older', name: 'older-mini' }],
    })
  })

  it('names a member not heard from yet rather than calling it old', () => {
    const sharing = groupSharing([self, member({ id: 'x', name: 'away', state: 'offline', settingsSync: null })])
    expect(sharing.names).toEqual(['studio', 'away'])
    expect(sharing.old).toEqual([])
  })

  it('counts a member too old for the group as old whatever its hello said', () => {
    const sharing = groupSharing([self, member({ id: 'x', name: 'gpu', tooOld: true, settingsSync: null })])
    expect(sharing.old).toEqual([{ id: 'x', name: 'gpu' }])
  })
})

describe('listSeparator', () => {
  it('reads "A, B and C"', () => {
    const names = ['A', 'B', 'C']
    expect(names.map((n, i) => listSeparator(i, names.length) + n).join('')).toBe('A, B and C')
    expect(['A', 'B'].map((n, i) => listSeparator(i, 2) + n).join('')).toBe('A and B')
  })
})
