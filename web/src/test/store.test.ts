import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type {
  ApiSession,
  ChatMessage,
  ErrorRecord,
  PendingQuestionDecision,
  PendingVerdictDecision,
  Subagent,
  Tag,
  TagRule,
} from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api, ApiError } from '../lib/api'
import {
  useOrbital,
  visibleSessions,
  matchesSearch,
  mapSessions,
  statusCounts,
  recordedFailureFor,
  parsePlanetScale,
  parseDetailPanelWidth,
  parseSidebarWidth,
  parseContextThresholds,
  showContext,
  showCompactBadge,
  editDiffsExpanded,
  expandDiffOnPermission,
  guardGesture,
  headerSessionStats,
  mapStatePills,
  UNDO_TOAST_MS,
  absorptionFor,
  trashDropFor,
  MAP_LEAVE_GRACE_MS,
  resolvePanelPairWidths,
  resolveWindowPanelWidths,
  WINDOW_PANEL_PAIR_MIN_PX,
  DETAIL_PANEL_MIN_PX,
  PANEL_GUTTER_PX,
  SUBAGENT_PANEL_DEFAULT_PX,
  SUBAGENT_PANEL_MIN_PX,
  type OrbitalState,
  type SessionEvent,
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
  contextWindows: {},
  settings: {},
  transcripts: {},
  historyLoaded: {},
  transcriptErrors: {},
  lastTurnResultAt: {},
  statsRevision: {},
  errors: [],
  errorsUnseen: 0,
  remote: null,
  pendingDecisions: {},
  decisionAnswers: {},
  decisionVerdicts: {},
  ideDismissed: {},
  composerDrafts: {},
  rewindSending: {},
  detachedIds: [],
  sessionsTotal: 0,
  leavingSince: {},
  toast: null,
  subagentPanel: null,
  taskOutput: null,
  stoppingTasks: {},
  harnesses: {},
  harnessEvents: {},
  harnessEventsMore: {},
  harnessRemoved: {},
  harnessPanel: null,
  harnessTemplatesFocus: null,
  ui: {
    selectedId: null,
    filterTagId: 'all',
    search: '',
    sourceFilter: 'all',
    wsStatus: 'connecting',
    dialog: null,
    fileViewer: null,
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
  vi.mocked(api.listModels).mockResolvedValue({ models: [], contextWindows: {} })
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

  it('loads the model catalog and the learned context windows', async () => {
    vi.mocked(api.listModels).mockResolvedValue({
      models: [
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', shortVersion: 'Sonnet 5', variant: null, blurb: 'Efficient', contextWindow: 200_000 },
      ],
      contextWindows: { 'claude-fable-5': 1_000_000 },
    })
    await useOrbital.getState().loadInitial()
    expect(useOrbital.getState().models).toHaveLength(1)
    expect(useOrbital.getState().contextWindows).toEqual({ 'claude-fable-5': 1_000_000 })
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
    vi.mocked(api.getSession).mockResolvedValueOnce({ session: fetched })

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

// fix: a-reopened-session-shows-the-transcript-it-was-left-with
describe('queueSessionsEvent', () => {
  let frames: FrameRequestCallback[] = []
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  const runFrame = () => frames.splice(0).forEach((cb) => cb(0))

  it('lands two sessions frames of one tick as one store write, in order', () => {
    let writes = 0
    const unsubscribe = useOrbital.subscribe(() => { writes++ })
    useOrbital.getState().queueSessionsEvent({ event: 'upsert', session: makeSession({ id: 's1', status: 'idle' }) })
    useOrbital.getState().queueSessionsEvent({ event: 'status', sessionId: 's1', status: 'working' })
    expect(writes).toBe(0)

    runFrame()
    unsubscribe()

    expect(writes).toBe(1)
    expect(useOrbital.getState().sessions.s1.status).toBe('working')
  })

  it('catches up before a session-topic event, which reads the row the sessions topic brought', () => {
    useOrbital.getState().queueSessionsEvent({ event: 'upsert', session: makeSession({ id: 's1', status: 'idle' }) })
    useOrbital.getState().applySessionEvent('s1', { event: 'status', status: 'working' })

    expect(useOrbital.getState().sessions.s1.status).toBe('working')
    runFrame()
    expect(useOrbital.getState().sessions.s1.status).toBe('working')
  })

  it('catches up before a direct update, so an older queued upsert cannot overwrite it', () => {
    useOrbital.getState().queueSessionsEvent({ event: 'upsert', session: makeSession({ id: 's1', title: 'old' }) })
    useOrbital.getState().applySessionsEvent({ event: 'upsert', session: makeSession({ id: 's1', title: 'new' }) })
    runFrame()

    expect(useOrbital.getState().sessions.s1.title).toBe('new')
  })
})

describe('applySessionEvent', () => {
  it('message appends new messages and dedupes by id (WS replay safe)', () => {
    useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 's1' } }))
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
    const sub1: Subagent = { id: 'a1', name: 'sub-a', state: 'working', startedAt: 0 }
    const s1 = makeSession({ id: 's1', subagents: [sub1] })
    useOrbital.getState().applySessionsEvent({ event: 'upsert', session: s1 })
    expect(useOrbital.getState().sessions.s1.subagents).toEqual([sub1])

    // The server republishes the whole session when its set changes, so the
    // store never merges subagent-by-subagent — the newest upsert is the truth.
    const sub2: Subagent = { id: 'a2', name: 'sub-b', state: 'working', startedAt: 0 }
    useOrbital.getState().applySessionsEvent({
      event: 'upsert', session: { ...s1, subagents: [sub2] },
    })
    expect(useOrbital.getState().sessions.s1.subagents).toEqual([sub2])

    useOrbital.getState().applySessionsEvent({
      event: 'upsert', session: { ...s1, subagents: [] },
    })
    expect(useOrbital.getState().sessions.s1.subagents).toEqual([])
  })

  // Task 14 error state: a session that goes `working` -> `idle` without an
  // intervening `turn_result` is flagged as an SDK process crash (spec §
  // Error states) so `Transcript` can render an error row. `idle`, not
  // `ended`: a crash no longer ends a session, the process just goes away
  // (spec 2026-09-24-sessions-end-only-by-hand-design § 1). Distinct session
  // ids per test below, deliberately — the `working`/`turn_result` tracking
  // this feeds off is non-reactive module state in store.ts (`turnResultSeen`),
  // not reset by this file's `beforeEach`, so reusing an id already touched
  // by an earlier test (e.g. 's1') would make these order-dependent.
  it('flags transcriptErrors when status goes working -> idle with no turn_result in between', () => {
    useOrbital.setState({ sessions: { crash1: makeSession({ id: 'crash1', status: 'idle' }) } })
    useOrbital.getState().applySessionEvent('crash1', { event: 'status', status: 'working' })
    useOrbital.getState().applySessionEvent('crash1', { event: 'status', status: 'idle' })
    expect(useOrbital.getState().transcriptErrors.crash1).toBe(true)
    expect(useOrbital.getState().sessions.crash1.status).toBe('idle')
  })

  it('does not flag transcriptErrors when a turn_result lands before idle', () => {
    useOrbital.setState({ sessions: { ok1: makeSession({ id: 'ok1', status: 'idle' }) } })
    useOrbital.getState().applySessionEvent('ok1', { event: 'status', status: 'working' })
    useOrbital.getState().applySessionEvent('ok1', { event: 'turn_result', usage: {} })
    useOrbital.getState().applySessionEvent('ok1', { event: 'status', status: 'idle' })
    expect(useOrbital.getState().transcriptErrors.ok1).toBeUndefined()
  })

  // Only the user ends a session now, so `ended` mid-turn is their End.
  it('does not flag transcriptErrors when the user ends a session mid-turn', () => {
    useOrbital.setState({ sessions: { ended1: makeSession({ id: 'ended1', status: 'idle' }) } })
    useOrbital.getState().applySessionEvent('ended1', { event: 'status', status: 'working' })
    useOrbital.getState().applySessionEvent('ended1', { event: 'status', status: 'ended' })
    expect(useOrbital.getState().transcriptErrors.ended1).toBeUndefined()
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
    useOrbital.getState().applySessionEvent('mounted1', { event: 'status', status: 'idle' })
    expect(useOrbital.getState().transcriptErrors.mounted1).toBeUndefined()
    expect(useOrbital.getState().sessions.mounted1.status).toBe('idle')
  })

  it('clears a crash flag once the session is revived and completes a turn, and a later graceful idle keeps it cleared', () => {
    useOrbital.setState({ sessions: { revived1: makeSession({ id: 'revived1', status: 'idle' }) } })

    // Crashes once: working -> idle with no turn_result in between.
    useOrbital.getState().applySessionEvent('revived1', { event: 'status', status: 'working' })
    useOrbital.getState().applySessionEvent('revived1', { event: 'status', status: 'idle' })
    expect(useOrbital.getState().transcriptErrors.revived1).toBe(true)

    // Revived and completes a turn normally.
    useOrbital.getState().applySessionEvent('revived1', { event: 'status', status: 'working' })
    useOrbital.getState().applySessionEvent('revived1', { event: 'turn_result', usage: {} })
    expect(useOrbital.getState().transcriptErrors.revived1).toBe(false)

    // A subsequent graceful idle (turn_result already seen) must not
    // re-flag it.
    useOrbital.getState().applySessionEvent('revived1', { event: 'status', status: 'idle' })
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

// spec: 2026-09-23-detached-session-windows-design
describe('detached sessions', () => {
  const focusSession = vi.fn()

  beforeEach(() => {
    ;(window as { orbitalDesktop?: unknown }).orbitalDesktop = { focusSession }
  })

  afterEach(() => {
    delete (window as { orbitalDesktop?: unknown }).orbitalDesktop
  })

  it('select on a detached session focuses its window and selects nothing', async () => {
    useOrbital.getState().setDetached(['s1'])

    await useOrbital.getState().select('s1')

    expect(focusSession).toHaveBeenCalledWith('s1')
    expect(useOrbital.getState().ui.selectedId).toBeNull()
    expect(api.getMessages).not.toHaveBeenCalled()
  })

  it('select on a detached session leaves the current selection where it was', async () => {
    await useOrbital.getState().select('s2')
    useOrbital.getState().setDetached(['s1'])

    await useOrbital.getState().select('s1')

    expect(useOrbital.getState().ui.selectedId).toBe('s2')
  })

  it('select on a session that is not detached selects it as always', async () => {
    useOrbital.getState().setDetached(['s1'])

    await useOrbital.getState().select('s2')

    expect(focusSession).not.toHaveBeenCalled()
    expect(useOrbital.getState().ui.selectedId).toBe('s2')
  })

  it('a session whose window closed is selectable again', async () => {
    useOrbital.getState().setDetached(['s1'])
    useOrbital.getState().setDetached([])

    await useOrbital.getState().select('s1')

    expect(focusSession).not.toHaveBeenCalled()
    expect(useOrbital.getState().ui.selectedId).toBe('s1')
  })

  it('setDetached clears a selection that just became detached, viewer included', async () => {
    await useOrbital.getState().select('s1')
    useOrbital.getState().openFile('src/a.ts', 3)

    useOrbital.getState().setDetached(['s1'])

    expect(useOrbital.getState().detachedIds).toEqual(['s1'])
    expect(useOrbital.getState().ui.selectedId).toBeNull()
    expect(useOrbital.getState().ui.fileViewer).toBeNull()
  })

  it('setDetached leaves a selection that is not in the list alone', async () => {
    await useOrbital.getState().select('s2')
    useOrbital.getState().openFile('src/a.ts', 3)

    useOrbital.getState().setDetached(['s1'])

    expect(useOrbital.getState().ui.selectedId).toBe('s2')
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: 'src/a.ts', line: 3 })
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
    // What landed, not what came back: `m5` was already here.
    expect(fetched).toEqual(older.slice(0, 2))
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

  // An infinite scroll that asked again with the same cursor would get the
  // same page back, forever.
  it('resolves to an empty array when the page holds nothing that is not already here', async () => {
    useOrbital.setState({ transcripts: { s1: [{ id: 'm5', role: 'user', text: 'fifth' }] } })
    vi.mocked(api.getMessages).mockResolvedValueOnce([{ id: 'm5', role: 'user', text: 'fifth' }])

    expect(await useOrbital.getState().loadOlder('s1')).toEqual([])
  })

  // Seating the older page after the session was left would recreate its
  // transcript holding only that page, and the next return would put the
  // newest history in front of it.
  it('does not seat a page that resolves after its session was left', async () => {
    vi.mocked(api.getMessages).mockResolvedValueOnce([{ id: 'm5', role: 'user', text: 'fifth' }])
    await useOrbital.getState().select('s1')
    let resolveOlder: (m: ChatMessage[]) => void = () => {}
    vi.mocked(api.getMessages).mockImplementationOnce(
      () => new Promise<ChatMessage[]>((resolve) => { resolveOlder = resolve }),
    )
    const loading = useOrbital.getState().loadOlder('s1')
    useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null } }))
    resolveOlder([{ id: 'm4', role: 'assistant', text: 'fourth' }])

    expect(await loading).toEqual([])
    expect(useOrbital.getState().transcripts.s1).toBeUndefined()
  })

  it('resolves to null (leaving the transcript untouched) when the fetch fails', async () => {
    useOrbital.setState({ transcripts: { s1: [{ id: 'm5', role: 'user', text: 'fifth' }] } })
    vi.mocked(api.getMessages).mockRejectedValueOnce(new Error('network error'))

    const fetched = await useOrbital.getState().loadOlder('s1')

    expect(fetched).toBeNull()
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
// Interactive decisions
// (`docs/superpowers/specs/2026-09-20-interactive-decisions-design.md`).
// ---------------------------------------------------------------------------

const APPROACH = 'Which fix should I take for the double gutter?'
const TESTS = 'And what should I add to the suite?'

function makeDecision(
  overrides: Partial<PendingQuestionDecision> = {},
): PendingQuestionDecision {
  return {
    id: 'tu1',
    kind: 'question',
    createdAt: 1,
    input: {
      questions: [
        {
          question: APPROACH,
          header: 'Approach',
          multiSelect: false,
          options: [
            { label: 'Fix the gutter', description: 'Header only.' },
            { label: 'Container query', description: 'Move the breakpoint.' },
          ],
        },
      ],
    },
    ...overrides,
  }
}

/** A two-question card — the shape the POST-once rule is actually about. */
function makeStackedDecision(): PendingQuestionDecision {
  const single = makeDecision()
  return {
    ...single,
    input: {
      questions: [
        single.input.questions[0],
        {
          question: TESTS,
          header: 'Tests',
          multiSelect: false,
          options: [
            { label: 'One regression', description: 'Cheapest.' },
            { label: 'Breakpoint matrix', description: 'The whole stepper.' },
          ],
        },
      ],
    },
  }
}

describe('pending decisions', () => {
  it('decision_pending puts the question on its session', () => {
    const decision = makeDecision()
    useOrbital.getState().applySessionEvent('s1', { event: 'decision_pending', decision })
    expect(useOrbital.getState().pendingDecisions.s1).toEqual(decision)
  })

  it('decision_resolved clears it — the card locks whoever answered', () => {
    const decision = makeDecision()
    useOrbital.getState().applySessionEvent('s1', { event: 'decision_pending', decision })
    useOrbital.getState().applySessionEvent('s1', { event: 'decision_resolved', decisionId: 'tu1' })
    expect(useOrbital.getState().pendingDecisions.s1).toBeUndefined()
  })

  it('decision_resolved for some OTHER decision leaves the live one alone', () => {
    const decision = makeDecision()
    useOrbital.getState().applySessionEvent('s1', { event: 'decision_pending', decision })
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_resolved', decisionId: 'stale' })
    expect(useOrbital.getState().pendingDecisions.s1).toEqual(decision)
  })

  it('keeps the answers past the resolve, so the card can render what it sent', () => {
    const decision = makeDecision()
    useOrbital.getState().applySessionEvent('s1', { event: 'decision_pending', decision })
    useOrbital.getState().answerQuestion('s1', APPROACH, 'Fix the gutter')
    useOrbital.getState().applySessionEvent('s1', { event: 'decision_resolved', decisionId: 'tu1' })
    expect(useOrbital.getState().decisionAnswers.tu1).toEqual({ [APPROACH]: 'Fix the gutter' })
  })

  it('loadInitial seeds the pending question off the session snapshot — the reload path', async () => {
    const decision = makeDecision()
    vi.mocked(api.listSessions).mockResolvedValueOnce([
      makeSession({ id: 's1', status: 'needs_input', pendingDecision: decision }),
      makeSession({ id: 's2' }),
    ])

    await useOrbital.getState().loadInitial()

    expect(useOrbital.getState().pendingDecisions).toEqual({ s1: decision })
  })

  it('loadInitial is authoritative: a decision settled while this tab was gone is not restored', async () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeDecision() })
    vi.mocked(api.listSessions).mockResolvedValueOnce([
      makeSession({ id: 's1', pendingDecision: null }),
    ])

    await useOrbital.getState().loadInitial()

    expect(useOrbital.getState().pendingDecisions.s1).toBeUndefined()
  })

  it('an upsert carrying the question seeds it too', () => {
    const decision = makeDecision()
    useOrbital.getState().applySessionsEvent({
      event: 'upsert',
      session: makeSession({ id: 's1', pendingDecision: decision }),
    })
    expect(useOrbital.getState().pendingDecisions.s1).toEqual(decision)
  })

  it('an upsert with no question does NOT un-ask a live one', () => {
    const decision = makeDecision()
    useOrbital.getState().applySessionEvent('s1', { event: 'decision_pending', decision })
    useOrbital
      .getState()
      .applySessionsEvent({ event: 'upsert', session: makeSession({ id: 's1' }) })
    expect(useOrbital.getState().pendingDecisions.s1).toEqual(decision)
  })

  it('select seeds from the session row, for a tab that never heard the event', async () => {
    const decision = makeDecision()
    useOrbital.setState({
      sessions: { s1: makeSession({ id: 's1', pendingDecision: decision }) },
      historyLoaded: { s1: true },
    })
    await useOrbital.getState().select('s1')
    expect(useOrbital.getState().pendingDecisions.s1).toEqual(decision)
  })
})

describe('answerQuestion', () => {
  beforeEach(() => {
    vi.mocked(api.answerDecision).mockResolvedValue({ ok: true })
  })

  it('POSTs the complete record for a single-question card, keyed by the question text', () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeDecision() })

    useOrbital.getState().answerQuestion('s1', APPROACH, 'Fix the gutter')

    expect(api.answerDecision).toHaveBeenCalledWith('s1', 'tu1', {
      [APPROACH]: 'Fix the gutter',
    })
  })

  it('holds a stacked card until the last question, then sends once', () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeStackedDecision() })

    useOrbital.getState().answerQuestion('s1', APPROACH, 'Fix the gutter')
    expect(api.answerDecision).not.toHaveBeenCalled()
    expect(useOrbital.getState().decisionAnswers.tu1).toEqual({ [APPROACH]: 'Fix the gutter' })

    useOrbital.getState().answerQuestion('s1', TESTS, 'One regression')
    expect(api.answerDecision).toHaveBeenCalledTimes(1)
    expect(api.answerDecision).toHaveBeenCalledWith('s1', 'tu1', {
      [APPROACH]: 'Fix the gutter',
      [TESTS]: 'One regression',
    })
  })

  it('does nothing for a session with no pending question', () => {
    useOrbital.getState().answerQuestion('s1', APPROACH, 'Fix the gutter')
    expect(api.answerDecision).not.toHaveBeenCalled()
    expect(useOrbital.getState().decisionAnswers).toEqual({})
  })

  it('treats a 404 as resolved — someone else answered first, no error toast', async () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeDecision() })
    vi.mocked(api.answerDecision).mockRejectedValueOnce(new ApiError('gone', 404))

    useOrbital.getState().answerQuestion('s1', APPROACH, 'Fix the gutter')

    await vi.waitFor(() => {
      expect(useOrbital.getState().pendingDecisions.s1).toBeUndefined()
    })
    expect(useOrbital.getState().toast).toBeNull()
  })

  it('reports any other failure', async () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeDecision() })
    vi.mocked(api.answerDecision).mockRejectedValueOnce(new ApiError('boom', 500))

    useOrbital.getState().answerQuestion('s1', APPROACH, 'Fix the gutter')

    await vi.waitFor(() => {
      expect(useOrbital.getState().toast).toEqual({ kind: 'error', message: 'boom' })
    })
  })

  it('a failed POST takes the answer back, so the question is open again', async () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeDecision() })
    vi.mocked(api.answerDecision).mockRejectedValueOnce(new TypeError('tunnel lost'))

    useOrbital.getState().answerQuestion('s1', APPROACH, 'Fix the gutter')

    await vi.waitFor(() => {
      expect(useOrbital.getState().toast).toEqual({ kind: 'error', message: 'tunnel lost' })
    })
    expect(useOrbital.getState().decisionAnswers.tu1).toBeUndefined()
    expect(useOrbital.getState().pendingDecisions.s1).toBeDefined()
  })

  it('on a stacked card a failed POST takes back only the last answer', async () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeStackedDecision() })
    vi.mocked(api.answerDecision).mockRejectedValueOnce(new ApiError('boom', 500))

    useOrbital.getState().answerQuestion('s1', APPROACH, 'Fix the gutter')
    useOrbital.getState().answerQuestion('s1', TESTS, 'One regression')

    await vi.waitFor(() => {
      expect(useOrbital.getState().toast).toEqual({ kind: 'error', message: 'boom' })
    })
    expect(useOrbital.getState().decisionAnswers.tu1).toEqual({ [APPROACH]: 'Fix the gutter' })
  })
})

