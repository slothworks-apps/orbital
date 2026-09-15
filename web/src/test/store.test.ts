import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  ApiSession,
  ChatMessage,
  Subagent,
  Tag,
  TagRule,
} from '../lib/types'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ApiError: actual.ApiError,
    api: {
      listSessions: vi.fn(),
      getSession: vi.fn(),
      getMessages: vi.fn(),
      sendMessage: vi.fn(),
      listTags: vi.fn(),
      listTagRules: vi.fn(),
      getSettings: vi.fn(),
      createSession: vi.fn(),
      interrupt: vi.fn(),
      clearSession: vi.fn(),
      renameSession: vi.fn(),
      setSessionTags: vi.fn(),
      createTag: vi.fn(),
      patchTag: vi.fn(),
      deleteTag: vi.fn(),
      createTagRule: vi.fn(),
      patchTagRule: vi.fn(),
      deleteTagRule: vi.fn(),
      previewRule: vi.fn(),
      listProjects: vi.fn(),
      patchSettings: vi.fn(),
    } satisfies Record<keyof typeof actual.api, unknown>,
  }
})

import { api, ApiError } from '../lib/api'
import {
  useOrbital,
  visibleSessions,
  statusCounts,
  type OrbitalState,
} from '../store/store'

function makeSession(overrides: Partial<ApiSession> & { id: string }): ApiSession {
  return {
    cwd: '/home/a',
    title: 'Session',
    firstAt: 1,
    lastAt: 100,
    messageCount: 1,
    source: 'web',
    permissionMode: null,
    parentId: null,
    tagIds: [],
    status: 'idle',
    ...overrides,
  }
}

const initialSnapshot: OrbitalState = {
  sessions: {},
  order: [],
  tags: [],
  rules: [],
  settings: {},
  transcripts: {},
  subagents: {},
  usage: {},
  historyLoaded: {},
  transcriptErrors: {},
  toast: null,
  ui: {
    selectedId: null,
    filterTagId: 'all',
    search: '',
    sourceFilter: 'all',
    wsStatus: 'connecting',
    dialog: null,
    sidebarCollapsed: false,
  },
}

beforeEach(() => {
  useOrbital.setState(structuredClone(initialSnapshot))
  vi.clearAllMocks()
})

describe('loadInitial', () => {
  it('fetches sessions/tags/rules/settings and populates state, order sorted by lastAt desc', async () => {
    const sessions = [
      makeSession({ id: 's1', lastAt: 100 }),
      makeSession({ id: 's2', lastAt: 300 }),
    ]
    const tags: Tag[] = [{ id: 1, name: 'important', hue: 0, is_default: 1 }]
    const rules: TagRule[] = [
      { id: 1, tag_id: 1, position: 0, enabled: 1, condition: 'path_matches', pattern: '/x' },
    ]
    const settings = { theme: 'dark' }

    vi.mocked(api.listSessions).mockResolvedValueOnce(sessions)
    vi.mocked(api.listTags).mockResolvedValueOnce(tags)
    vi.mocked(api.listTagRules).mockResolvedValueOnce(rules)
    vi.mocked(api.getSettings).mockResolvedValueOnce(settings)

    await useOrbital.getState().loadInitial()

    const state = useOrbital.getState()
    expect(state.sessions.s1).toEqual(sessions[0])
    expect(state.sessions.s2).toEqual(sessions[1])
    expect(state.order).toEqual(['s2', 's1'])
    expect(state.tags).toEqual(tags)
    expect(state.rules).toEqual(rules)
    expect(state.settings).toEqual(settings)
  })
})

