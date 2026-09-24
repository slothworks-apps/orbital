import { describe, it, expect } from 'vitest'
import type { ApiSession } from '../lib/types'
import type { OrbitalUiState } from '../store/store'
import { nextNeedingInput, sidebarOrder, stepSession } from '../lib/sidebarOrder'

function makeSession(overrides: Partial<ApiSession> & { id: string }): ApiSession {
  return {
    cwd: '/home/tomin/projects/orbital',
    title: 'Session',
    firstAt: 1,
    lastAt: 100,
    messageCount: 1,
    source: 'web',
    permissionMode: null,
    model: null,
    resolvedModel: null,
    parentId: null,
    mapDismissedAt: null,
    tagIds: [],
    status: 'idle',
    subagents: [],
    ...overrides,
  }
}

const ui: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  wsStatus: 'open',
  dialog: null,
  sidebarCollapsed: false,
  fileViewer: null,
}

function order(list: ApiSession[], over: Partial<OrbitalUiState> = {}): string[] {
  const sessions = Object.fromEntries(list.map((s) => [s.id, s]))
  return sidebarOrder({ sessions, ui: { ...ui, ...over } }).map((s) => s.id)
}

describe('sidebarOrder', () => {
  it('lists PINNED (pin order) before ACTIVE (newest first), and leaves HISTORY out', () => {
    expect(
      order([
        makeSession({ id: 'old', lastAt: 10 }),
        makeSession({ id: 'new', lastAt: 90 }),
        makeSession({ id: 'pin2', lastAt: 50, pinnedAt: 2 }),
        makeSession({ id: 'pin1', lastAt: 20, pinnedAt: 1 }),
        makeSession({ id: 'gone', lastAt: 99, status: 'ended' }),
      ]),
    ).toEqual(['pin1', 'pin2', 'new', 'old'])
  })

  it('keeps an ended session that is pinned — the sidebar draws it under PINNED', () => {
    expect(
      order([
        makeSession({ id: 'live', lastAt: 10 }),
        makeSession({ id: 'kept', status: 'ended', pinnedAt: 1 }),
      ]),
    ).toEqual(['kept', 'live'])
  })

  it('applies the search the sidebar applies', () => {
    expect(
      order(
        [
          makeSession({ id: 'a', title: 'Fix the map', lastAt: 2 }),
          makeSession({ id: 'b', title: 'Write docs', lastAt: 1 }),
        ],
        { search: 'MAP' },
      ),
    ).toEqual(['a'])
  })

  it('applies the tag filter', () => {
    expect(
      order(
        [
          makeSession({ id: 'a', tagIds: [1], lastAt: 2 }),
          makeSession({ id: 'b', tagIds: [2], lastAt: 1 }),
        ],
        { filterTagId: 2 },
      ),
    ).toEqual(['b'])
  })

  it('applies the origin filter to ACTIVE only, as the sidebar does', () => {
    expect(
      order(
        [
          makeSession({ id: 'term', source: 'terminal', lastAt: 3 }),
          makeSession({ id: 'web', source: 'web', lastAt: 2 }),
          makeSession({ id: 'pinnedTerm', source: 'terminal', pinnedAt: 1 }),
        ],
        { sourceFilter: 'web' },
      ),
    ).toEqual(['pinnedTerm', 'web'])
  })
})

const list = ['a', 'b', 'c'].map((id) => makeSession({ id }))

describe('stepSession', () => {
  it('moves forward and back, wrapping at both ends', () => {
    expect(stepSession(list, 'a', 1)).toBe('b')
    expect(stepSession(list, 'c', 1)).toBe('a')
    expect(stepSession(list, 'a', -1)).toBe('c')
  })

  it('starts from the first (next) or last (previous) with nothing selected, or a selection off the list', () => {
    expect(stepSession(list, null, 1)).toBe('a')
    expect(stepSession(list, null, -1)).toBe('c')
    expect(stepSession(list, 'history-row', 1)).toBe('a')
    expect(stepSession(list, 'history-row', -1)).toBe('c')
  })

  it('does nothing on a list of one or none', () => {
    expect(stepSession([makeSession({ id: 'a' })], 'a', 1)).toBeNull()
    expect(stepSession([makeSession({ id: 'a' })], null, 1)).toBeNull()
    expect(stepSession([], null, 1)).toBeNull()
  })
})

describe('nextNeedingInput', () => {
  const mixed = [
    makeSession({ id: 'a', status: 'needs_input' }),
    makeSession({ id: 'b', status: 'working' }),
    makeSession({ id: 'c', status: 'needs_input' }),
    makeSession({ id: 'd', status: 'idle' }),
  ]

  it('finds the first needs_input session after the selection, wrapping', () => {
    expect(nextNeedingInput(mixed, 'a')).toBe('c')
    expect(nextNeedingInput(mixed, 'c')).toBe('a')
    expect(nextNeedingInput(mixed, 'd')).toBe('a')
    expect(nextNeedingInput(mixed, null)).toBe('a')
  })

  it('skips the selection itself, and is null when nothing else needs input', () => {
    expect(nextNeedingInput([mixed[0], mixed[1]], 'a')).toBeNull()
    expect(nextNeedingInput([mixed[1], mixed[3]], null)).toBeNull()
  })
})