describe('sendPrompt while a question is pending', () => {
  beforeEach(() => {
    vi.mocked(api.answerDecision).mockResolvedValue({ ok: true })
  })

  it('routes the typed text to the open question instead of starting a new turn', async () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeDecision() })

    await useOrbital.getState().sendPrompt('s1', 'Neither — the wrapper is dead code.')

    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(useOrbital.getState().transcripts.s1).toBeUndefined()
    expect(api.answerDecision).toHaveBeenCalledWith('s1', 'tu1', {
      [APPROACH]: 'Neither — the wrapper is dead code.',
    })
  })

  it('answers the FIRST unanswered question of a stacked card', async () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeStackedDecision() })
    useOrbital.getState().answerQuestion('s1', APPROACH, 'Fix the gutter')

    await useOrbital.getState().sendPrompt('s1', 'a snapshot at 390px')

    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(api.answerDecision).toHaveBeenCalledWith('s1', 'tu1', {
      [APPROACH]: 'Fix the gutter',
      [TESTS]: 'a snapshot at 390px',
    })
  })

  it('reverts to a normal reply once every question is answered', async () => {
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: true })
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeDecision() })
    // Answered by a click; the decision has not been resolved by the server yet.
    useOrbital.getState().answerQuestion('s1', APPROACH, 'Fix the gutter')

    await useOrbital.getState().sendPrompt('s1', 'thanks')

    expect(api.sendMessage).toHaveBeenCalledWith('s1', 'thanks')
  })

  it('leaves an image-only turn alone — empty text is not an answer', async () => {
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: true })
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeDecision() })

    await useOrbital.getState().sendPrompt('s1', '   ', [
      { entry: { ref: 'r1', w: 1, h: 1, bytes: 2 }, name: 'a.png', source: 'file' },
    ])

    expect(api.answerDecision).not.toHaveBeenCalled()
    expect(api.sendMessage).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Permission prompts and plan approvals