describe('applySessionsEvent', () => {
  it('upsert adds/updates a session and keeps order sorted by lastAt desc', () => {
    const s1 = makeSession({ id: 's1', lastAt: 100 })
    const s2 = makeSession({ id: 's2', lastAt: 200 })
    useOrbital.getState().applySessionsEvent({ event: 'upsert', session: s1 })
    useOrbital.getState().applySessionsEvent({ event: 'upsert', session: s2 })
    expect(useOrbital.getState().order).toEqual(['s2', 's1'])

    const s1Updated = makeSession({ id: 's1', lastAt: 300 })
    useOrbital.getState().applySessionsEvent({ event: 'upsert', session: s1Updated })
    expect(useOrbital.getState().order).toEqual(['s1', 's2'])
    expect(useOrbital.getState().sessions.s1.lastAt).toBe(300)
  })

  it('status merges into an existing row', () => {
    const s1 = makeSession({ id: 's1', status: 'idle' })
    useOrbital.getState().applySessionsEvent({ event: 'upsert', session: s1 })
    useOrbital.getState().applySessionsEvent({ event: 'status', sessionId: 's1', status: 'working' })
    expect(useOrbital.getState().sessions.s1.status).toBe('working')
  })

  it('status for an unknown id triggers a refetch and upserts the result', async () => {
    const fetched = makeSession({ id: 'unknown', status: 'working', lastAt: 999 })
    vi.mocked(api.getSession).mockResolvedValueOnce({ session: fetched, lineage: [] })

    useOrbital.getState().applySessionsEvent({ event: 'status', sessionId: 'unknown', status: 'working' })

    expect(api.getSession).toHaveBeenCalledWith('unknown')

    await vi.waitFor(() => {
      expect(useOrbital.getState().sessions.unknown).toEqual(fetched)
    })
    expect(useOrbital.getState().order).toContain('unknown')
  })

  it('remove deletes the session and its order entry', () => {
    const s1 = makeSession({ id: 's1' })
    useOrbital.getState().applySessionsEvent({ event: 'upsert', session: s1 })
    useOrbital.getState().applySessionsEvent({ event: 'remove', sessionId: 's1' })
    expect(useOrbital.getState().sessions.s1).toBeUndefined()
    expect(useOrbital.getState().order).not.toContain('s1')
  })
})

