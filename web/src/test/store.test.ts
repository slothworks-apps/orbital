import { describe, it, expect, beforeEach, vi } from 'vitest'
import type {
  ApiSession,
  ChatMessage,
  ErrorRecord,
  Subagent,
  Tag,
  TagRule,
} from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api, ApiError } from '../lib/api'
import {
  useOrbital,
  visibleSessions,
  mapSessions,
  statusCounts,
  recordedFailureFor,
  type OrbitalState,
} from '../store/store'

/** Fixed clock for the ended-age cutoff. Never Date.now() — these must be deterministic. */
const NOW = 1_800_000_000_000
const DAY = 86_400_000

function makeSession(overrides: Partial<ApiSession> & { id: string }): ApiSession {
  return {
    cwd: '/home/a',
    title: 'Session',
    firstAt: 1,
    lastAt: 100,
    messageCount: 1,
    source: 'web',
    permissionMode: null,
    model: null,
    resolvedModel: null,
    parentId: null,
    tagIds: [],
    status: 'idle',
    subagents: [],
    ...overrides,
  }
}

const initialSnapshot: OrbitalState = {
  sessions: {},
  order: [],
  tags: [],
  rules: [],
  models: [],
  settings: {},
  transcripts: {},
  usage: {},
  historyLoaded: {},
  transcriptErrors: {},
  lastTurnResultAt: {},
  errors: [],
  errorsUnseen: 0,
  toast: null,
  ui: {
    selectedId: null,
    filterTagId: 'all',
    search: '',
    sourceFilter: 'all',
    hideEnded: false,
    wsStatus: 'connecting',
    dialog: null,
    sidebarCollapsed: false,
  },
}

beforeEach(() => {
  useOrbital.setState(structuredClone(initialSnapshot))
  vi.clearAllMocks()
  // Persistent defaults so a test that only cares about one field of
  // loadInitial's Promise.all (e.g. the model-catalog test below) doesn't
  // have to also stub out the other three calls just to keep it iterable.
  vi.mocked(api.listSessions).mockResolvedValue([])
  vi.mocked(api.listTags).mockResolvedValue([])
  vi.mocked(api.listTagRules).mockResolvedValue([])
  vi.mocked(api.getSettings).mockResolvedValue({})
  vi.mocked(api.listModels).mockResolvedValue([])
  vi.mocked(api.listErrors).mockResolvedValue({ errors: [], unseen: 0 })
  // Every ENDED toggle saves; tests that care about the save assert on it,
  // the rest just need it not to reject.
  vi.mocked(api.patchSettings).mockResolvedValue({ ok: true })
})