// (`docs/superpowers/specs/2026-09-23-permission-and-plan-decisions-design.md`).
// ---------------------------------------------------------------------------

function makeVerdictDecision(
  overrides: Partial<PendingVerdictDecision> = {},
): PendingVerdictDecision {
  return {
    id: 'tu1',
    kind: 'permission',
    toolName: 'Bash',
    input: { command: 'rm -rf build' },
    createdAt: 1,
    ...overrides,
  }
}

describe('resolveDecision', () => {
  beforeEach(() => {
    vi.mocked(api.resolveDecision).mockResolvedValue({ ok: true })
  })

  it('posts the verdict and remembers it, so the card flips on the click', () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeVerdictDecision() })

    useOrbital.getState().resolveDecision('s1', { approved: true })

    expect(api.resolveDecision).toHaveBeenCalledWith('s1', 'tu1', { approved: true })
    expect(useOrbital.getState().decisionVerdicts.tu1).toEqual({ approved: true })
  })

  it('keeps the refusal’s reason, which nothing else ever gets back', () => {
    // The tool_result the client reads carries only the error flag; the
    // reason reaches the model and is never echoed to the transcript.
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeVerdictDecision() })

    useOrbital.getState().resolveDecision('s1', { approved: false, message: 'use git clean' })

    expect(useOrbital.getState().decisionVerdicts.tu1).toEqual({
      approved: false,
      message: 'use git clean',
    })
  })

  it('does nothing on a question — words are its answer, not a verdict', () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeDecision() })

    useOrbital.getState().resolveDecision('s1', { approved: true })

    expect(api.resolveDecision).not.toHaveBeenCalled()
    expect(useOrbital.getState().decisionVerdicts).toEqual({})
  })

  it('does nothing for a session with nothing parked', () => {
    useOrbital.getState().resolveDecision('s1', { approved: true })
    expect(api.resolveDecision).not.toHaveBeenCalled()
  })

  it('treats a 404 as resolved — the same rule the question path follows', async () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeVerdictDecision() })
    vi.mocked(api.resolveDecision).mockRejectedValueOnce(new ApiError('gone', 404))

    useOrbital.getState().resolveDecision('s1', { approved: true })

    await vi.waitFor(() => {
      expect(useOrbital.getState().pendingDecisions.s1).toBeUndefined()
    })
    expect(useOrbital.getState().toast).toBeNull()
  })

  it('reports any other failure', async () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeVerdictDecision() })
    vi.mocked(api.resolveDecision).mockRejectedValueOnce(new ApiError('boom', 500))

    useOrbital.getState().resolveDecision('s1', { approved: true })

    await vi.waitFor(() => {
      expect(useOrbital.getState().toast).toEqual({ kind: 'error', message: 'boom' })
    })
  })

  it('a failed POST takes the verdict back, so the card is live again', async () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeVerdictDecision() })
    vi.mocked(api.resolveDecision).mockRejectedValueOnce(new TypeError('tunnel lost'))

    useOrbital.getState().resolveDecision('s1', { approved: true })
    expect(useOrbital.getState().decisionVerdicts.tu1).toEqual({ approved: true })

    await vi.waitFor(() => {
      expect(useOrbital.getState().toast).toEqual({ kind: 'error', message: 'tunnel lost' })
    })
    expect(useOrbital.getState().decisionVerdicts.tu1).toBeUndefined()
    expect(useOrbital.getState().pendingDecisions.s1).toBeDefined()
  })
})

