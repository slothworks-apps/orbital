import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MAX_SUBAGENT_MESSAGES } from '../lib/types'
import type { ChatMessage, Subagent } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

/**
 * One fake socket for the file, recording subscribes/releases per topic —
 * same shape `launch.test.ts` and `store.test.ts` use for `session:<id>`,
 * applied here to `subagent:<sessionId>:<toolUseId>`. Hoisted because
 * `vi.mock`'s factory runs before this file's imports.
 */
const { subscribeSpy, releaseSpy, handlers } = vi.hoisted(() => {
  const releaseSpy = vi.fn((topic: string) => topic)
  const handlers = new Map<string, (msg: unknown) => void>()
  const subscribeSpy = vi.fn((topic: string, handler: (msg: unknown) => void) => {
    handlers.set(topic, handler)
    return () => {
      handlers.delete(topic)
      releaseSpy(topic)
    }
  })
  return { subscribeSpy, releaseSpy, handlers }
})
vi.mock('../lib/socket', () => ({ getSocket: () => ({ subscribe: subscribeSpy }) }))

import { api, ApiError } from '../lib/api'
import { useOrbital } from '../store/store'

const SESSION_ID = 'session-1'
const OTHER_SESSION_ID = 'session-2'

function makeSubagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: 'agent-1',
    name: 'Run the eslint and jest suites',
    state: 'working',
    toolUseId: 'tool-1',
    startedAt: 1_000,
    ...overrides,
  }
}

function makeMessage(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', text: `msg ${id}`, ...overrides }
}

beforeEach(() => {
  // `closeSubagent()`, not a bare `setState`: the module-level subscription
  // tracker behind `subagentPanel` (`subagentSubscriptionRelease` in
  // `store.ts`) is NOT store state and would otherwise leak a real
  // subscription across tests — the next test's `openSubagent` would then
  // release IT at its own top, and `releaseSpy` would already show a call
  // before that test ever made one of its own.
  useOrbital.getState().closeSubagent()
  vi.clearAllMocks()
  handlers.clear()
  useOrbital.setState({
    subagentPanel: null,
    sessions: {},
    ui: { ...useOrbital.getState().ui, selectedId: null },
  })
  // `loadInitial`'s `Promise.all` — needed by `resyncAfterReconnect`, which
  // runs it before it gets anywhere near the panel. Without these the
  // default `undefined` throws on the first `for…of` and the resync's own
  // catch swallows everything after it.
  vi.mocked(api.listSessions).mockResolvedValue([])
  vi.mocked(api.listTags).mockResolvedValue([])
  vi.mocked(api.listTagRules).mockResolvedValue([])
  vi.mocked(api.getSettings).mockResolvedValue({})
  vi.mocked(api.listModels).mockResolvedValue({ models: [], contextWindows: {} })
  vi.mocked(api.listErrors).mockResolvedValue({ errors: [], unseen: 0 })
  vi.mocked(api.getMessages).mockResolvedValue([])
})

describe('openSubagent', () => {
  it('fetches the buffer and subscribes to the topic before the fetch resolves', async () => {
    const subagent = makeSubagent()
    let resolveFetch: (v: { messages: ChatMessage[]; droppedCount: number }) => void
    vi.mocked(api.subagentMessages).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    )

    const opened = useOrbital.getState().openSubagent(SESSION_ID, subagent)

    // Subscribed synchronously, before the fetch has any chance to resolve.
    expect(subscribeSpy).toHaveBeenCalledWith(
      `subagent:${SESSION_ID}:tool-1`,
      expect.any(Function),
    )
    expect(api.subagentMessages).toHaveBeenCalledWith(SESSION_ID, 'tool-1')

    resolveFetch!({ messages: [makeMessage('m1')], droppedCount: 0 })
    await opened

    const panel = useOrbital.getState().subagentPanel
    expect(panel?.sessionId).toBe(SESSION_ID)
    expect(panel?.subagent).toBe(subagent)
    expect(panel?.messages).toEqual([makeMessage('m1')])
    expect(panel?.found).toBe(true)
  })

  it('swaps the contents for a second agent and releases the first subscription', async () => {
    const first = makeSubagent({ id: 'agent-1', toolUseId: 'tool-1' })
    const second = makeSubagent({ id: 'agent-2', toolUseId: 'tool-2', name: 'second agent' })
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })

    await useOrbital.getState().openSubagent(SESSION_ID, first)
    expect(releaseSpy).not.toHaveBeenCalled()

    await useOrbital.getState().openSubagent(SESSION_ID, second)

    // The FIRST agent's subscription was released, not just superseded.
    expect(releaseSpy).toHaveBeenCalledWith(`subagent:${SESSION_ID}:tool-1`)
    expect(subscribeSpy).toHaveBeenCalledWith(
      `subagent:${SESSION_ID}:tool-2`,
      expect.any(Function),
    )
    expect(useOrbital.getState().subagentPanel?.subagent).toBe(second)
  })

  it('renders (holds) the fetched messages for the opened agent', async () => {
    const subagent = makeSubagent()
    const messages = [makeMessage('m1'), makeMessage('m2')]
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages, droppedCount: 3 })

    await useOrbital.getState().openSubagent(SESSION_ID, subagent)

    const panel = useOrbital.getState().subagentPanel
    expect(panel?.messages).toEqual(messages)
    expect(panel?.droppedCount).toBe(3)
    expect(panel?.found).toBe(true)
  })

  it('a 404 marks the panel not-found (STREAM LOST) rather than an empty transcript', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockRejectedValue(new ApiError('gone', 404))

    await useOrbital.getState().openSubagent(SESSION_ID, subagent)

    const panel = useOrbital.getState().subagentPanel
    expect(panel?.found).toBe(false)
    expect(panel?.messages).toEqual([])
  })

  it('a 200 with an empty list is found — not the same as a 404', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })

    await useOrbital.getState().openSubagent(SESSION_ID, subagent)

    const panel = useOrbital.getState().subagentPanel
    expect(panel?.found).toBe(true)
    expect(panel?.messages).toEqual([])
  })
})

