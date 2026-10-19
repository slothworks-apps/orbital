import { describe, it, expect } from 'vitest'
import type { ApiSession } from '../lib/types'
import { moveFor, sectionOf } from '../lib/sessionMoves'
import { partitionSessions } from '../lib/sidebarOrder'

type Fields = Pick<ApiSession, 'status' | 'source' | 'pinnedAt' | 'dockedAt'>
const at = (fields: Partial<Fields>): Fields => ({ status: 'idle', source: 'web', pinnedAt: null, dockedAt: null, ...fields })

// Spec 2026-10-19-docked-sessions-design § Moves.
describe('sectionOf', () => {
  it('puts a pin first, then a dock, then the end', () => {
    expect(sectionOf(at({ pinnedAt: 1, status: 'ended' }))).toBe('pinned')
    expect(sectionOf(at({ dockedAt: 1, status: 'working' }))).toBe('docked')
    expect(sectionOf(at({ status: 'ended' }))).toBe('history')
    expect(sectionOf(at({ status: 'needs_input' }))).toBe('active')
  })
})

describe('moveFor', () => {
  it('means nothing within a section', () => {
    expect(moveFor(at({}), 'active')).toBeNull()
    expect(moveFor(at({ dockedAt: 1 }), 'docked')).toBeNull()
  })

  it('moves between pinned, active and docked both ways', () => {
    for (const [from, to] of [
      [at({}), 'docked'], [at({}), 'pinned'], [at({ pinnedAt: 1 }), 'active'], [at({ pinnedAt: 1 }), 'docked'],
      [at({ dockedAt: 1 }), 'active'], [at({ dockedAt: 1 }), 'pinned'],
      [at({ status: 'ended' }), 'active'], [at({ status: 'ended' }), 'docked'], [at({ status: 'ended' }), 'pinned'],
    ] as const) {
      expect(moveFor(from, to)).toEqual({ kind: 'move', to })
    }
  })

  it('ends into history by the trash rules, and refuses what the trash refuses', () => {
    expect(moveFor(at({ dockedAt: 1 }), 'history')).toEqual({ kind: 'end', drop: 'end' })
    expect(moveFor(at({ status: 'working' }), 'history')).toEqual({ kind: 'end', drop: 'confirm' })
    expect(moveFor(at({ status: 'needs_input', pinnedAt: 1 }), 'history')).toEqual({ kind: 'end', drop: 'confirm' })
    expect(moveFor(at({ source: 'terminal' }), 'history')).toBeNull()
  })

  it('lets a pinned ended row go to history by its unpin, whatever drives it', () => {
    expect(moveFor(at({ status: 'ended', pinnedAt: 1, source: 'terminal' }), 'history')).toEqual({ kind: 'end', drop: 'end' })
  })

  it('docks only an Orbital session, on a Mac that knows docking', () => {
    expect(moveFor(at({ source: 'terminal' }), 'docked')).toBeNull()
    expect(moveFor({ ...at({}), dockedAt: undefined }, 'docked')).toBeNull()
  })

  it('only pins an ended terminal session, since nothing reopens it', () => {
    const over = at({ status: 'ended', source: 'terminal' })
    expect(moveFor(over, 'pinned')).toEqual({ kind: 'move', to: 'pinned' })
    expect(moveFor(over, 'active')).toBeNull()
    expect(moveFor(over, 'docked')).toBeNull()
  })
})

describe('partitionSessions with docked rows', () => {
  const session = (id: string, fields: Partial<ApiSession>) =>
    ({ id, cwd: '/w', title: id, firstAt: 1, lastAt: 1, messageCount: 1, source: 'web', permissionMode: null,
       model: null, resolvedModel: null, tagIds: [], status: 'idle', subagents: [], ...fields })

  it('takes docked rows out of active, in dock order', () => {
    const parts = partitionSessions(
      [session('a', {}), session('d2', { dockedAt: 9, status: 'working' }), session('d1', { dockedAt: 3 }),
       session('e', { status: 'ended' }), session('p', { pinnedAt: 1 })],
      'all',
    )
    expect(parts.pinned.map((s) => s.id)).toEqual(['p'])
    expect(parts.active.map((s) => s.id)).toEqual(['a'])
    expect(parts.docked.map((s) => s.id)).toEqual(['d1', 'd2'])
    expect(parts.history.map((s) => s.id)).toEqual(['e'])
  })
})