describe('sendPrompt while a permission or plan decision is pending', () => {
  beforeEach(() => {
    vi.mocked(api.resolveDecision).mockResolvedValue({ ok: true })
  })

  for (const kind of ['permission', 'plan'] as const) {
    it(`declines a ${kind} ask with the typed text as the reason`, async () => {
      useOrbital.getState().applySessionEvent('s1', {
        event: 'decision_pending',
        decision: makeVerdictDecision({ kind }),
      })

      await useOrbital.getState().sendPrompt('s1', 'run the tests first')

      // Typing is never an approval. It is the CLI's own "no, and tell Claude
      // what to do differently", and it starts no turn of its own.
      expect(api.resolveDecision).toHaveBeenCalledWith('s1', 'tu1', {
        approved: false,
        message: 'run the tests first',
      })
      expect(api.sendMessage).not.toHaveBeenCalled()
      expect(useOrbital.getState().transcripts.s1).toBeUndefined()
    })
  }

  it('never posts question answers at a verdict decision', async () => {
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeVerdictDecision() })

    await useOrbital.getState().sendPrompt('s1', 'anything')

    // The server would 400 it, but the real damage is on the other side of
    // that check: an `answers` key merged into a shell command's input.
    expect(api.answerDecision).not.toHaveBeenCalled()
  })

  it('leaves an image-only turn alone here too', async () => {
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: true })
    useOrbital
      .getState()
      .applySessionEvent('s1', { event: 'decision_pending', decision: makeVerdictDecision() })

    await useOrbital.getState().sendPrompt('s1', '  ', [
      { entry: { ref: 'r1', w: 1, h: 1, bytes: 2 }, name: 'a.png', source: 'file' },
    ])

    expect(api.resolveDecision).not.toHaveBeenCalled()
    expect(api.sendMessage).toHaveBeenCalled()
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

  it("raises the toast on an arriving record, marked as the log's", () => {
    useOrbital.getState().applyErrorsEvent({
      event: 'error',
      error: makeError({ id: 3, message: 'spawn claude ENOENT' }),
      unseen: 1,
    })

    expect(useOrbital.getState().toast).toEqual({
      kind: 'error',
      message: 'spawn claude ENOENT',
      source: 'log',
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

  it('drops the ids a seen event names, and every row when it names null', () => {
    useOrbital.setState({
      errors: [makeError({ id: 3 }), makeError({ id: 2 }), makeError({ id: 1 })],
      errorsUnseen: 3,
    })

    useOrbital.getState().applyErrorsEvent({ event: 'seen', ids: [2], unseen: 2 })
    expect(useOrbital.getState().errors.map((e) => e.id)).toEqual([3, 1])
    expect(useOrbital.getState().errorsUnseen).toBe(2)

    useOrbital.getState().applyErrorsEvent({ event: 'seen', ids: null, unseen: 0 })
    expect(useOrbital.getState().errors).toEqual([])
    expect(useOrbital.getState().errorsUnseen).toBe(0)
  })

  it('markErrorsSeen posts the ids, drops the rows, and takes the count from the response', async () => {
    vi.mocked(api.markErrorsSeen).mockResolvedValueOnce({ ok: true, unseen: 5 })
    useOrbital.setState({
      errors: [makeError({ id: 8 }), makeError({ id: 7 })],
      errorsUnseen: 6,
    })

    await useOrbital.getState().markErrorsSeen([7])

    expect(api.markErrorsSeen).toHaveBeenCalledWith([7])
    expect(useOrbital.getState().errors.map((e) => e.id)).toEqual([8])
    expect(useOrbital.getState().errorsUnseen).toBe(5)
  })

  it('markErrorsSeen does not call the API for an empty id list', async () => {
    await useOrbital.getState().markErrorsSeen([])
    expect(api.markErrorsSeen).not.toHaveBeenCalled()
  })

  it("markErrorsSeen('all') empties the inbox", async () => {
    vi.mocked(api.markErrorsSeen).mockResolvedValueOnce({ ok: true, unseen: 0 })
    useOrbital.setState({ errors: [makeError({ id: 1 })], errorsUnseen: 1 })

    await useOrbital.getState().markErrorsSeen('all')

    expect(api.markErrorsSeen).toHaveBeenCalledWith('all')
    expect(useOrbital.getState().errors).toEqual([])
    expect(useOrbital.getState().errorsUnseen).toBe(0)
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
      fileViewer: null,
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
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      leavingSince: { e: NOW - 1 },
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

  it('counts tag-filter matches only, although the map keeps the rest', () => {
    const sessions: Record<string, ApiSession> = {
      a: makeSession({ id: 'a', status: 'working', tagIds: [1] }),
      b: makeSession({ id: 'b', status: 'working', tagIds: [2] }), // muted
      c: makeSession({ id: 'c', status: 'idle', tagIds: [1] }),
      d: makeSession({ id: 'd', status: 'needs_input', tagIds: [2] }), // muted
      e: makeSession({ id: 'e', status: 'ended', tagIds: [1] }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      leavingSince: { e: NOW - 1 },
      ui: { ...initialSnapshot.ui, filterTagId: 1 },
    }
    // Only sessions a, c, e (tagIds includes 1) should be counted.
    expect(statusCounts(state, NOW)).toEqual({ working: 1, idle: 1, needs_input: 0, ended: 1 })
    expect(mapSessions(state, NOW).map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  // The map keeps non-matching planets (muted), but the readout counts what
  // the sidebar lists — ADR `search-mutes-planets-instead-of-hiding-them`.
  it('counts search matches only, although the map keeps the rest', () => {
    const sessions: Record<string, ApiSession> = {
      a: makeSession({ id: 'a', status: 'working', title: 'Fix login' }),
      b: makeSession({ id: 'b', status: 'working', title: 'Refactor', cwd: '/src/login-service' }),
      c: makeSession({ id: 'c', status: 'needs_input', title: 'Docs' }),
      d: makeSession({ id: 'd', status: 'ended', title: 'Release notes' }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      leavingSince: { d: NOW - 1 },
      ui: { ...initialSnapshot.ui, search: 'LOGIN' },
    }
    expect(statusCounts(state, NOW)).toEqual({ working: 2, idle: 0, needs_input: 0, ended: 0 })
    expect(mapSessions(state, NOW).map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(visibleSessions(state).map((s) => s.id).sort()).toEqual(['a', 'b'])
  })
})

describe('matchesSearch (pure)', () => {
  const session = makeSession({ id: 'm', title: 'Alpha Project', cwd: '/home/work/orbital' })

  it('matches title or cwd, case-insensitively, ignoring surrounding whitespace', () => {
    expect(matchesSearch(session, 'alpha')).toBe(true)
    expect(matchesSearch(session, '  ORBITAL ')).toBe(true)
    expect(matchesSearch(session, 'beta')).toBe(false)
  })

  it('matches everything for an empty or all-whitespace query', () => {
    expect(matchesSearch(session, '')).toBe(true)
    expect(matchesSearch(session, '   ')).toBe(true)
  })
})

describe('absorptionFor (pure)', () => {
  it('draws every session that is not ended, however old, whatever its origin', () => {
    for (const status of ['working', 'needs_input', 'idle'] as const) {
      expect(absorptionFor(makeSession({ id: status, status, lastAt: NOW - 90 * DAY }), NOW, undefined)).toBe('none')
      expect(
        absorptionFor(makeSession({ id: status, status, source: 'terminal', lastAt: NOW - 90 * DAY }), NOW, undefined),
      ).toBe('none')
    }
  })

  // spec 2026-09-24-sessions-end-only-by-hand-design § 3: a pin keeps an
  // ended session in the sidebar, not on the map.
  it('does not draw a pinned ended session', () => {
    const pinned = makeSession({ id: 'p', status: 'ended', lastAt: null, pinnedAt: NOW - DAY })
    expect(absorptionFor(pinned, NOW, undefined)).toBe('gone')
    expect(absorptionFor(pinned, NOW, NOW - 1)).toBe('leaving')
  })

  it('an ended, unpinned session this tab never saw leave is gone outright', () => {
    expect(absorptionFor(makeSession({ id: 'e', status: 'ended', lastAt: NOW - 1_000 }), NOW, undefined)).toBe('gone')
  })

  it('is leaving for the grace after it left, gone once the grace has passed', () => {
    const ended = makeSession({ id: 'e', status: 'ended' })
    expect(absorptionFor(ended, NOW, NOW - 1)).toBe('leaving')
    expect(absorptionFor(ended, NOW, NOW - MAP_LEAVE_GRACE_MS - 1)).toBe('gone')
  })

  // The scene's clock is only re-read on a timer, so it can trail a stamp
  // taken since — that body must still get its fade.
  it('is leaving when the stamp is newer than the clock', () => {
    expect(absorptionFor(makeSession({ id: 'e', status: 'ended' }), NOW, NOW + 60_000)).toBe('leaving')
  })
})

describe('trashDropFor (pure)', () => {
  it('ends an Orbital session with nothing in flight, ended ones included', () => {
    expect(trashDropFor('web', 'idle')).toBe('end')
    expect(trashDropFor('web', 'ended')).toBe('end')
  })

  it('asks first for an Orbital session that is working or waiting on the user', () => {
    expect(trashDropFor('web', 'working')).toBe('confirm')
    expect(trashDropFor('web', 'needs_input')).toBe('confirm')
  })

  it('refuses a terminal session whatever its status', () => {
    for (const status of ['working', 'needs_input', 'idle', 'ended'] as const) {
      expect(trashDropFor('terminal', status)).toBe('refuse')
    }
  })
})

describe('mapSessions (pure)', () => {
  it('drops ended sessions, pinned or not, and keeps every live one, however old', () => {
    const sessions: Record<string, ApiSession> = {
      ended: makeSession({ id: 'ended', status: 'ended', lastAt: NOW - 1_000 }),
      pinned: makeSession({ id: 'pinned', status: 'ended', lastAt: NOW - 400 * DAY, pinnedAt: 1 }),
      w: makeSession({ id: 'w', status: 'working', lastAt: NOW - 90 * DAY }),
      i: makeSession({ id: 'i', status: 'idle', lastAt: NOW - 90 * DAY }),
      n: makeSession({ id: 'n', status: 'needs_input', lastAt: NOW - 90 * DAY }),
    }
    const state: OrbitalState = { ...initialSnapshot, sessions }
    expect(mapSessions(state, NOW).map((s) => s.id).sort()).toEqual(['i', 'n', 'w'])
  })

  it('keeps a session that left the map while its grace runs, so the fade can play', () => {
    const sessions: Record<string, ApiSession> = {
      fading: makeSession({ id: 'fading', status: 'ended' }),
      faded: makeSession({ id: 'faded', status: 'ended' }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      leavingSince: { fading: NOW - 1, faded: NOW - MAP_LEAVE_GRACE_MS - 1 },
    }
    expect(mapSessions(state, NOW).map((s) => s.id)).toEqual(['fading'])
  })

  // The tag filter mutes on the map rather than hiding — ADR
  // `search-mutes-planets-instead-of-hiding-them`. Absorption still drops.
  it('ignores the tag filter, but still drops what the hole absorbed', () => {
    const sessions: Record<string, ApiSession> = {
      keep: makeSession({ id: 'keep', status: 'idle', tagIds: [1] }),
      otherTag: makeSession({ id: 'otherTag', status: 'idle', tagIds: [2] }),
      endedSameTag: makeSession({ id: 'endedSameTag', status: 'ended', tagIds: [1] }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      ui: { ...initialSnapshot.ui, filterTagId: 1 },
    }
    expect(mapSessions(state, NOW).map((s) => s.id).sort()).toEqual(['keep', 'otherTag'])
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
  // not survive just because the session behind it is still fading out.
  it('applies the origin filter to ended sessions still leaving too', () => {
    const sessions: Record<string, ApiSession> = {
      webEnded: makeSession({ id: 'webEnded', status: 'ended', source: 'web' }),
      termEnded: makeSession({ id: 'termEnded', status: 'ended', source: 'terminal' }),
    }
    const state: OrbitalState = {
      ...initialSnapshot,
      sessions,
      leavingSince: { webEnded: NOW - 1, termEnded: NOW - 1 },
      ui: { ...initialSnapshot.ui, sourceFilter: 'web' },
    }
    expect(mapSessions(state, NOW).map((s) => s.id)).toEqual(['webEnded'])
  })
})

describe('statusCounts and ended sessions', () => {
  it('counts ended sessions still on the map only', () => {
    const sessions: Record<string, ApiSession> = {
      leaving: makeSession({ id: 'leaving', status: 'ended' }),
      pinned: makeSession({ id: 'pinned', status: 'ended', pinnedAt: 1 }),
      gone: makeSession({ id: 'gone', status: 'ended' }),
      live: makeSession({ id: 'live', status: 'working' }),
    }
    const state: OrbitalState = { ...initialSnapshot, sessions, leavingSince: { leaving: NOW - 1 } }
    expect(statusCounts(state, NOW)).toEqual({ working: 1, idle: 0, needs_input: 0, ended: 1 })
  })
})

describe('leavingSince', () => {
  it('stamps a session the moment it ends, on either topic', () => {
    useOrbital.setState({
      sessions: {
        a: makeSession({ id: 'a', status: 'idle' }),
        b: makeSession({ id: 'b', status: 'working' }),
      },
    })
    useOrbital.getState().applySessionsEvent({ event: 'status', sessionId: 'a', status: 'ended' })
    useOrbital.getState().applySessionEvent('b', { event: 'status', status: 'ended' })

    expect(useOrbital.getState().leavingSince).toEqual({ a: expect.any(Number), b: expect.any(Number) })
  })

  it('stamps a pinned session that ends, and nothing that keeps its place or only loses a pin', () => {
    const pinned = makeSession({ id: 'p', status: 'idle', pinnedAt: 1 })
    const ended = makeSession({ id: 'e', status: 'ended', pinnedAt: 1 })
    useOrbital.setState({
      sessions: { p: pinned, e: ended, i: makeSession({ id: 'i', status: 'working' }) },
    })
    useOrbital.getState().applySessionEvent('i', { event: 'status', status: 'idle' })
    useOrbital.getState().applySessionsEvent({ event: 'upsert', session: { ...ended, pinnedAt: null } })
    expect(useOrbital.getState().leavingSince).toEqual({})

    useOrbital.getState().applySessionsEvent({ event: 'status', sessionId: 'p', status: 'ended' })
    expect(useOrbital.getState().leavingSince).toEqual({ p: expect.any(Number) })
  })
})

describe('trashSession', () => {
  const session = () => makeSession({ id: 'sd', title: 'auth refactor', status: 'idle' })

  beforeEach(() => {
    useOrbital.setState({ sessions: { sd: session() }, order: ['sd'] })
  })

  it('ends optimistically, saves, and raises the undo toast on success', async () => {
    const pending = useOrbital.getState().trashSession('sd', { undo: true })
    // Before the request answers: the planet starts leaving at once.
    expect(useOrbital.getState().sessions.sd.status).toBe('ended')
    expect(useOrbital.getState().leavingSince.sd).toEqual(expect.any(Number))
    await pending

    expect(api.endSession).toHaveBeenCalledWith('sd', { unpin: false })
    expect(api.setSessionPinned).not.toHaveBeenCalled()
    const toast = useOrbital.getState().toast
    expect(toast).toMatchObject({ kind: 'info', message: 'auth refactor ended' })
    expect(toast?.action?.label).toBe('Undo')
  })

  it('the toast expires on its own after the undo window', async () => {
    vi.useFakeTimers()
    try {
      await useOrbital.getState().trashSession('sd', { undo: true })
      expect(useOrbital.getState().toast).not.toBeNull()
      vi.advanceTimersByTime(UNDO_TOAST_MS)
      expect(useOrbital.getState().toast).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('without undo, ends and raises no toast', async () => {
    await useOrbital.getState().trashSession('sd', { undo: false })

    expect(api.endSession).toHaveBeenCalledWith('sd', { unpin: false })
    expect(useOrbital.getState().toast).toBeNull()
  })

  it('undo reopens the session, optimistically idle, without touching a pin it never had', async () => {
    await useOrbital.getState().trashSession('sd', { undo: true })
    useOrbital.getState().toast?.action?.run()

    expect(useOrbital.getState().sessions.sd.status).toBe('idle')
    await vi.waitFor(() => expect(api.reopenSession).toHaveBeenCalledWith('sd'))
    expect(api.setSessionPinned).not.toHaveBeenCalled()
  })

  // spec § 3: dropping a pinned session ends it and clears the pin; Undo
  // reopens it and re-pins it.
  it('takes the pin with it, says so, and undo puts both back', async () => {
    useOrbital.setState({ sessions: { sd: { ...session(), pinnedAt: 1_000 } } })

    await useOrbital.getState().trashSession('sd', { undo: true })

    expect(useOrbital.getState().sessions.sd.pinnedAt).toBeNull()
    // One request: an End and an unpin sent apart made the planet blink.
    expect(api.endSession).toHaveBeenCalledWith('sd', { unpin: true })
    expect(api.setSessionPinned).not.toHaveBeenCalled()
    expect(useOrbital.getState().toast?.message).toBe('auth refactor ended · pin removed')

    useOrbital.getState().toast?.action?.run()
    await vi.waitFor(() => expect(api.setSessionPinned).toHaveBeenLastCalledWith('sd', true))
    expect(api.reopenSession).toHaveBeenCalledWith('sd')
    expect(useOrbital.getState().sessions.sd).toMatchObject({ status: 'idle', pinnedAt: expect.any(Number) })
  })

  it('a pinned session that had already ended is only unpinned, and undo only re-pins', async () => {
    useOrbital.setState({ sessions: { sd: { ...session(), status: 'ended', pinnedAt: 1_000 } } })

    await useOrbital.getState().trashSession('sd', { undo: true })

    expect(api.endSession).not.toHaveBeenCalled()
    expect(api.setSessionPinned).toHaveBeenCalledWith('sd', false)

    useOrbital.getState().toast?.action?.run()
    await vi.waitFor(() => expect(api.setSessionPinned).toHaveBeenLastCalledWith('sd', true))
    expect(api.reopenSession).not.toHaveBeenCalled()
  })

  it('rolls status and pin back and rejects when the End fails', async () => {
    useOrbital.setState({ sessions: { sd: { ...session(), pinnedAt: 1_000 } } })
    vi.mocked(api.endSession).mockRejectedValueOnce(new Error('end server down'))

    await expect(useOrbital.getState().trashSession('sd', { undo: true })).rejects.toThrow('end server down')

    expect(useOrbital.getState().sessions.sd).toMatchObject({ status: 'idle', pinnedAt: 1_000 })
    expect(useOrbital.getState().toast).toBeNull()
  })

  it('puts the pin back and rejects when unpinning an already-ended session fails', async () => {
    useOrbital.setState({ sessions: { sd: { ...session(), status: 'ended', pinnedAt: 1_000 } } })
    vi.mocked(api.setSessionPinned).mockRejectedValueOnce(new Error('pin server down'))

    await expect(useOrbital.getState().trashSession('sd', { undo: true })).rejects.toThrow('pin server down')

    expect(useOrbital.getState().sessions.sd).toMatchObject({ status: 'ended', pinnedAt: 1_000 })
  })

  it('a failed reopen puts the End back and reports', async () => {
    await useOrbital.getState().trashSession('sd', { undo: true })
    vi.mocked(api.reopenSession).mockRejectedValueOnce(new Error('reopen server down'))

    await useOrbital.getState().reopenSession('sd', false)

    expect(useOrbital.getState().sessions.sd.status).toBe('ended')
    expect(useOrbital.getState().toast).toEqual({ kind: 'error', message: 'reopen server down' })
  })
})

describe('setSessionPinned', () => {
  beforeEach(() => {
    useOrbital.setState({
      sessions: { sp: makeSession({ id: 'sp', title: 'auth refactor', status: 'ended' }) },
      order: ['sp'],
    })
  })

  it('stamps optimistically and saves, without a toast', async () => {
    await useOrbital.getState().setSessionPinned('sp', true)

    expect(useOrbital.getState().sessions.sp.pinnedAt).toEqual(expect.any(Number))
    expect(api.setSessionPinned).toHaveBeenCalledWith('sp', true)
    expect(useOrbital.getState().toast).toBeNull()
  })

  it('unpinning clears the stamp and saves the clear, with no map change for an ended session', async () => {
    await useOrbital.getState().setSessionPinned('sp', true)
    await useOrbital.getState().setSessionPinned('sp', false)

    expect(useOrbital.getState().sessions.sp.pinnedAt).toBeNull()
    expect(api.setSessionPinned).toHaveBeenLastCalledWith('sp', false)
    expect(useOrbital.getState().leavingSince.sp).toBeUndefined()
  })

  it('rolls the pin back and reports when the save fails', async () => {
    vi.mocked(api.setSessionPinned).mockRejectedValueOnce(new Error('pin server down'))

    await useOrbital.getState().setSessionPinned('sp', true)

    expect(useOrbital.getState().sessions.sp.pinnedAt).toBeNull()
    expect(useOrbital.getState().toast).toEqual({ kind: 'error', message: 'pin server down' })
  })
})

describe('setTagAnchor', () => {
  const workTag: Tag = { id: 1, name: 'work', hue: 210, is_default: 0, anchor_x: null, anchor_y: null }

  beforeEach(() => {
    useOrbital.setState({ tags: [workTag] })
  })

  it('moves the home optimistically and saves it', async () => {
    await useOrbital.getState().setTagAnchor(1, { x: 40, y: -12 })

    const tag = useOrbital.getState().tags.find((t) => t.id === 1)
    expect(tag).toMatchObject({ anchor_x: 40, anchor_y: -12 })
    expect(api.patchTag).toHaveBeenCalledWith(1, { anchor_x: 40, anchor_y: -12 })
  })

  it('clears the home with null (back to the automatic layout)', async () => {
    await useOrbital.getState().setTagAnchor(1, { x: 40, y: -12 })
    await useOrbital.getState().setTagAnchor(1, null)

    const tag = useOrbital.getState().tags.find((t) => t.id === 1)
    expect(tag).toMatchObject({ anchor_x: null, anchor_y: null })
    expect(api.patchTag).toHaveBeenLastCalledWith(1, { anchor_x: null, anchor_y: null })
  })

  it('puts the home back and reports when the save fails', async () => {
    vi.mocked(api.patchTag).mockRejectedValue(new Error('anchors unreachable'))

    await useOrbital.getState().setTagAnchor(1, { x: 40, y: -12 })

    const tag = useOrbital.getState().tags.find((t) => t.id === 1)
    expect(tag).toMatchObject({ anchor_x: null, anchor_y: null })
    expect(useOrbital.getState().toast).toEqual({
      kind: 'error',
      message: 'anchors unreachable',
    })
  })
})

describe('sessionsTotal — the hole label count', () => {
  it('loadInitial fetches the index total', async () => {
    vi.mocked(api.sessionCount).mockResolvedValue(47)
    await useOrbital.getState().loadInitial()
    expect(useOrbital.getState().sessionsTotal).toBe(47)
  })

  it('survives a failed count probe as zero', async () => {
    vi.mocked(api.sessionCount).mockRejectedValue(new Error('down'))
    await useOrbital.getState().loadInitial()
    expect(useOrbital.getState().sessionsTotal).toBe(0)
  })

  it('tracks upserts of unknown sessions and removals', () => {
    useOrbital.setState({ sessionsTotal: 5 })
    useOrbital.getState().applySessionsEvent({
      event: 'upsert',
      session: makeSession({ id: 'brand-new' }),
    })
    expect(useOrbital.getState().sessionsTotal).toBe(6)
    // A re-upsert of a known session is not a new row.
    useOrbital.getState().applySessionsEvent({
      event: 'upsert',
      session: makeSession({ id: 'brand-new', title: 'renamed' }),
    })
    expect(useOrbital.getState().sessionsTotal).toBe(6)
    useOrbital.getState().applySessionsEvent({ event: 'remove', sessionId: 'brand-new' })
    expect(useOrbital.getState().sessionsTotal).toBe(5)
  })
})

describe('setSidebarCollapsed', () => {
  // The collapse has to survive a reload — see `sidebar_collapsed`.
  it('saves the collapse, and collapses the rail before the save comes back', () => {
    let resolveSave = (_: { ok: boolean }) => {}
    vi.mocked(api.patchSettings).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve
      })
    )

    useOrbital.getState().setSidebarCollapsed(true)

    expect(useOrbital.getState().ui.sidebarCollapsed).toBe(true)
    expect(useOrbital.getState().settings.sidebar_collapsed).toBe('true')
    expect(api.patchSettings).toHaveBeenCalledWith({ sidebar_collapsed: 'true' })
    resolveSave({ ok: true })
  })

  it('does not save a collapse that changes nothing', () => {
    useOrbital.getState().setSidebarCollapsed(false)
    expect(api.patchSettings).not.toHaveBeenCalled()
  })

  it('puts the rail back and reports when the save fails', async () => {
    vi.mocked(api.patchSettings).mockRejectedValue(new Error('settings server down'))

    useOrbital.getState().setSidebarCollapsed(true)
    await vi.waitFor(() => expect(useOrbital.getState().ui.sidebarCollapsed).toBe(false))

    expect(useOrbital.getState().settings.sidebar_collapsed).toBe('false')
    expect(useOrbital.getState().toast).toEqual({
      kind: 'error',
      message: 'settings server down',
    })
  })

  it('loadInitial seeds the collapse from the saved setting', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([])
    vi.mocked(api.listTags).mockResolvedValue([])
    vi.mocked(api.listTagRules).mockResolvedValue([])
    vi.mocked(api.getSettings).mockResolvedValue({ sidebar_collapsed: 'true' })

    await useOrbital.getState().loadInitial()

    expect(useOrbital.getState().ui.sidebarCollapsed).toBe(true)
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

  /** Its own transcript mark reports a failed compaction; the session did not fail. */
  it('never reports a failed compaction as the session failing', () => {
    const compaction = record({ id: 2, at: 2_000, kind: 'compaction_failed', message: 'Compaction failed: 529' })
    expect(recordedFailureFor(state({ errors: [compaction] }), 'a')).toBeUndefined()
    // …and does not hide a real failure recorded before it.
    expect(recordedFailureFor(state({ errors: [compaction, record()] }), 'a')?.kind).toBe('session_failed')
  })
})

describe('parsePlanetScale', () => {
  it('parses the stored multiplier', () => {
    expect(parsePlanetScale({ planet_scale: '1.15' })).toBe(1.15)
  })

  it('defaults to 1 when the key is missing or not a number', () => {
    expect(parsePlanetScale({})).toBe(1)
    expect(parsePlanetScale({ planet_scale: 'garbage' })).toBe(1)
  })

  it('clamps to the slider range [0.7, 1.6]', () => {
    expect(parsePlanetScale({ planet_scale: '0.2' })).toBe(0.7)
    expect(parsePlanetScale({ planet_scale: '9' })).toBe(1.6)
  })
})

describe('parseDetailPanelWidth', () => {
  it('parses the stored width', () => {
    expect(parseDetailPanelWidth({ detail_panel_width: '600' }, 1600)).toBe(600)
  })

  it('defaults to 450 when the key is missing or not a number', () => {
    expect(parseDetailPanelWidth({}, 1600)).toBe(450)
    expect(parseDetailPanelWidth({ detail_panel_width: 'wide' }, 1600)).toBe(450)
  })

  it('clamps to the 360px floor', () => {
    expect(parseDetailPanelWidth({ detail_panel_width: '100' }, 1600)).toBe(360)
  })

  it('clamps to 60% of the viewport', () => {
    expect(parseDetailPanelWidth({ detail_panel_width: '2000' }, 1600)).toBe(960)
  })

  it('keeps the floor when 60% of a narrow viewport would fall below it', () => {
    // The floor wins over the ceiling — a panel narrower than 360 stops
    // fitting its own header grid, per the idea doc.
    expect(parseDetailPanelWidth({ detail_panel_width: '500' }, 500)).toBe(360)
  })
})

// ---------------------------------------------------------------------------
// resolvePanelPairWidths — task 8's pairing math (spec § 8 "Layout"): the
// two docked panels together, once the subagent panel is open, capped at
// 75% of the viewport with the detail panel yielding first. Requirement 1
// (the single-panel case is UNCHANGED, 60% share included) is guarded
// elsewhere rather than here: `clampDetailPanelWidth`/`parseDetailPanelWidth`
// above are untouched by this task, and `DetailPanel — the subagent pairing`
// in `detail.test.tsx` asserts end to end that this function is never even
// reached while no subagent panel is open.
// ---------------------------------------------------------------------------
describe('resolvePanelPairWidths', () => {
  it('both panels fit under the ceiling at a wide viewport: keeps their stored widths', () => {
    // 450 + 16 (gutter) + 380 = 846; ceiling at 1600 is 1200 — comfortably clear.
    expect(resolvePanelPairWidths(450, SUBAGENT_PANEL_DEFAULT_PX, 1600)).toEqual({
      detailWidthPx: 450,
      subagentWidthPx: SUBAGENT_PANEL_DEFAULT_PX,
    })
  })

  it('the export defaults fit at the export viewport (canvas 11b: "846px = 59% of 1440")', () => {
    // The canvas's own worked example: 450 + 380 + 16 (gutter) = 846, and it
    // calls that whole sum "59% of 1440" — the gutter is INSIDE the 846,
    // which is the reading `resolvePanelPairWidths` follows (fix round 1;
    // see the ADR `panel-pair-ceiling-includes-the-gutter`).
    expect(resolvePanelPairWidths(450, SUBAGENT_PANEL_DEFAULT_PX, 1440)).toEqual({
      detailWidthPx: 450,
      subagentWidthPx: SUBAGENT_PANEL_DEFAULT_PX,
    })
  })

  it('the ceiling bites: the detail panel shrinks first, the subagent panel keeps its width', () => {
    // Ceiling at 1100px viewport = 825. 450 + 16 + 380 = 846 > 825, so the
    // detail panel gives way to exactly what is left: 825 - 16 - 380 = 429
    // — still above its own 360 floor, so nothing else has to move.
    expect(resolvePanelPairWidths(450, SUBAGENT_PANEL_DEFAULT_PX, 1100)).toEqual({
      detailWidthPx: 429,
      subagentWidthPx: SUBAGENT_PANEL_DEFAULT_PX,
    })
  })

  it('the ceiling bites harder: detail pins at 360 and the subagent panel starts shrinking (short of its own floor)', () => {
    // Ceiling at 960px viewport = 720. Even the detail panel's 360 floor
    // plus the 16px gutter plus 380 (756) overshoots it, so the detail
    // panel pins at 360 and the subagent panel gives up the rest:
    // 720 - 16 - 360 = 344 — narrower than its 380 default, but still short
    // of its own 320 floor.
    expect(resolvePanelPairWidths(450, SUBAGENT_PANEL_DEFAULT_PX, 960)).toEqual({
      detailWidthPx: DETAIL_PANEL_MIN_PX,
      subagentWidthPx: 344,
    })
  })

  it('fix round 1: locks the gutter-inclusive reading in at V=1000, where it disagrees with the (wrong) exclusive one', () => {
    // This is the exact viewport the review that produced fix round 1 used
    // to show the two readings disagree — already rendered elsewhere in
    // this suite (`detail.test.tsx`, `spacemap.test.tsx`), so a regression
    // back to the exclusive formula would have to break a visible test, not
    // just this pure one.
    //
    // Ceiling at 1000px viewport = 750.
    //   exclusive (WRONG — the brief's original, uncorrected formula):
    //     450 + 380 = 830 > 750 -> D' = 750 - 380 = 370, S stays 380
    //     => { detailWidthPx: 370, subagentWidthPx: 380 }
    //   inclusive (correct — what this function implements):
    //     450 + 16 + 380 = 846 > 750 -> D' = max(360, 750-16-380=354) = 360
    //     360 + 16 + 380 = 756 > 750, so S also shrinks:
    //     S' = max(320, 750-16-360) = 374
    //     => { detailWidthPx: 360, subagentWidthPx: 374 }
    expect(resolvePanelPairWidths(450, SUBAGENT_PANEL_DEFAULT_PX, 1000)).toEqual({
      detailWidthPx: DETAIL_PANEL_MIN_PX,
      subagentWidthPx: 374,
    })
  })

  it('below ~1010px viewport, both panels sit at their minimums and are allowed to exceed 75% (deferred: canvas 11d)', () => {
    // Ceiling at 700px viewport = 525. Both floors together, gutter
    // included (360 + 16 + 320 = 696), already overshoot it — per the brief
    // this is accepted as is rather than triggering the sub-1010px layout
    // mode this branch does not build.
    const result = resolvePanelPairWidths(450, SUBAGENT_PANEL_DEFAULT_PX, 700)
    expect(result).toEqual({
      detailWidthPx: DETAIL_PANEL_MIN_PX,
      subagentWidthPx: SUBAGENT_PANEL_MIN_PX,
    })
    expect(result.detailWidthPx + PANEL_GUTTER_PX + result.subagentWidthPx).toBeGreaterThan(700 * 0.75)
  })

  it('floors a subagent width under 320 before checking the ceiling', () => {
    // A hypothetically-dragged subagent width of 250 is floored to 320
    // first — the pairing math never sees anything smaller than that, so a
    // wide viewport leaves the detail panel untouched.
    expect(resolvePanelPairWidths(450, 250, 1600)).toEqual({
      detailWidthPx: 450,
      subagentWidthPx: SUBAGENT_PANEL_MIN_PX,
    })
  })

  it('dragging the detail panel wider cannot push the pair past the ceiling', () => {
    // A drag requesting 900px of detail panel at a 1200px viewport (ceiling
    // 900) would alone be a legal `clampDetailPanelWidth` result — but
    // paired with the subagent panel's 380 (plus the 16px gutter) it blows
    // straight through the pair's own ceiling, so the detail panel is
    // pulled back in: 900 - 16 - 380 = 504.
    const result = resolvePanelPairWidths(900, SUBAGENT_PANEL_DEFAULT_PX, 1200)
    expect(result.detailWidthPx + PANEL_GUTTER_PX + result.subagentWidthPx).toBeLessThanOrEqual(
      1200 * 0.75
    )
    expect(result.detailWidthPx).toBeLessThan(900)
    expect(result.subagentWidthPx).toBe(SUBAGENT_PANEL_DEFAULT_PX)
  })
})

// The same pair in a detached window: flush, no ceiling, the whole window
// split between them (spec: 2026-09-23-detached-session-windows-design).
describe('resolveWindowPanelWidths', () => {
  it('gives the subagent panel its default and the detail panel the rest', () => {
    const wide = DETAIL_PANEL_MIN_PX + SUBAGENT_PANEL_DEFAULT_PX + 200
    expect(resolveWindowPanelWidths(wide)).toEqual({
      detailWidthPx: DETAIL_PANEL_MIN_PX + 200,
      subagentWidthPx: SUBAGENT_PANEL_DEFAULT_PX,
    })
  })

  it('yields the detail panel first, then shrinks the subagent panel', () => {
    const between = WINDOW_PANEL_PAIR_MIN_PX + 10
    const result = resolveWindowPanelWidths(between)
    expect(result.detailWidthPx).toBe(DETAIL_PANEL_MIN_PX)
    expect(result.subagentWidthPx).toBe(SUBAGENT_PANEL_MIN_PX + 10)
    expect(result.detailWidthPx + result.subagentWidthPx).toBe(between)
  })

  it('fills the window exactly whenever the window can hold both minimums', () => {
    for (let width = WINDOW_PANEL_PAIR_MIN_PX; width <= 2000; width += 37) {
      const result = resolveWindowPanelWidths(width)
      expect(result.detailWidthPx + result.subagentWidthPx).toBe(width)
      expect(result.detailWidthPx).toBeGreaterThanOrEqual(DETAIL_PANEL_MIN_PX)
      expect(result.subagentWidthPx).toBeGreaterThanOrEqual(SUBAGENT_PANEL_MIN_PX)
      expect(result.subagentWidthPx).toBeLessThanOrEqual(SUBAGENT_PANEL_DEFAULT_PX)
    }
  })

  it('holds both minimums in a window still too narrow for them', () => {
    expect(resolveWindowPanelWidths(DETAIL_PANEL_MIN_PX)).toEqual({
      detailWidthPx: DETAIL_PANEL_MIN_PX,
      subagentWidthPx: SUBAGENT_PANEL_MIN_PX,
    })
  })
})

describe('parseSidebarWidth', () => {
  it('parses the stored width', () => {
    expect(parseSidebarWidth({ sidebar_width: '420' }, 1600)).toBe(420)
  })

  it('defaults to the export’s 300 when the key is missing or not a number', () => {
    expect(parseSidebarWidth({}, 1600)).toBe(300)
    expect(parseSidebarWidth({ sidebar_width: 'wide' }, 1600)).toBe(300)
  })

  it('clamps to the 280px floor', () => {
    expect(parseSidebarWidth({ sidebar_width: '100' }, 1600)).toBe(280)
  })

  it('clamps to 45% of the viewport', () => {
    expect(parseSidebarWidth({ sidebar_width: '2000' }, 1600)).toBe(720)
  })

  it('keeps the floor when 45% of a narrow viewport would fall below it', () => {
    expect(parseSidebarWidth({ sidebar_width: '500' }, 500)).toBe(280)
  })
})

describe('parseContextThresholds', () => {
  it('parses a valid pair', () => {
    expect(parseContextThresholds({ context_threshold_warn: '40', context_threshold_critical: '70' })).toEqual({
      warn: 40,
      critical: 70,
    })
  })

  it('defaults to 50/80 when the keys are missing or not numbers', () => {
    expect(parseContextThresholds({})).toEqual({ warn: 50, critical: 80 })
    expect(
      parseContextThresholds({ context_threshold_warn: 'garbage', context_threshold_critical: '70' })
    ).toEqual({ warn: 50, critical: 80 })
  })

  it('clamps each to [1, 99]', () => {
    expect(
      parseContextThresholds({ context_threshold_warn: '0', context_threshold_critical: '150' })
    ).toEqual({ warn: 1, critical: 99 })
  })

  it('falls back to defaults for BOTH when warn >= critical', () => {
    expect(
      parseContextThresholds({ context_threshold_warn: '80', context_threshold_critical: '80' })
    ).toEqual({ warn: 50, critical: 80 })
    expect(
      parseContextThresholds({ context_threshold_warn: '90', context_threshold_critical: '50' })
    ).toEqual({ warn: 50, critical: 80 })
  })

  it('falls back to defaults when clamping alone would still invert the pair', () => {
    // Both clamp to 99 — an inverted pair the clamp step cannot fix on its own.
    expect(
      parseContextThresholds({ context_threshold_warn: '500', context_threshold_critical: '200' })
    ).toEqual({ warn: 50, critical: 80 })
  })
})

describe('showContext / showCompactBadge', () => {
  it('default on when the key is missing', () => {
    expect(showContext({})).toBe(true)
    expect(showCompactBadge({})).toBe(true)
  })

  it('off only when explicitly "false"', () => {
    expect(showContext({ map_show_context: 'false' })).toBe(false)
    expect(showCompactBadge({ map_show_compact_badge: 'false' })).toBe(false)
    expect(showContext({ map_show_context: 'true' })).toBe(true)
  })
})

describe('guardGesture', () => {
  it('falls back to the guarded default, never to the unguarded one', () => {
    // An unreadable value must not quietly remove a safety.
    expect(guardGesture({})).toBe('hold')
    expect(guardGesture({ permission_guard_gesture: 'nonsense' })).toBe('hold')
    expect(guardGesture({ permission_guard_gesture: 'confirm' })).toBe('confirm')
    expect(guardGesture({ permission_guard_gesture: 'single' })).toBe('single')
  })
})

describe('editDiffsExpanded / expandDiffOnPermission', () => {
  it('ships collapsed, and only the exact word opens a diff', () => {
    // Opposite conventions on purpose: an unreadable value must leave the
    // transcript as it was, so this one is opt-in rather than default-on.
    expect(editDiffsExpanded({})).toBe(false)
    expect(editDiffsExpanded({ transcript_edit_diffs: 'collapsed' })).toBe(false)
    expect(editDiffsExpanded({ transcript_edit_diffs: 'Expanded' })).toBe(false)
    expect(editDiffsExpanded({ transcript_edit_diffs: 'expanded' })).toBe(true)
  })

  it('shows a blocked edit by default, off only when explicitly "false"', () => {
    expect(expandDiffOnPermission({})).toBe(true)
    expect(expandDiffOnPermission({ transcript_expand_diff_on_permission: 'false' })).toBe(false)
  })
})

describe('headerSessionStats', () => {
  it('draws the bar unless the setting literally says button', () => {
    expect(headerSessionStats({})).toBe('bar')
    expect(headerSessionStats({ header_session_stats: 'bar' })).toBe('bar')
    expect(headerSessionStats({ header_session_stats: 'button' })).toBe('button')
    // A value from a future build, or a hand-edited database, must not empty
    // the header of its only readout.
    expect(headerSessionStats({ header_session_stats: 'sparkline' })).toBe('bar')
  })
})

describe('mapStatePills', () => {
  it('draws dots unless the setting literally says label', () => {
    expect(mapStatePills({})).toBe('dot')
    expect(mapStatePills({ map_state_pills: 'label' })).toBe('label')
    expect(mapStatePills({ map_state_pills: 'dot' })).toBe('dot')
    expect(mapStatePills({ map_state_pills: 'words' })).toBe('dot')
  })
})

// ---------------------------------------------------------------------------
// File viewer UI state (spec: 2026-09-19-file-viewer-design § Wire + state)
// ---------------------------------------------------------------------------

describe('file viewer state', () => {
  it('starts closed', () => {
    expect(useOrbital.getState().ui.fileViewer).toBeNull()
  })

  it('openFile stores the path with its line target', () => {
    useOrbital.getState().openFile('web/src/App.tsx', 42)
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: 'web/src/App.tsx', line: 42 })
  })

  it('openFile without a line stores line null', () => {
    useOrbital.getState().openFile('docs/readme.md')
    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: 'docs/readme.md', line: null })
  })

  it('closeFile clears it', () => {
    useOrbital.getState().openFile('docs/readme.md', 3)
    useOrbital.getState().closeFile()
    expect(useOrbital.getState().ui.fileViewer).toBeNull()
  })

  it('selecting a different session closes the viewer — it belongs to the selected session', async () => {
    useOrbital.setState({
      sessions: { a: makeSession({ id: 'a' }), b: makeSession({ id: 'b' }) },
    })
    vi.mocked(api.getMessages).mockResolvedValue([])

    await useOrbital.getState().select('a')
    useOrbital.getState().openFile('web/src/App.tsx')
    await useOrbital.getState().select('b')

    expect(useOrbital.getState().ui.fileViewer).toBeNull()
  })

  it('re-selecting the same session leaves the viewer open', async () => {
    useOrbital.setState({ sessions: { a: makeSession({ id: 'a' }) } })
    vi.mocked(api.getMessages).mockResolvedValue([])

    await useOrbital.getState().select('a')
    useOrbital.getState().openFile('web/src/App.tsx')
    await useOrbital.getState().select('a')

    expect(useOrbital.getState().ui.fileViewer).toEqual({ path: 'web/src/App.tsx', line: null })
  })
})

// ---------------------------------------------------------------------------
// Composer attachments (spec: 2026-09-20-composer-design § Store + wire).
// ---------------------------------------------------------------------------

describe('sendPrompt with attachments', () => {
  const ENTRY_A = { ref: 'aaa.png', w: 1512, h: 982, bytes: 290_816 }
  const ENTRY_B = { ref: 'bbb.png', w: 1170, h: 760, bytes: 200_704 }

  const attached = [
    { entry: ENTRY_A, name: 'Clipboard image', source: 'clipboard' as const },
    { entry: ENTRY_B, name: 'after-390.png', source: 'file' as const },
  ]

  it('carries the uploaded entries and their local provenance on the optimistic turn', async () => {
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: true })

    await useOrbital.getState().sendPrompt('s1', 'both at 390', attached)

    const [message] = useOrbital.getState().transcripts.s1
    expect(message.images).toEqual([ENTRY_A, ENTRY_B])
    expect(message.imageProvenance).toEqual({
      'aaa.png': { name: 'Clipboard image', source: 'clipboard' },
      'bbb.png': { name: 'after-390.png', source: 'file' },
    })
  })

  it('sends the refs, not the entries', async () => {
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: true })
    await useOrbital.getState().sendPrompt('s1', 'both at 390', attached)
    expect(api.sendMessage).toHaveBeenCalledWith('s1', 'both at 390', ['aaa.png', 'bbb.png'])
  })

  it('sends an image-only turn — empty text is no longer nothing to send', async () => {
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: true })
    await useOrbital.getState().sendPrompt('s1', '', [attached[0]])

    const [message] = useOrbital.getState().transcripts.s1
    expect(message.text).toBe('')
    expect(message.images).toEqual([ENTRY_A])
    expect(api.sendMessage).toHaveBeenCalledWith('s1', '', ['aaa.png'])
  })

  it('leaves a text-only turn exactly as it was — no empty images key', async () => {
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: true })
    await useOrbital.getState().sendPrompt('s1', 'plain')

    const [message] = useOrbital.getState().transcripts.s1
    expect(message.images).toBeUndefined()
    expect(message.imageProvenance).toBeUndefined()
    expect(api.sendMessage).toHaveBeenCalledWith('s1', 'plain')
  })

  it('replaces the optimistic turn with the server echo and KEEPS the local captions', async () => {
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: true })
    await useOrbital.getState().sendPrompt('s1', 'both at 390', attached)

    useOrbital.getState().applySessionEvent('s1', {
      event: 'message',
      message: {
        id: 'server-1',
        role: 'user',
        text: 'both at 390',
        images: [ENTRY_A, ENTRY_B],
      },
    })

    const transcript = useOrbital.getState().transcripts.s1
    expect(transcript).toHaveLength(1)
    expect(transcript[0].id).toBe('server-1')
    expect(transcript[0].imageProvenance).toEqual({
      'aaa.png': { name: 'Clipboard image', source: 'clipboard' },
      'bbb.png': { name: 'after-390.png', source: 'file' },
    })
  })

  it('matches the pending turn on its image refs, not on text alone', async () => {
    vi.mocked(api.sendMessage).mockResolvedValue({ ok: true })
    // Two image-only turns: identical (empty) text, different bytes. Without
    // the refs in the match the second echo would replace the first bubble.
    await useOrbital.getState().sendPrompt('s1', '', [attached[0]])
    await useOrbital.getState().sendPrompt('s1', '', [attached[1]])

    useOrbital.getState().applySessionEvent('s1', {
      event: 'message',
      message: { id: 'server-2', role: 'user', text: '', images: [ENTRY_B] },
    })

    const transcript = useOrbital.getState().transcripts.s1
    expect(transcript).toHaveLength(2)
    expect(transcript[0].id.startsWith('local:')).toBe(true)
    expect(transcript[1].id).toBe('server-2')
    expect(transcript[1].imageProvenance).toEqual({
      'bbb.png': { name: 'after-390.png', source: 'file' },
    })
  })

  it('does not match a text-only echo against a pending turn that carried images', async () => {
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: true })
    await useOrbital.getState().sendPrompt('s1', 'look', [attached[0]])

    useOrbital.getState().applySessionEvent('s1', {
      event: 'message',
      message: { id: 'server-3', role: 'user', text: 'look' },
    })

    expect(useOrbital.getState().transcripts.s1).toHaveLength(2)
  })
})