describe('closeSubagent', () => {
  it('releases the subscription and clears the panel', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)
    expect(releaseSpy).not.toHaveBeenCalled()

    useOrbital.getState().closeSubagent()

    expect(releaseSpy).toHaveBeenCalledWith(`subagent:${SESSION_ID}:tool-1`)
    expect(useOrbital.getState().subagentPanel).toBeNull()
  })

  it('is a harmless no-op when nothing is open', () => {
    expect(() => useOrbital.getState().closeSubagent()).not.toThrow()
    expect(useOrbital.getState().subagentPanel).toBeNull()
  })
})

describe('dismissSubagent (task 9 brief § 3)', () => {
  it('calls the API with the agent id, NOT the toolUseId', async () => {
    await useOrbital.getState().dismissSubagent(SESSION_ID, 'agent-1')
    expect(api.dismissSubagent).toHaveBeenCalledWith(SESSION_ID, 'agent-1')
  })

  it('does not touch subagentPanel itself — no optimistic local removal; the moon leaves through the republished session, the same path every other session mutation takes', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)

    await useOrbital.getState().dismissSubagent(SESSION_ID, subagent.id)

    // Still open, unchanged — dismissal is a fire-and-forget request; only a
    // real `sessions` republish (outside this action entirely) ever removes
    // the moon.
    expect(useOrbital.getState().subagentPanel?.subagent).toBe(subagent)
  })

  it('reports a toast on failure rather than throwing', async () => {
    vi.mocked(api.dismissSubagent).mockRejectedValue(new Error('network down'))
    await expect(useOrbital.getState().dismissSubagent(SESSION_ID, 'agent-1')).resolves.toBeUndefined()
    expect(useOrbital.getState().toast).toEqual({ kind: 'error', message: 'network down' })
  })
})

describe('selection closes the subagent panel', () => {
  beforeEach(() => {
    vi.mocked(api.listSessions).mockResolvedValue([])
  })

  it('selecting a different planet closes the panel', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)
    useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: SESSION_ID } }))
    expect(useOrbital.getState().subagentPanel).not.toBeNull()

    await useOrbital.getState().select(OTHER_SESSION_ID)

    expect(useOrbital.getState().subagentPanel).toBeNull()
    expect(releaseSpy).toHaveBeenCalledWith(`subagent:${SESSION_ID}:tool-1`)
  })

  it('deselecting (clearing ui.selectedId directly) closes the panel too', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)
    useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: SESSION_ID } }))
    expect(useOrbital.getState().subagentPanel).not.toBeNull()

    // The detail panel's own × button, the map's empty-space click, App's
    // Escape handler and sessionUrl's cleanup all deselect exactly like
    // this — a raw `setState`, never through `select()`.
    useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null } }))

    expect(useOrbital.getState().subagentPanel).toBeNull()
  })

  it('reselecting the SAME session leaves the panel open', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)
    useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: SESSION_ID } }))

    await useOrbital.getState().select(SESSION_ID)

    expect(useOrbital.getState().subagentPanel).not.toBeNull()
  })
})

