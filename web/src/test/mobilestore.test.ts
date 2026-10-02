import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import type { ApiSession, PendingDecision, Tag } from '../lib/types'
import { useOrbital } from '../store/store'

function session(id: string, lastAt: number, patch: Partial<ApiSession> = {}): ApiSession {
  return {
    id, cwd: `/w/${id}`, title: id, firstAt: lastAt, lastAt, messageCount: 1, source: 'web', permissionMode: null,
    model: null, resolvedModel: null, tagIds: [], status: 'idle', subagents: [], ...patch,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('seatSessions', () => {
  it('replaces the session list, newest first, with the decisions it carries', () => {
    const decision: PendingDecision = { id: 'd1', kind: 'permission', input: {}, createdAt: 1 }
    useOrbital.getState().seatSessions(
      [session('old', 1), session('new', 2, { status: 'needs_input', pendingDecision: decision })],
      [],
    )
    expect(useOrbital.getState().order).toEqual(['new', 'old'])
    expect(useOrbital.getState().pendingDecisions).toEqual({ new: decision })
    useOrbital.getState().seatSessions([session('only', 3)], [])
    expect(Object.keys(useOrbital.getState().sessions)).toEqual(['only'])
    expect(useOrbital.getState().pendingDecisions).toEqual({})
  })
})

describe('loadSessions', () => {
  it('reads only routes the tunnel allows', async () => {
    const tags: Tag[] = [{ id: 1, name: 'orbital', hue: 200, is_default: 1 }]
    vi.mocked(api.listSessions).mockResolvedValue([session('a', 1)])
    vi.mocked(api.listTags).mockResolvedValue(tags)
    vi.mocked(api.listModels).mockResolvedValue({ models: [], contextWindows: {} })
    await useOrbital.getState().loadSessions()
    expect(Object.keys(useOrbital.getState().sessions)).toEqual(['a'])
    expect(useOrbital.getState().tags).toEqual(tags)
    expect(api.getSettings).not.toHaveBeenCalled()
    expect(api.listTagRules).not.toHaveBeenCalled()
    expect(api.listErrors).not.toHaveBeenCalled()
  })
})