describe('launchSession with attachments', () => {
  it('rides the refs along with the first prompt', async () => {
    vi.mocked(api.createSession).mockImplementation(async (body) => body.sessionId ?? 'new')

    await useOrbital.getState().launchSession({
      cwd: '/work/web',
      prompt: 'look at this',
      permissionMode: 'acceptEdits',
      attachments: ['aaa.png'],
    })

    expect(api.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: ['aaa.png'] }),
    )
  })
})

describe('resyncAfterReconnect', () => {
  it('reloads the snapshot and rebuilds the caches around the selected session', async () => {
    const sessions = [makeSession({ id: 's1' }), makeSession({ id: 's2' })]
    vi.mocked(api.listSessions).mockResolvedValueOnce(sessions)
    const fresh: ChatMessage[] = [
      { id: 'm1', role: 'user', text: 'first' },
      { id: 'm2', role: 'assistant', text: 'second' },
    ]
    vi.mocked(api.getMessages).mockResolvedValueOnce(fresh)

    useOrbital.setState((state) => ({
      transcripts: { s1: [{ id: 'stale', role: 'user', text: 'stale' }], s2: [] },
      historyLoaded: { s1: true, s2: true },
      ui: { ...state.ui, selectedId: 's1' },
    }))

    await useOrbital.getState().resyncAfterReconnect()

    const state = useOrbital.getState()
    expect(state.sessions.s2).toEqual(sessions[1])
    // Only the selected session survives, refetched — s2's stale cache is gone
    // so the next select() of it goes back to the API.
    expect(state.transcripts).toEqual({ s1: fresh })
    expect(state.historyLoaded).toEqual({ s1: true })
  })

  it('drops every cache when nothing is selected', async () => {
    useOrbital.setState({
      transcripts: { s1: [{ id: 'stale', role: 'user', text: 'stale' }] },
      historyLoaded: { s1: true },
    })

    await useOrbital.getState().resyncAfterReconnect()

    expect(api.getMessages).not.toHaveBeenCalled()
    expect(useOrbital.getState().transcripts).toEqual({})
    expect(useOrbital.getState().historyLoaded).toEqual({})
  })

  it('leaves the caches alone when the refetch fails', async () => {
    const stale: ChatMessage[] = [{ id: 'stale', role: 'user', text: 'stale' }]
    useOrbital.setState((state) => ({
      transcripts: { s1: stale },
      historyLoaded: { s1: true },
      ui: { ...state.ui, selectedId: 's1' },
    }))
    vi.mocked(api.getMessages).mockRejectedValueOnce(new Error('network error'))

    await expect(useOrbital.getState().resyncAfterReconnect()).resolves.toBeUndefined()

    expect(useOrbital.getState().transcripts).toEqual({ s1: stale })
    expect(useOrbital.getState().historyLoaded).toEqual({ s1: true })
  })
})

