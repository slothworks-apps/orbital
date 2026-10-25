import { describe, expect, it } from 'vitest'
import { contextMenuGroups, type ContextRow } from '../lib/sessionContextMenu'
import type { ApiSession } from '../lib/types'

type Shape = Pick<ApiSession, 'source' | 'status' | 'firstAt'>
const session = (patch: Partial<Shape> = {}): Shape => ({ source: 'web', status: 'idle', firstAt: 1, ...patch })

const actions = (groups: ContextRow[][]) => groups.map((group) => group.map((row) => row.action))
const online = { offline: false, detachable: true }

describe('contextMenuGroups', () => {
  it('gives an Orbital session every group, the openings first and the deliberate ones last', () => {
    expect(actions(contextMenuGroups(session(), online))).toEqual([
      ['open', 'detach'],
      ['rename', 'regenerate', 'tag', 'pin', 'copy-path'],
      ['clear', 'end'],
    ])
  })

  it('drops End once the session has ended, and keeps Clear', () => {
    expect(actions(contextMenuGroups(session({ status: 'ended' }), online))[2]).toEqual(['clear'])
  })

  it('never gives a terminal session Clear or End; a live one with a conversation gets Take over', () => {
    expect(actions(contextMenuGroups(session({ source: 'terminal', status: 'working' }), online))).toEqual([
      ['open', 'detach'],
      ['rename', 'regenerate', 'tag', 'pin', 'copy-path'],
      ['takeover'],
    ])
  })

  it('offers no Take over where the header offers none, and leaves the empty group out', () => {
    for (const patch of [{ firstAt: null }, { status: 'ended' as const }]) {
      const groups = actions(contextMenuGroups(session({ source: 'terminal', ...patch }), online))
      expect(groups).toHaveLength(2)
      expect(groups.flat()).not.toContain('takeover')
    }
  })

  it('leaves Open in new window out where it is not on offer', () => {
    expect(actions(contextMenuGroups(session(), { offline: false, detachable: false }))[0]).toEqual(['open'])
  })

  it('keeps the whole menu for an offline machine, with only Open and Copy path active', () => {
    const groups = contextMenuGroups(session(), { offline: true, detachable: true })
    expect(actions(groups).flat()).toEqual(actions(contextMenuGroups(session(), online)).flat())
    const active = groups.flat().filter((row) => !row.disabled).map((row) => row.action)
    expect(active).toEqual(['open', 'copy-path'])
  })

  it('makes nothing inert while the machine is online', () => {
    expect(contextMenuGroups(session(), online).flat().every((row) => !row.disabled)).toBe(true)
  })
})