describe('live messages', () => {
  it('a message on the topic appends to the open agent transcript', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [makeMessage('m1')], droppedCount: 0 })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)

    handlers.get(`subagent:${SESSION_ID}:tool-1`)!({
      event: 'message',
      message: makeMessage('m2'),
    })

    expect(useOrbital.getState().subagentPanel?.messages).toEqual([
      makeMessage('m1'),
      makeMessage('m2'),
    ])
  })

  it('dedupes by message id, the way the session transcript does', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [makeMessage('m1')], droppedCount: 0 })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)

    handlers.get(`subagent:${SESSION_ID}:tool-1`)!({ event: 'message', message: makeMessage('m1') })

    expect(useOrbital.getState().subagentPanel?.messages).toEqual([makeMessage('m1')])
  })

  it('a live message for a topic that is no longer open is ignored', async () => {
    const first = makeSubagent({ id: 'agent-1', toolUseId: 'tool-1' })
    const second = makeSubagent({ id: 'agent-2', toolUseId: 'tool-2' })
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    await useOrbital.getState().openSubagent(SESSION_ID, first)
    const staleHandler = handlers.get(`subagent:${SESSION_ID}:tool-1`)
    await useOrbital.getState().openSubagent(SESSION_ID, second)

    // The old handler was removed from the socket's dispatch map by the
    // release above; calling it directly (as if a message had somehow still
    // arrived) still must not touch the panel that replaced it.
    staleHandler?.({ event: 'message', message: makeMessage('stale') })

    expect(useOrbital.getState().subagentPanel?.messages).toEqual([])
  })
})

/**
 * I6. `SpaceMap` used to call `openSubagent` alone, so a moon click could
 * leave the agent panel docked with nothing selected (`mapInsets.right` and
 * `overlayRightPx` are both gated on `selectedId` and would have ignored it)
 * or beside a DIFFERENT session's detail panel. The close guard fires on
 * `ui.selectedId` CHANGING, so it can never repair a mismatch that is
 * already true at open time.
 */
describe('openSubagent selects the parent session (I6)', () => {
  it('selects the agent\'s own session when nothing is selected', async () => {
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })

    await useOrbital.getState().openSubagent(SESSION_ID, makeSubagent())

    expect(useOrbital.getState().ui.selectedId).toBe(SESSION_ID)
    expect(useOrbital.getState().subagentPanel?.sessionId).toBe(SESSION_ID)
  })

  it('moves the selection off another session, and the panel survives its own move', async () => {
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: OTHER_SESSION_ID } }))

    await useOrbital.getState().openSubagent(SESSION_ID, makeSubagent())

    // The close guard fires on the way through (the panel open at that
    // instant, if any, belonged to session-2) and the new panel is set
    // afterwards, so the one being opened is never the one it closes.
    expect(useOrbital.getState().ui.selectedId).toBe(SESSION_ID)
    expect(useOrbital.getState().subagentPanel?.sessionId).toBe(SESSION_ID)
  })

  it('does not re-select — and so does not refetch — when it is already the selected session', async () => {
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    useOrbital.setState((s) => ({
      ui: { ...s.ui, selectedId: SESSION_ID },
      historyLoaded: {},
    }))

    await useOrbital.getState().openSubagent(SESSION_ID, makeSubagent())

    expect(api.getMessages).not.toHaveBeenCalled()
  })
})

/**
 * C3. The socket reconnect. `OrbitalSocket.onopen` re-subscribes every live
 * topic, `subagent:…` included, so the SUBSCRIPTION comes back on its own —
 * and the panel quietly resumes appending with every message published
 * during the outage missing from the middle of its transcript. Nothing
 * refetched it, and nothing said so.
 *
 * The same gap is what made STREAM LOST dead code: after a server restart
 * `loadInitial` repopulates `sessions` with `subagents: []` and never
 * touches `ui.selectedId`, so no guard fires, no moon and no `OPEN →` row
 * remain to re-open from, and the 404 branch was unreachable on the one
 * scenario the whole state exists for.
 */