describe('checkTranscript', () => {
  const prompt: ChatMessage = { id: 'local:1', role: 'user', text: 'Question' }
  const reply: ChatMessage = { id: 'uuid-2:0', role: 'assistant', text: 'The reply' }
  const fromFile: ChatMessage[] = [{ ...prompt, id: 'uuid-1:0' }, reply]

  beforeEach(() => {
    useOrbital.setState((state) => ({
      transcripts: { s1: [prompt] },
      historyLoaded: { s1: true },
      ui: { ...state.ui, selectedId: 's1' },
    }))
  })

  it('reloads from the file and logs a gap once a row stays missing for two checks', async () => {
    vi.mocked(api.getMessages).mockResolvedValue(fromFile)

    await useOrbital.getState().checkTranscript('s1')
    expect(useOrbital.getState().transcripts.s1).toEqual([prompt])
    expect(api.reportErrorToServer).not.toHaveBeenCalled()

    await useOrbital.getState().checkTranscript('s1')
    expect(useOrbital.getState().transcripts.s1).toEqual(fromFile)
    expect(api.reportErrorToServer).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'transcript_gap', sessionId: 's1' }),
    )
  })

  it('leaves the panel alone when the socket delivers the row in between', async () => {
    vi.mocked(api.getMessages).mockResolvedValue(fromFile)

    await useOrbital.getState().checkTranscript('s1')
    useOrbital.getState().applySessionEvent('s1', {
      event: 'message',
      message: { ...reply, id: 's1:7:0' },
    })
    await useOrbital.getState().checkTranscript('s1')

    expect(useOrbital.getState().transcripts.s1.map((m) => m.id)).toEqual(['local:1', 's1:7:0'])
    expect(api.reportErrorToServer).not.toHaveBeenCalled()
  })
})

