import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import type { ApiSession, PendingDecision, Tag } from '../lib/types'
import { configureTranscriptPages, useOrbital } from '../store/store'

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
    vi.mocked(api.listSessionPage).mockResolvedValue({ sessions: [session('a', 1)], ended: { count: 3, latestAt: 9 } })
    vi.mocked(api.listTags).mockResolvedValue(tags)
    vi.mocked(api.listModels).mockResolvedValue({ models: [], contextWindows: {} })
    await expect(useOrbital.getState().loadSessions()).resolves.toEqual({ count: 3, latestAt: 9 })
    expect(api.listSessionPage).toHaveBeenCalledTimes(1)
    expect(api.listSessionPage).toHaveBeenCalledWith({ ended: 'exclude' })
    expect(Object.keys(useOrbital.getState().sessions)).toEqual(['a'])
    expect(useOrbital.getState().tags).toEqual(tags)
    expect(api.getSettings).not.toHaveBeenCalled()
    expect(api.listTagRules).not.toHaveBeenCalled()
    expect(api.listErrors).not.toHaveBeenCalled()
  })

  it('seats the ENDED fold with the list once it has been opened, and a Mac that ignores the fold says nothing of it', async () => {
    vi.mocked(api.listSessionPage).mockImplementation(async (params) =>
      params?.ended === 'only'
        ? { sessions: [session('done', 1, { status: 'ended' })] }
        : { sessions: [session('live', 2), session('done', 1, { status: 'ended' })] },
    )
    vi.mocked(api.listTags).mockResolvedValue([])
    vi.mocked(api.listModels).mockResolvedValue({ models: [], contextWindows: {} })
    await expect(useOrbital.getState().loadSessions({ endedToo: true })).resolves.toBeNull()
    expect(useOrbital.getState().order).toEqual(['live', 'done'])
  })
})

describe('seatSessions and the open session', () => {
  afterEach(() => useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null } })))

  it('keeps the selected session the new list leaves out, and drops the rest', () => {
    useOrbital.getState().seatSessions([session('open', 1, { status: 'ended' }), session('other', 2, { status: 'ended' })], [])
    useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 'open' } }))
    useOrbital.getState().seatSessions([session('live', 3)], [])
    expect(Object.keys(useOrbital.getState().sessions).sort()).toEqual(['live', 'open'])
  })
})

describe('loadSessionHistory', () => {
  it('adds a session the store does not hold, as the detail carries it', async () => {
    useOrbital.getState().seatSessions([], [])
    const detail = session('gone', 1, { status: 'ended', subagents: [{ id: 'a', name: 'a', state: 'ended', startedAt: 0 }] })
    vi.mocked(api.getSession).mockResolvedValue({ session: detail })
    await useOrbital.getState().loadSessionHistory('gone')
    expect(useOrbital.getState().sessions.gone?.subagents).toEqual(detail.subagents)
  })
})

describe('configureTranscriptPages', () => {
  afterEach(() => configureTranscriptPages(undefined))

  it('asks for pages of the configured size, the first and the older ones', async () => {
    configureTranscriptPages(30)
    vi.mocked(api.getMessages).mockResolvedValue([{ id: 'm1', role: 'user', text: 'hi' }])
    useOrbital.setState({ transcripts: {}, historyLoaded: {}, detachedIds: [] })
    await useOrbital.getState().select('s1')
    expect(api.getMessages).toHaveBeenCalledWith('s1', { limit: 30 })
    await useOrbital.getState().loadOlder('s1')
    expect(api.getMessages).toHaveBeenLastCalledWith('s1', { before: 'm1', limit: 30 })
  })

  it("leaves the server's default alone when nothing is configured", async () => {
    vi.mocked(api.getMessages).mockResolvedValue([])
    await useOrbital.getState().select('s2')
    expect(api.getMessages).toHaveBeenCalledWith('s2')
  })
})