function makeError(overrides: Partial<ErrorRecord> & { id: number }): ErrorRecord {
  return {
    at: 1_700_000_000_000,
    source: 'server',
    kind: 'session_failed',
    sessionId: null,
    message: 'spawn claude ENOENT',
    detail: null,
    context: null,
    seenAt: null,
    ...overrides,
  }
}

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

  it('loads the model catalog', async () => {
    vi.mocked(api.listModels).mockResolvedValue([
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', shortVersion: 'Sonnet 5', variant: null, blurb: 'Efficient', contextWindow: 200_000 },
    ])
    await useOrbital.getState().loadInitial()
    expect(useOrbital.getState().models).toHaveLength(1)
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

  it('replaces the pending optimistic user bubble with the server echo instead of duplicating it (F3)', async () => {
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: true })

    await useOrbital.getState().sendPrompt('s1', 'hello world')
    const localId = useOrbital.getState().transcripts.s1[0].id
    expect(localId.startsWith('local:')).toBe(true)

    const serverEcho: ChatMessage = {
      id: 'server-msg-1',
      role: 'user',
      text: 'hello world',
      timestamp: new Date().toISOString(),
    }
    useOrbital.getState().applySessionEvent('s1', { event: 'message', message: serverEcho })

    const transcript = useOrbital.getState().transcripts.s1
    expect(transcript).toHaveLength(1)
    expect(transcript[0]).toEqual(serverEcho)
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

  it('carries running subagents on the session itself, for any session and without selecting it', () => {
    const sub1: Subagent = { id: 'a1', name: 'sub-a', state: 'working' }
    const s1 = makeSession({ id: 's1', subagents: [sub1] })
    useOrbital.getState().applySessionsEvent({ event: 'upsert', session: s1 })
    expect(useOrbital.getState().sessions.s1.subagents).toEqual([sub1])

    // The server republishes the whole session when its set changes, so the
    // store never merges subagent-by-subagent — the newest upsert is the truth.
    const sub2: Subagent = { id: 'a2', name: 'sub-b', state: 'working' }
    useOrbital.getState().applySessionsEvent({
      event: 'upsert', session: { ...s1, subagents: [sub2] },
    })
    expect(useOrbital.getState().sessions.s1.subagents).toEqual([sub2])

    useOrbital.getState().applySessionsEvent({
      event: 'upsert', session: { ...s1, subagents: [] },
    })
    expect(useOrbital.getState().sessions.s1.subagents).toEqual([])
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

  // The third state of `turnResultSeen`: no entry at all. A session that was
  // already `working` when `loadInitial()` ran never produced a `working`
  // event here, so this tab never watched its turn start and knows nothing
  // about whether it resolved. That absence is ignorance, not evidence, and
  // must not be read as "no turn_result" — see the fix
  // `a-session-already-working-at-mount-reads-as-crashed`.
  it('does not flag transcriptErrors for a session that was already working at mount', () => {
    useOrbital.setState({
      sessions: { mounted1: makeSession({ id: 'mounted1', status: 'working' }) },
    })
    // No `working` event first: that transition happened before this tab
    // subscribed to the session's topic.
    useOrbital.getState().applySessionEvent('mounted1', { event: 'status', status: 'ended' })
    expect(useOrbital.getState().transcriptErrors.mounted1).toBeUndefined()
    expect(useOrbital.getState().sessions.mounted1.status).toBe('ended')
  })

  it('clears a crash flag once the session is revived and completes a turn, and a later graceful end keeps it cleared', () => {
    useOrbital.setState({ sessions: { revived1: makeSession({ id: 'revived1', status: 'idle' }) } })

    // Crashes once: working -> ended with no turn_result in between.
    useOrbital.getState().applySessionEvent('revived1', { event: 'status', status: 'working' })
    useOrbital.getState().applySessionEvent('revived1', { event: 'status', status: 'ended' })
    expect(useOrbital.getState().transcriptErrors.revived1).toBe(true)

    // Revived and completes a turn normally.
    useOrbital.getState().applySessionEvent('revived1', { event: 'status', status: 'working' })
    useOrbital.getState().applySessionEvent('revived1', { event: 'turn_result', usage: {} })
    expect(useOrbital.getState().transcriptErrors.revived1).toBe(false)

    // A subsequent graceful end (turn_result already seen) must not
    // re-flag it.
    useOrbital.getState().applySessionEvent('revived1', { event: 'status', status: 'ended' })
    expect(useOrbital.getState().transcriptErrors.revived1).toBe(false)
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

// ---------------------------------------------------------------------------
// The shared error log
// (`docs/superpowers/specs/2026-09-17-error-surface-design.md`).
// ---------------------------------------------------------------------------

describe('the error log', () => {
  it('loads the newest page in loadInitial and takes the unseen count from the server, not from the page', async () => {
    vi.mocked(api.listErrors).mockResolvedValueOnce({
      errors: [makeError({ id: 9 }), makeError({ id: 8 })],
      // The whole point: the client holds two rows and 200 are unread.
      unseen: 200,
    })

    await useOrbital.getState().loadInitial()

    expect(api.listErrors).toHaveBeenCalledWith({ limit: 50 })
    expect(useOrbital.getState().errors.map((e) => e.id)).toEqual([9, 8])
    expect(useOrbital.getState().errorsUnseen).toBe(200)
  })

  it('leaves the log empty rather than failing the whole mount when listErrors rejects', async () => {
    vi.mocked(api.listErrors).mockRejectedValueOnce(new Error('offline'))

    await expect(useOrbital.getState().loadInitial()).resolves.toBeUndefined()

    expect(useOrbital.getState().errors).toEqual([])
  })

  it('prepends a WS record and follows the server count rather than the array length', () => {
    useOrbital.setState({ errors: [makeError({ id: 1 })], errorsUnseen: 1 })

    useOrbital.getState().applyErrorsEvent({
      event: 'error',
      error: makeError({ id: 2, message: 'boom' }),
      unseen: 143,
    })

    const state = useOrbital.getState()
    expect(state.errors.map((e) => e.id)).toEqual([2, 1])
    expect(state.errorsUnseen).toBe(143)
  })

  it('raises the toast on an arriving record', () => {
    useOrbital.getState().applyErrorsEvent({
      event: 'error',
      error: makeError({ id: 3, message: 'spawn claude ENOENT' }),
      unseen: 1,
    })

    expect(useOrbital.getState().toast).toEqual({
      kind: 'error',
      message: 'spawn claude ENOENT',
    })
  })

  it('replaces rather than duplicates a record it already holds (a replay after reconnect)', () => {
    useOrbital.setState({ errors: [makeError({ id: 4, message: 'old' })], errorsUnseen: 1 })

    useOrbital
      .getState()
      .applyErrorsEvent({ event: 'error', error: makeError({ id: 4, message: 'new' }), unseen: 1 })

    expect(useOrbital.getState().errors).toHaveLength(1)
    expect(useOrbital.getState().errors[0].message).toBe('new')
  })

  it('stamps the ids a seen event names, and every row when it names null', () => {
    useOrbital.setState({
      errors: [makeError({ id: 2 }), makeError({ id: 1 })],
      errorsUnseen: 2,
    })

    useOrbital.getState().applyErrorsEvent({ event: 'seen', ids: [2], unseen: 1 })
    expect(useOrbital.getState().errors.map((e) => e.seenAt === null)).toEqual([false, true])
    expect(useOrbital.getState().errorsUnseen).toBe(1)

    useOrbital.getState().applyErrorsEvent({ event: 'seen', ids: null, unseen: 0 })
    expect(useOrbital.getState().errors.every((e) => e.seenAt !== null)).toBe(true)
    expect(useOrbital.getState().errorsUnseen).toBe(0)
  })

  it('keeps an already-stamped row on its original moment', () => {
    useOrbital.setState({ errors: [makeError({ id: 1, seenAt: 42 })], errorsUnseen: 0 })

    useOrbital.getState().applyErrorsEvent({ event: 'seen', ids: null, unseen: 0 })

    expect(useOrbital.getState().errors[0].seenAt).toBe(42)
  })

  it('empties the log on a cleared event', () => {
    useOrbital.setState({ errors: [makeError({ id: 1 })], errorsUnseen: 3 })

    useOrbital.getState().applyErrorsEvent({ event: 'cleared', unseen: 0 })

    expect(useOrbital.getState().errors).toEqual([])
    expect(useOrbital.getState().errorsUnseen).toBe(0)
  })

  it('markErrorsSeen posts the ids and takes the new count from the response', async () => {
    vi.mocked(api.markErrorsSeen).mockResolvedValueOnce({ ok: true, unseen: 5 })
    useOrbital.setState({ errors: [makeError({ id: 7 })], errorsUnseen: 6 })

    await useOrbital.getState().markErrorsSeen([7])

    expect(api.markErrorsSeen).toHaveBeenCalledWith([7])
    expect(useOrbital.getState().errors[0].seenAt).not.toBeNull()
    expect(useOrbital.getState().errorsUnseen).toBe(5)
  })

  it('markErrorsSeen does not call the API for an empty id list', async () => {
    await useOrbital.getState().markErrorsSeen([])
    expect(api.markErrorsSeen).not.toHaveBeenCalled()
  })

  it('clearErrorLog empties the slice after the DELETE resolves', async () => {
    vi.mocked(api.clearErrors).mockResolvedValueOnce({ ok: true, unseen: 0 })
    useOrbital.setState({ errors: [makeError({ id: 1 })], errorsUnseen: 1 })

    await useOrbital.getState().clearErrorLog()

    expect(api.clearErrors).toHaveBeenCalled()
    expect(useOrbital.getState().errors).toEqual([])
    expect(useOrbital.getState().errorsUnseen).toBe(0)
  })
})

describe('filter/search/dialog setters', () => {
  it('update ui state', () => {
    useOrbital.getState().setFilterTag(3)
    useOrbital.getState().setSearch('foo')
    useOrbital.getState().setSourceFilter('web')
    useOrbital.getState().setHideEnded(true)
    useOrbital.getState().setDialog('new')
    useOrbital.getState().setWsStatus('open')
    useOrbital.getState().setSidebarCollapsed(true)

    expect(useOrbital.getState().ui).toEqual({
      selectedId: null,
      filterTagId: 3,
      search: 'foo',
      sourceFilter: 'web',
      hideEnded: true,
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

  // The origin filter deliberately does NOT live here: HISTORY derives from
  // this selector and is not origin-scoped. See the ADR
  // `origin-filter-scopes-to-map-and-active`.
  it('ignores the origin filter', () => {
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions: { s1, s2, s3 },
      ui: { ...initialSnapshot.ui, sourceFilter: 'terminal' },
    }
    expect(visibleSessions(state).map((s) => s.id)).toEqual(['s2', 's1', 's3'])
  })

  it('combines tag and search filters', () => {
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions: { s1, s2, s3 },
      ui: { ...initialSnapshot.ui, filterTagId: 1, search: 'gamma' },
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
    // "never" keeps the age cutoff out of a test about counting by status —
    // these fixtures carry a 1970 `lastAt`.
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      settings: { map_ended_max_age_days: 'never' },
    }
    expect(statusCounts(state, NOW)).toEqual({ working: 2, idle: 1, needs_input: 1, ended: 1 })
  })

  it('returns all-zero counts for an empty session set', () => {
    expect(statusCounts(initialSnapshot, NOW)).toEqual({
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
      settings: { map_ended_max_age_days: 'never' },
      ui: { ...initialSnapshot.ui, filterTagId: 1 },
    }
    // Only sessions a, c, e (tagIds includes 1) should be counted.
    expect(statusCounts(state, NOW)).toEqual({ working: 1, idle: 1, needs_input: 0, ended: 1 })
  })
})

describe('mapSessions (pure)', () => {
  it('drops ended sessions past the age cutoff and keeps the ones inside it', () => {
    const sessions: Record<string, ApiSession> = {
      fresh: makeSession({ id: 'fresh', status: 'ended', lastAt: NOW - 2 * 3_600_000 }),
      stale: makeSession({ id: 'stale', status: 'ended', lastAt: NOW - 3 * DAY }),
    }
    const state: OrbitalState = { ...initialSnapshot, sessions }
    expect(mapSessions(state, NOW).map((s) => s.id)).toEqual(['fresh'])
  })

  it('never drops a live session, however old its last message is', () => {
    const sessions: Record<string, ApiSession> = {
      w: makeSession({ id: 'w', status: 'working', lastAt: NOW - 90 * DAY }),
      i: makeSession({ id: 'i', status: 'idle', lastAt: NOW - 90 * DAY }),
      n: makeSession({ id: 'n', status: 'needs_input', lastAt: NOW - 90 * DAY }),
    }
    const state: OrbitalState = { ...initialSnapshot, sessions }
    expect(mapSessions(state, NOW).map((s) => s.id).sort()).toEqual(['i', 'n', 'w'])
  })

  it('treats an ended session with no lastAt as older than any cutoff', () => {
    const sessions: Record<string, ApiSession> = {
      nulled: makeSession({ id: 'nulled', status: 'ended', lastAt: null }),
    }
    const state: OrbitalState = { ...initialSnapshot, sessions }
    expect(mapSessions(state, NOW)).toEqual([])
  })

  it('applies no age cutoff at all under the "never" preset', () => {
    const sessions: Record<string, ApiSession> = {
      ancient: makeSession({ id: 'ancient', status: 'ended', lastAt: NOW - 400 * DAY }),
      nulled: makeSession({ id: 'nulled', status: 'ended', lastAt: null }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      settings: { map_ended_max_age_days: 'never' },
    }
    expect(mapSessions(state, NOW).map((s) => s.id).sort()).toEqual(['ancient', 'nulled'])
  })

  it('honours a configured cutoff other than the default', () => {
    const sessions: Record<string, ApiSession> = {
      d3: makeSession({ id: 'd3', status: 'ended', lastAt: NOW - 3 * DAY }),
      d10: makeSession({ id: 'd10', status: 'ended', lastAt: NOW - 10 * DAY }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      settings: { map_ended_max_age_days: '7' },
    }
    expect(mapSessions(state, NOW).map((s) => s.id)).toEqual(['d3'])
  })

  it('falls back to a one-day cutoff when the setting is absent', () => {
    const sessions: Record<string, ApiSession> = {
      inside: makeSession({ id: 'inside', status: 'ended', lastAt: NOW - 23 * 3_600_000 }),
      outside: makeSession({ id: 'outside', status: 'ended', lastAt: NOW - 25 * 3_600_000 }),
    }
    const state: OrbitalState = { ...initialSnapshot, sessions }
    expect(mapSessions(state, NOW).map((s) => s.id)).toEqual(['inside'])
  })

  // `hideEnded` is a render flag, not a filter: the planets must stay in the
  // model so `Planet` can fade them out (canvas 2a animates opacity/scale
  // rather than removing them), and so toggling never reflows the layout.
  it('ignores hideEnded — that is a render flag, not a filter', () => {
    const sessions: Record<string, ApiSession> = {
      e: makeSession({ id: 'e', status: 'ended', lastAt: NOW - 1_000 }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      ui: { ...initialSnapshot.ui, hideEnded: true },
    }
    expect(mapSessions(state, NOW).map((s) => s.id)).toEqual(['e'])
  })

  it('composes with the tag filter rather than replacing it', () => {
    const sessions: Record<string, ApiSession> = {
      keep: makeSession({ id: 'keep', status: 'idle', tagIds: [1] }),
      otherTag: makeSession({ id: 'otherTag', status: 'idle', tagIds: [2] }),
      staleSameTag: makeSession({
        id: 'staleSameTag',
        status: 'ended',
        tagIds: [1],
        lastAt: NOW - 30 * DAY,
      }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      ui: { ...initialSnapshot.ui, filterTagId: 1 },
    }
    expect(mapSessions(state, NOW).map((s) => s.id)).toEqual(['keep'])
  })

  // The origin filter is applied here rather than in `visibleSessions`, so
  // the map narrows with the ACTIVE list while HISTORY keeps every row.
  it('applies the origin filter to live sessions', () => {
    const sessions: Record<string, ApiSession> = {
      web: makeSession({ id: 'web', status: 'idle', source: 'web' }),
      term: makeSession({ id: 'term', status: 'idle', source: 'terminal' }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      ui: { ...initialSnapshot.ui, sourceFilter: 'terminal' },
    }
    expect(mapSessions(state, NOW).map((s) => s.id)).toEqual(['term'])
  })

  // The map filters everything it draws: a planet the filter excludes must
  // not survive just because the session behind it has ended.
  it('applies the origin filter to ended sessions inside the cutoff too', () => {
    const sessions: Record<string, ApiSession> = {
      webEnded: makeSession({
        id: 'webEnded',
        status: 'ended',
        source: 'web',
        lastAt: NOW - 1_000,
      }),
      termEnded: makeSession({
        id: 'termEnded',
        status: 'ended',
        source: 'terminal',
        lastAt: NOW - 1_000,
      }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      ui: { ...initialSnapshot.ui, sourceFilter: 'web' },
    }
    expect(mapSessions(state, NOW).map((s) => s.id)).toEqual(['webEnded'])
  })
})

describe('statusCounts and the ended cutoff', () => {
  it('counts ended sessions inside the cutoff only', () => {
    const sessions: Record<string, ApiSession> = {
      fresh: makeSession({ id: 'fresh', status: 'ended', lastAt: NOW - 1_000 }),
      stale: makeSession({ id: 'stale', status: 'ended', lastAt: NOW - 30 * DAY }),
      live: makeSession({ id: 'live', status: 'working' }),
    }
    const state: OrbitalState = { ...initialSnapshot, sessions }
    expect(statusCounts(state, NOW)).toEqual({ working: 1, idle: 0, needs_input: 0, ended: 1 })
  })

  // Canvas 2b: "the count reads as suppressed rather than zero. The ENDED
  // number keeps counting; it is what you click to bring them back."
  it('keeps counting ended sessions while hideEnded suppresses them', () => {
    const sessions: Record<string, ApiSession> = {
      a: makeSession({ id: 'a', status: 'ended', lastAt: NOW - 1_000 }),
      b: makeSession({ id: 'b', status: 'ended', lastAt: NOW - 2_000 }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      ui: { ...initialSnapshot.ui, hideEnded: true },
    }
    expect(statusCounts(state, NOW).ended).toBe(2)
  })
})

describe('setHideEnded', () => {
  it('toggles the map-only ended suppression', () => {
    expect(useOrbital.getState().ui.hideEnded).toBe(false)
    useOrbital.getState().setHideEnded(true)
    expect(useOrbital.getState().ui.hideEnded).toBe(true)
    useOrbital.getState().setHideEnded(false)
    expect(useOrbital.getState().ui.hideEnded).toBe(false)
  })

  // The toggle has to survive a reload — see `map_hide_ended`.
  it('saves the toggle, and flips the map before the save comes back', () => {
    let resolveSave = (_: { ok: boolean }) => {}
    vi.mocked(api.patchSettings).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve
      })
    )

    useOrbital.getState().setHideEnded(true)

    expect(useOrbital.getState().ui.hideEnded).toBe(true)
    expect(useOrbital.getState().settings.map_hide_ended).toBe('true')
    expect(api.patchSettings).toHaveBeenCalledWith({ map_hide_ended: 'true' })
    resolveSave({ ok: true })
  })

  it('does not save a toggle that changes nothing', () => {
    useOrbital.getState().setHideEnded(false)
    expect(api.patchSettings).not.toHaveBeenCalled()
  })

  it('puts the toggle back and reports when the save fails', async () => {
    vi.mocked(api.patchSettings).mockRejectedValue(new Error('settings server down'))

    useOrbital.getState().setHideEnded(true)
    await vi.waitFor(() => expect(useOrbital.getState().ui.hideEnded).toBe(false))

    expect(useOrbital.getState().settings.map_hide_ended).toBe('false')
    expect(useOrbital.getState().toast).toEqual({
      kind: 'error',
      message: 'settings server down',
    })
  })

  it('loadInitial seeds the toggle from the saved setting', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([])
    vi.mocked(api.listTags).mockResolvedValue([])
    vi.mocked(api.listTagRules).mockResolvedValue([])
    vi.mocked(api.getSettings).mockResolvedValue({ map_hide_ended: 'true' })

    await useOrbital.getState().loadInitial()

    expect(useOrbital.getState().ui.hideEnded).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Which recorded failure the transcript should still be wearing
// ---------------------------------------------------------------------------

describe('recordedFailureFor', () => {
  function record(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
    return {
      id: 1,
      at: 1_000,
      source: 'server',
      kind: 'session_failed',
      sessionId: 'a',
      message: 'spawn claude ENOENT',
      detail: null,
      context: null,
      seenAt: null,
      ...overrides,
    }
  }

  function state(overrides: Partial<OrbitalState> = {}): Pick<
    OrbitalState,
    'errors' | 'sessions' | 'lastTurnResultAt'
  > {
    return {
      errors: [record()],
      sessions: { a: makeSession({ id: 'a', lastAt: 500 }) },
      lastTurnResultAt: {},
      ...overrides,
    }
  }

  it('returns the session\'s recorded failure when it is the last thing that happened', () => {
    expect(recordedFailureFor(state(), 'a')?.message).toBe('spawn claude ENOENT')
  })

  it('returns nothing for a session with no recorded error', () => {
    expect(recordedFailureFor(state(), 'b')).toBeUndefined()
  })

  /**
   * The regression this function exists to prevent. `transcriptErrors` is
   * cleared by a `turn_result`; a database row is not, so without a gate a
   * session that crashed once would wear the crash forever — which is exactly
   * what the comment on that clearing warns about.
   */
  it('forgets the failure once this tab has watched a later turn complete', () => {
    const revived = state({ lastTurnResultAt: { a: 2_000 } })
    expect(recordedFailureFor(revived, 'a')).toBeUndefined()
  })

  it('keeps the failure when the last completed turn is older than it', () => {
    const crashedAfterAGoodTurn = state({ lastTurnResultAt: { a: 500 } })
    expect(recordedFailureFor(crashedAfterAGoodTurn, 'a')).toBeDefined()
  })

  /**
   * After a reload `lastTurnResultAt` is empty — this tab watched nothing —
   * so the session's own `lastAt` has to carry the same rule.
   */
  it('forgets the failure when the session has been active since, across a reload', () => {
    const activeSince = state({ sessions: { a: makeSession({ id: 'a', lastAt: 9_000 }) } })
    expect(recordedFailureFor(activeSince, 'a')).toBeUndefined()
  })

  it('keeps the failure when neither signal is present at all', () => {
    const noSignals = state({ sessions: {} })
    expect(recordedFailureFor(noSignals, 'a')).toBeDefined()
  })
})