describe('setWsStatus', () => {
  it('resyncs when the socket comes back after a close', async () => {
    useOrbital.getState().setWsStatus('closed')
    useOrbital.getState().setWsStatus('open')

    expect(api.listSessions).toHaveBeenCalled()
    await vi.waitFor(() => expect(useOrbital.getState().ui.wsStatus).toBe('open'))
  })

  it('does not resync on the first connection', async () => {
    useOrbital.getState().setWsStatus('connecting')
    useOrbital.getState().setWsStatus('open')

    expect(api.listSessions).not.toHaveBeenCalled()
  })

  it('resyncs once per outage, not on every later open', async () => {
    useOrbital.getState().setWsStatus('closed')
    useOrbital.getState().setWsStatus('open')
    useOrbital.getState().setWsStatus('open')

    expect(api.listSessions).toHaveBeenCalledTimes(1)
  })
})

// fix: a-reply-is-in-the-transcript-file-but-not-in-the-open-panel
describe('select, coming back to a session', () => {
  const m1: ChatMessage = { id: 'm1', role: 'user', text: 'first' }
  const reply: ChatMessage = { id: 'm2', role: 'assistant', text: 'answered while away' }

  it('keeps a live message that arrives during the refetch, after the fetched history', async () => {
    vi.mocked(api.getMessages).mockResolvedValueOnce([m1])
    await useOrbital.getState().select('s1')
    vi.mocked(api.getMessages).mockResolvedValueOnce([])
    await useOrbital.getState().select('s2')

    const live: ChatMessage = { id: 's1:9:0', role: 'assistant', text: 'live' }
    let resolveFetch: (m: ChatMessage[]) => void = () => {}
    vi.mocked(api.getMessages).mockImplementationOnce(
      () => new Promise<ChatMessage[]>((resolve) => { resolveFetch = resolve }),
    )
    const selecting = useOrbital.getState().select('s1')
    useOrbital.getState().applySessionEvent('s1', { event: 'message', message: live })
    resolveFetch([m1, reply])
    await selecting

    expect(useOrbital.getState().transcripts.s1).toEqual([m1, reply, live])
  })

  it('drops the transcript of the session it left, and fetches it again on the way back', async () => {
    vi.mocked(api.getMessages).mockResolvedValueOnce([m1])
    await useOrbital.getState().select('s1')
    vi.mocked(api.getMessages).mockResolvedValueOnce([])
    await useOrbital.getState().select('s2')

    expect(useOrbital.getState().transcripts.s1).toBeUndefined()
    expect(useOrbital.getState().historyLoaded.s1).toBeUndefined()

    vi.mocked(api.getMessages).mockResolvedValueOnce([m1, reply])
    await useOrbital.getState().select('s1')
    expect(api.getMessages).toHaveBeenLastCalledWith('s1')
    expect(useOrbital.getState().transcripts.s1).toEqual([m1, reply])
  })

  it('drops the transcript when the selection is cleared outside select()', async () => {
    vi.mocked(api.getMessages).mockResolvedValueOnce([m1])
    await useOrbital.getState().select('s1')
    useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null } }))

    expect(useOrbital.getState().transcripts.s1).toBeUndefined()
    expect(useOrbital.getState().historyLoaded.s1).toBeUndefined()
  })

  it('does not seat a history that resolves after its session was left', async () => {
    let resolveFetch: (m: ChatMessage[]) => void = () => {}
    vi.mocked(api.getMessages).mockImplementationOnce(
      () => new Promise<ChatMessage[]>((resolve) => { resolveFetch = resolve }),
    )
    const selecting = useOrbital.getState().select('s1')
    vi.mocked(api.getMessages).mockResolvedValueOnce([])
    await useOrbital.getState().select('s2')
    resolveFetch([m1])
    await selecting

    expect(useOrbital.getState().transcripts.s1).toBeUndefined()
    expect(useOrbital.getState().historyLoaded.s1).toBeUndefined()
  })
})