describe('applySessionEvent', () => {
  it('message appends new messages and dedupes by id (WS replay safe)', () => {
    const m1: ChatMessage = { id: 'm1', role: 'user', text: 'hi' }
    const m2: ChatMessage = { id: 'm2', role: 'assistant', text: 'hello' }
    useOrbital.getState().applySessionEvent('s1', { event: 'message', message: m1 })
    useOrbital.getState().applySessionEvent('s1', { event: 'message', message: m2 })
    // Replay of an already-seen message (e.g. reconnect resync) must not duplicate.
    useOrbital.getState().applySessionEvent('s1', { event: 'message', message: m1 })

    expect(useOrbital.getState().transcripts.s1).toEqual([m1, m2])
  })

  it('status merges into an existing session row', () => {
    const session = makeSession({ id: 's1', status: 'working' })
    useOrbital.setState({ sessions: { s1: session } })
    useOrbital.getState().applySessionEvent('s1', { event: 'status', status: 'needs_input' })
    expect(useOrbital.getState().sessions.s1.status).toBe('needs_input')
  })

  it('status is a no-op for an unknown session id', () => {
    useOrbital.getState().applySessionEvent('unknown', { event: 'status', status: 'ended' })
    expect(useOrbital.getState().sessions.unknown).toBeUndefined()
  })

  it('subagent upserts by id', () => {
    const sub1: Subagent = { id: 'a1', name: 'sub-a', state: 'working' }
    useOrbital.getState().applySessionEvent('s1', { event: 'subagent', subagent: sub1 })
    expect(useOrbital.getState().subagents.s1).toEqual([sub1])

    const sub1Updated: Subagent = { id: 'a1', name: 'sub-a', state: 'idle' }
    useOrbital.getState().applySessionEvent('s1', { event: 'subagent', subagent: sub1Updated })
    expect(useOrbital.getState().subagents.s1).toEqual([sub1Updated])

    const sub2: Subagent = { id: 'a2', name: 'sub-b', state: 'working' }
    useOrbital.getState().applySessionEvent('s1', { event: 'subagent', subagent: sub2 })
    expect(useOrbital.getState().subagents.s1).toEqual([sub1Updated, sub2])
  })

  it('turn_result stores usage keyed by session id', () => {
    useOrbital.getState().applySessionEvent('s1', { event: 'turn_result', usage: { inputTokens: 10 } })
    expect(useOrbital.getState().usage.s1).toEqual({ inputTokens: 10 })
  })

  // Task 14 error state: a session that goes `working` -> `ended` without an
  // intervening `turn_result` is flagged as an SDK process crash (spec §
  // Error states) so `Transcript` can render an error row. Distinct session
  // ids per test below, deliberately — the `working`/`turn_result` tracking
  // this feeds off is non-reactive module state in store.ts (`turnResultSeen`),
  // not reset by this file's `beforeEach`, so reusing an id already touched
  // by an earlier test (e.g. 's1') would make these order-dependent.
  it('flags transcriptErrors when status goes working -> ended with no turn_result in between', () => {
    useOrbital.setState({ sessions: { crash1: makeSession({ id: 'crash1', status: 'idle' }) } })
    useOrbital.getState().applySessionEvent('crash1', { event: 'status', status: 'working' })
    useOrbital.getState().applySessionEvent('crash1', { event: 'status', status: 'ended' })
    expect(useOrbital.getState().transcriptErrors.crash1).toBe(true)
    expect(useOrbital.getState().sessions.crash1.status).toBe('ended')
  })

  it('does not flag transcriptErrors when a turn_result lands before ended', () => {
    useOrbital.setState({ sessions: { ok1: makeSession({ id: 'ok1', status: 'idle' }) } })
    useOrbital.getState().applySessionEvent('ok1', { event: 'status', status: 'working' })
    useOrbital.getState().applySessionEvent('ok1', { event: 'turn_result', usage: {} })
    useOrbital.getState().applySessionEvent('ok1', { event: 'status', status: 'ended' })
    expect(useOrbital.getState().transcriptErrors.ok1).toBeUndefined()
  })

  it('does not flag transcriptErrors for an ended transition that did not come from working', () => {
    useOrbital.setState({ sessions: { idle1: makeSession({ id: 'idle1', status: 'idle' }) } })
    useOrbital.getState().applySessionEvent('idle1', { event: 'status', status: 'ended' })
    expect(useOrbital.getState().transcriptErrors.idle1).toBeUndefined()
  })
})

describe('select', () => {
  it('prepends fetched history and dedupes against already WS-appended messages', async () => {
    const liveMsg: ChatMessage = { id: 'm3', role: 'assistant', text: 'live' }
    // Simulate a message arriving over the WS before the historical fetch resolves.
    useOrbital.getState().applySessionEvent('s1', { event: 'message', message: liveMsg })

    const historical: ChatMessage[] = [
      { id: 'm1', role: 'user', text: 'first' },
      { id: 'm2', role: 'assistant', text: 'second' },
      liveMsg, // overlaps with the message already delivered via WS
    ]
    vi.mocked(api.getMessages).mockResolvedValueOnce(historical)

    await useOrbital.getState().select('s1')

    expect(api.getMessages).toHaveBeenCalledWith('s1')
    expect(useOrbital.getState().transcripts.s1).toEqual([
      { id: 'm1', role: 'user', text: 'first' },
      { id: 'm2', role: 'assistant', text: 'second' },
      liveMsg,
    ])
    expect(useOrbital.getState().ui.selectedId).toBe('s1')
  })

  it('only fetches history once per session (lazy fill)', async () => {
    vi.mocked(api.getMessages).mockResolvedValue([{ id: 'm1', role: 'user', text: 'hi' }])
    await useOrbital.getState().select('s1')
    await useOrbital.getState().select('s1')
    expect(api.getMessages).toHaveBeenCalledTimes(1)
  })
})