describe('reconnect re-opens the panel (C3)', () => {
  it('refetches the open agent\'s buffer, closing the hole the outage left', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({
      messages: [makeMessage('m1')],
      droppedCount: 0,
    })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)
    vi.mocked(api.subagentMessages).mockClear()

    // Everything published here is in the server's ring buffer and nowhere
    // in this tab.
    vi.mocked(api.subagentMessages).mockResolvedValue({
      messages: [makeMessage('m1'), makeMessage('m2'), makeMessage('m3')],
      droppedCount: 0,
    })

    await useOrbital.getState().resyncAfterReconnect()

    expect(api.subagentMessages).toHaveBeenCalledWith(SESSION_ID, 'tool-1')
    expect(useOrbital.getState().subagentPanel?.messages.map((m) => m.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ])
    // Re-subscribed, not left on a topic handle from before the socket died.
    expect(subscribeSpy).toHaveBeenLastCalledWith(
      `subagent:${SESSION_ID}:tool-1`,
      expect.any(Function),
    )
  })

  it('renders STREAM LOST when the server has forgotten the agent — the restart case', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({
      messages: [makeMessage('m1')],
      droppedCount: 0,
    })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)
    expect(useOrbital.getState().subagentPanel?.found).toBe(true)

    // A restarted server: both in-memory stores are gone, so the session
    // comes back with no subagents and the messages route 404s.
    vi.mocked(api.listSessions).mockResolvedValue([])
    vi.mocked(api.subagentMessages).mockRejectedValue(new ApiError('gone', 404))

    await useOrbital.getState().resyncAfterReconnect()

    const panel = useOrbital.getState().subagentPanel
    expect(panel?.found).toBe(false)
    expect(panel?.messages).toEqual([])
  })

  it('does nothing extra when no panel is open', async () => {
    await useOrbital.getState().resyncAfterReconnect()
    expect(api.subagentMessages).not.toHaveBeenCalled()
  })
})

/**
 * I7. Spec § 3: `droppedCount` "rides the REST response AND the WS
 * increments". The server published only `{ event: 'message', message }`,
 * and the client appended without bound — so a panel open across the
 * server's 2 000-message cap kept growing past it and could render
 * TRUNCATED's "buffer 3,412 steps", a figure the ring buffer it reports on
 * cannot produce.
 */
describe('droppedCount and the client-side cap (I7)', () => {
  it('takes droppedCount off the live payload', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)

    handlers.get(`subagent:${SESSION_ID}:tool-1`)!({
      event: 'message',
      message: makeMessage('m1'),
      droppedCount: 7,
    })

    expect(useOrbital.getState().subagentPanel?.droppedCount).toBe(7)
  })

  it('keeps the previous count when a payload carries none — an older server', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 3 })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)

    handlers.get(`subagent:${SESSION_ID}:tool-1`)!({
      event: 'message',
      message: makeMessage('m1'),
    })

    expect(useOrbital.getState().subagentPanel?.droppedCount).toBe(3)
  })

  it('caps the list at the server\'s own cap, evicting from the front', async () => {
    const subagent = makeSubagent()
    // Opened on a full buffer, which is exactly when the next live message
    // has to evict rather than grow.
    const full = Array.from({ length: MAX_SUBAGENT_MESSAGES }, (_, i) => makeMessage(`m${i}`))
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: full, droppedCount: 0 })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)

    handlers.get(`subagent:${SESSION_ID}:tool-1`)!({
      event: 'message',
      message: makeMessage('newest'),
      droppedCount: 1,
    })

    const messages = useOrbital.getState().subagentPanel!.messages
    expect(messages).toHaveLength(MAX_SUBAGENT_MESSAGES)
    expect(messages[0].id).toBe('m1') // m0 evicted, same as the server's
    expect(messages.at(-1)!.id).toBe('newest')
    expect(useOrbital.getState().subagentPanel?.droppedCount).toBe(1)
  })
})

/**
 * I8. `server/src/index.ts` drops both subagent stores the moment a session
 * ends, on the strength of a comment claiming "no panel can still be open on
 * a session the map no longer shows". A browser's `subagentPanel` is its
 * own state and `ui.selectedId` need not move, so the panel outlived its
 * parent with a header that could no longer name it and a buffer it could
 * no longer refetch.
 */
describe('the parent session going away closes the panel (I8)', () => {
  it('closes and releases the subscription on a sessions remove', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    useOrbital.setState({ sessions: { [SESSION_ID]: { id: SESSION_ID } as never }, sessionsTotal: 1 })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)

    useOrbital.getState().applySessionsEvent({ event: 'remove', sessionId: SESSION_ID })

    expect(useOrbital.getState().subagentPanel).toBeNull()
    expect(releaseSpy).toHaveBeenCalledWith(`subagent:${SESSION_ID}:tool-1`)
  })

  it('leaves a panel on a DIFFERENT session alone', async () => {
    const subagent = makeSubagent()
    vi.mocked(api.subagentMessages).mockResolvedValue({ messages: [], droppedCount: 0 })
    useOrbital.setState({
      sessions: {
        [SESSION_ID]: { id: SESSION_ID } as never,
        [OTHER_SESSION_ID]: { id: OTHER_SESSION_ID } as never,
      },
      sessionsTotal: 2,
    })
    await useOrbital.getState().openSubagent(SESSION_ID, subagent)

    useOrbital.getState().applySessionsEvent({ event: 'remove', sessionId: OTHER_SESSION_ID })

    expect(useOrbital.getState().subagentPanel).not.toBeNull()
  })
})