// spec: 2026-09-24-streaming-output-design
describe('applySessionEvent: delta', () => {
  const apply = (msg: SessionEvent) =>
    useOrbital.getState().applySessionEvent('s1', msg)
  const delta = (id: string, offset: number, text: string, role: 'assistant' | 'thinking' = 'assistant') =>
    ({ event: 'delta', id, role, offset, text, model: 'claude-x' }) as const
  // Rows land only for a session that is shown or held.
  beforeEach(() => useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 's1' } })))

  it('creates a partial row on the first delta and grows it on the next', () => {
    apply(delta('r1', 0, 'Hel'))
    apply(delta('r1', 3, 'lo'))
    const [row] = useOrbital.getState().transcripts.s1
    expect(row).toMatchObject({ id: 'r1', role: 'assistant', text: 'Hello', model: 'claude-x', partial: true })
    expect(typeof row.timestamp).toBe('string')
  })

  it('ignores a delta delivered twice', () => {
    apply(delta('r1', 0, 'Hel'))
    apply(delta('r1', 3, 'lo'))
    apply(delta('r1', 3, 'lo'))
    expect(useOrbital.getState().transcripts.s1[0].text).toBe('Hello')
  })

  it('joins mid-stream from the tail it can see', () => {
    apply(delta('r1', 40, 'the end'))
    apply(delta('r1', 47, '.'))
    expect(useOrbital.getState().transcripts.s1[0].text).toBe('the end.')
  })

  it('replaces the partial row in place when the complete block arrives, and dedupes a second copy', () => {
    const before: ChatMessage = { id: 'm0', role: 'user', text: 'hi' }
    apply({ event: 'message', message: before })
    apply(delta('r1', 0, 'Hel'))
    apply(delta('r1', 3, 'lo'))
    const complete: ChatMessage = { id: 'r1', role: 'assistant', text: 'Hello', model: 'claude-x', timestamp: 't' }
    apply({ event: 'message', message: complete })
    apply({ event: 'message', message: complete })
    // A late delta cannot grow a finished row.
    apply(delta('r1', 5, '!'))
    expect(useOrbital.getState().transcripts.s1).toEqual([before, complete])
  })

  it('finalises a leftover partial row when the turn ends', () => {
    apply(delta('r1', 0, 'unclaimed', 'thinking'))
    apply({ event: 'turn_result', usage: {} })
    const [row] = useOrbital.getState().transcripts.s1
    expect(row).toMatchObject({ id: 'r1', role: 'thinking', text: 'unclaimed' })
    expect(row.partial).toBeUndefined()
  })
})

describe('refreshRemote', () => {
  const remoteStatus = (macName: string) => ({
    enabled: true, relay: 'online' as const, relayTooOld: null, relayAttempts: 0, relayUrl: 'https://r.example', macId: 'm',
    macName, devices: [], pendingPair: null, pairing: null, error: null,
  })

  it('stores the answer when nothing newer arrived meanwhile', async () => {
    vi.mocked(api.getRemote).mockResolvedValueOnce(remoteStatus('fetched'))
    expect(await useOrbital.getState().refreshRemote()).toBe('stored')
    expect(useOrbital.getState().remote?.macName).toBe('fetched')
  })

  it('answers failed, and keeps the status, when the read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    useOrbital.getState().setRemote(remoteStatus('kept'))
    vi.mocked(api.getRemote).mockRejectedValueOnce(new Error('down'))
    expect(await useOrbital.getState().refreshRemote()).toBe('failed')
    expect(useOrbital.getState().remote?.macName).toBe('kept')
  })

  it('drops the answer when a status was published while it was in flight', async () => {
    let answer!: (s: ReturnType<typeof remoteStatus>) => void
    vi.mocked(api.getRemote).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const pending = useOrbital.getState().refreshRemote()
    useOrbital.getState().applyRemoteEvent({ event: 'status', ...remoteStatus('published') })
    answer(remoteStatus('stale'))
    expect(await pending).toBe('superseded')
    expect(useOrbital.getState().remote?.macName).toBe('published')
  })
})