describe('loadOlder', () => {
  it('fetches messages before the oldest currently held and prepends them, deduped by id', async () => {
    useOrbital.setState({
      transcripts: {
        s1: [
          { id: 'm5', role: 'user', text: 'fifth' },
          { id: 'm6', role: 'assistant', text: 'sixth' },
        ],
      },
    })
    const older: ChatMessage[] = [
      { id: 'm3', role: 'user', text: 'third' },
      { id: 'm4', role: 'assistant', text: 'fourth' },
      { id: 'm5', role: 'user', text: 'fifth' }, // overlaps with what's already there
    ]
    vi.mocked(api.getMessages).mockResolvedValueOnce(older)

    const fetched = await useOrbital.getState().loadOlder('s1')

    expect(api.getMessages).toHaveBeenCalledWith('s1', { before: 'm5' })
    expect(fetched).toEqual(older)
    expect(useOrbital.getState().transcripts.s1).toEqual([
      { id: 'm3', role: 'user', text: 'third' },
      { id: 'm4', role: 'assistant', text: 'fourth' },
      { id: 'm5', role: 'user', text: 'fifth' },
      { id: 'm6', role: 'assistant', text: 'sixth' },
    ])
  })

  it('resolves to an empty array without calling the API when there is no transcript yet', async () => {
    const fetched = await useOrbital.getState().loadOlder('s1')
    expect(fetched).toEqual([])
    expect(api.getMessages).not.toHaveBeenCalled()
  })

  it('resolves to an empty array (leaving the transcript untouched) when the fetch fails', async () => {
    useOrbital.setState({ transcripts: { s1: [{ id: 'm5', role: 'user', text: 'fifth' }] } })
    vi.mocked(api.getMessages).mockRejectedValueOnce(new Error('network error'))

    const fetched = await useOrbital.getState().loadOlder('s1')

    expect(fetched).toEqual([])
    expect(useOrbital.getState().transcripts.s1).toEqual([{ id: 'm5', role: 'user', text: 'fifth' }])
  })
})

describe('sendPrompt', () => {
  it('optimistically appends a user message with a local:-prefixed id and calls api.sendMessage', async () => {
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: true })

    await useOrbital.getState().sendPrompt('s1', 'hello world')

    const transcript = useOrbital.getState().transcripts.s1
    expect(transcript).toHaveLength(1)
    expect(transcript[0].id.startsWith('local:')).toBe(true)
    expect(transcript[0].role).toBe('user')
    expect(transcript[0].text).toBe('hello world')
    expect(api.sendMessage).toHaveBeenCalledWith('s1', 'hello world')
    expect(useOrbital.getState().toast).toBeNull()
  })

  it('generates non-colliding local ids across multiple calls', async () => {
    vi.mocked(api.sendMessage).mockResolvedValue({ ok: true })
    await useOrbital.getState().sendPrompt('s1', 'one')
    await useOrbital.getState().sendPrompt('s1', 'two')
    const ids = useOrbital.getState().transcripts.s1.map((m) => m.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('surfaces a toast error on ApiError 409 without throwing', async () => {
    vi.mocked(api.sendMessage).mockRejectedValueOnce(
      new ApiError('session is live in a terminal', 409)
    )

    await expect(useOrbital.getState().sendPrompt('s1', 'hello')).resolves.toBeUndefined()

    expect(useOrbital.getState().toast).toEqual({
      kind: 'error',
      message: 'session is live in a terminal',
    })
    // The optimistic message remains in the transcript despite the failed send.
    expect(useOrbital.getState().transcripts.s1).toHaveLength(1)
  })
})

describe('filter/search/dialog setters', () => {
  it('update ui state', () => {
    useOrbital.getState().setFilterTag(3)
    useOrbital.getState().setSearch('foo')
    useOrbital.getState().setSourceFilter('web')
    useOrbital.getState().setDialog('new')
    useOrbital.getState().setWsStatus('open')
    useOrbital.getState().setSidebarCollapsed(true)

    expect(useOrbital.getState().ui).toEqual({
      selectedId: null,
      filterTagId: 3,
      search: 'foo',
      sourceFilter: 'web',
      wsStatus: 'open',
      dialog: 'new',
      sidebarCollapsed: true,
    })
  })

  it('clearToast resets toast to null', () => {
    useOrbital.setState({ toast: { kind: 'error', message: 'x' } })
    useOrbital.getState().clearToast()
    expect(useOrbital.getState().toast).toBeNull()
  })
})

describe('visibleSessions (pure)', () => {
  const s1 = makeSession({ id: 's1', title: 'Alpha project', cwd: '/home/alpha', tagIds: [1], source: 'web', lastAt: 300 })
  const s2 = makeSession({ id: 's2', title: 'Beta project', cwd: '/home/beta', tagIds: [2], source: 'terminal', lastAt: 500 })
  const s3 = makeSession({ id: 's3', title: 'Gamma project', cwd: '/home/gamma', tagIds: [1], source: 'web', lastAt: 100 })

  it('orders all sessions by lastAt desc with no filters', () => {
    const state: OrbitalState = { ...initialSnapshot, sessions: { s1, s2, s3 } }
    expect(visibleSessions(state).map((s) => s.id)).toEqual(['s2', 's1', 's3'])
  })

  it('filters by tag id', () => {
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions: { s1, s2, s3 },
      ui: { ...initialSnapshot.ui, filterTagId: 1 },
    }
    expect(visibleSessions(state).map((s) => s.id)).toEqual(['s1', 's3'])
  })

  it('filters by search text against title or cwd, case-insensitive', () => {
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions: { s1, s2, s3 },
      ui: { ...initialSnapshot.ui, search: 'BETA' },
    }
    expect(visibleSessions(state).map((s) => s.id)).toEqual(['s2'])
  })

  it('filters by source', () => {
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions: { s1, s2, s3 },
      ui: { ...initialSnapshot.ui, sourceFilter: 'terminal' },
    }
    expect(visibleSessions(state).map((s) => s.id)).toEqual(['s2'])
  })

  it('combines tag, source and search filters', () => {
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions: { s1, s2, s3 },
      ui: { ...initialSnapshot.ui, filterTagId: 1, sourceFilter: 'web', search: 'gamma' },
    }
    expect(visibleSessions(state).map((s) => s.id)).toEqual(['s3'])
  })
})

describe('statusCounts (pure)', () => {
  it('counts sessions by status', () => {
    const sessions: Record<string, ApiSession> = {
      a: makeSession({ id: 'a', status: 'working' }),
      b: makeSession({ id: 'b', status: 'working' }),
      c: makeSession({ id: 'c', status: 'idle' }),
      d: makeSession({ id: 'd', status: 'needs_input' }),
      e: makeSession({ id: 'e', status: 'ended' }),
    }
    const state: OrbitalState = { ...initialSnapshot, sessions }
    expect(statusCounts(state)).toEqual({ working: 2, idle: 1, needs_input: 1, ended: 1 })
  })

  it('returns all-zero counts for an empty session set', () => {
    expect(statusCounts(initialSnapshot)).toEqual({
      working: 0,
      idle: 0,
      needs_input: 0,
      ended: 0,
    })
  })

  it('aggregates over visibleSessions, not the full session map — a tag filter excludes non-matching sessions', () => {
    const sessions: Record<string, ApiSession> = {
      a: makeSession({ id: 'a', status: 'working', tagIds: [1] }),
      b: makeSession({ id: 'b', status: 'working', tagIds: [2] }), // filtered out
      c: makeSession({ id: 'c', status: 'idle', tagIds: [1] }),
      d: makeSession({ id: 'd', status: 'needs_input', tagIds: [2] }), // filtered out
      e: makeSession({ id: 'e', status: 'ended', tagIds: [1] }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      ui: { ...initialSnapshot.ui, filterTagId: 1 },
    }
    // Only sessions a, c, e (tagIds includes 1) should be counted.
    expect(statusCounts(state)).toEqual({ working: 1, idle: 1, needs_input: 0, ended: 1 })
  })
})
