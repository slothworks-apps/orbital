import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { ApiSession } from '../lib/types'

// ---------------------------------------------------------------------------
// jsdom polyfills App's real (unmocked) children need to mount:
//  - SpaceMap's R3F <Canvas> (via react-use-measure) needs ResizeObserver.
//  - Sidebar's infinite-scroll sentinel needs IntersectionObserver.
// Neither exists in jsdom. sidebar.test.tsx sidesteps this by injecting a
// fake `observerFactory` prop into `<Sidebar>` directly; App renders
// `<Sidebar />` with no such prop (it owns no observer concerns itself), so
// this file polyfills both globals instead — scoped to this file only, not
// added to the shared `test/setup.ts`.
// ---------------------------------------------------------------------------
beforeAll(() => {
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = NoopObserver
  // @ts-expect-error jsdom doesn't implement this one at all (no ambient type)
  global.IntersectionObserver = NoopObserver
})

// ---------------------------------------------------------------------------
// Mock OrbitalSocket (per task brief: no real WebSocket, no live server).
// `vi.hoisted` so the class exists before `vi.mock`'s factory runs (the
// factory is hoisted above this file's imports by Vitest).
// ---------------------------------------------------------------------------
const { MockOrbitalSocket, resolveWsUrl } = vi.hoisted(() => {
  interface Subscription {
    topic: string
    handler: (msg: unknown) => void
    active: boolean
  }

  class MockOrbitalSocket {
    static instances: MockOrbitalSocket[] = []
    url: string
    subscriptions: Subscription[] = []
    statusCallbacks: Array<(status: string) => void> = []
    status = 'connecting'

    constructor(url: string) {
      this.url = url
      MockOrbitalSocket.instances.push(this)
    }

    subscribe(topic: string, handler: (msg: unknown) => void): () => void {
      const entry: Subscription = { topic, handler, active: true }
      this.subscriptions.push(entry)
      return () => {
        entry.active = false
      }
    }

    onStatusChange(cb: (status: string) => void): void {
      this.statusCallbacks.push(cb)
      cb(this.status)
    }

    close(): void {}

    /** Test helper: currently-subscribed topic names (unsubscribed entries excluded). */
    activeTopics(): string[] {
      return this.subscriptions.filter((s) => s.active).map((s) => s.topic)
    }

    /** Test helper: deliver a message to every active handler on `topic`. */
    emit(topic: string, msg: unknown): void {
      for (const s of this.subscriptions) {
        if (s.active && s.topic === topic) s.handler(msg)
      }
    }

    /** Test helper: simulate a connection status transition. */
    emitStatus(status: string): void {
      this.status = status
      for (const cb of this.statusCallbacks) cb(status)
    }

    /** Test helper: wipe accumulated subscriptions/callbacks between tests —
     * the module-level socket App.tsx creates is a true singleton for this
     * whole file (constructed once at import time), so without this, state
     * from one test's mount would bleed into the next. */
    reset(): void {
      this.subscriptions = []
      this.statusCallbacks = []
      this.status = 'connecting'
    }
  }

  return { MockOrbitalSocket, resolveWsUrl: () => 'ws://mock/ws' }
})

vi.mock('../lib/ws', () => ({
  OrbitalSocket: MockOrbitalSocket,
  resolveWsUrl,
}))

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

import { api } from '../lib/api'
import { useOrbital } from '../store/store'
import App from '../App'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ApiSession> & { id: string }): ApiSession {
  return {
    cwd: '/home/tomin/projects/orbital',
    title: 'Session title',
    firstAt: 1,
    lastAt: 100,
    messageCount: 1,
    source: 'web',
    permissionMode: 'acceptEdits',
    parentId: null,
    tagIds: [],
    status: 'idle',
    ...overrides,
  }
}

function resetStore() {
  useOrbital.setState({
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
  })
}

function socket() {
  return MockOrbitalSocket.instances[0]
}

/** Renders `<App />` and waits out its mount-time `loadInitial()` call
 * before returning — every test uses this instead of a bare `render`
 * so the eventual `set(...)` from that resolved `Promise.all` (which
 * re-renders `SpaceMap`/`Sidebar` off the store) always lands inside an
 * awaited `act`, rather than asynchronously after the test's synchronous
 * body has already finished asserting. */
async function renderApp() {
  const result = render(<App />)
  await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(1))
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
  socket().reset()

  vi.mocked(api.listSessions).mockResolvedValue([])
  vi.mocked(api.listTags).mockResolvedValue([])
  vi.mocked(api.listTagRules).mockResolvedValue([])
  vi.mocked(api.getSettings).mockResolvedValue({})
  vi.mocked(api.getMessages).mockResolvedValue([])
  vi.mocked(api.listProjects).mockResolvedValue([])
  vi.mocked(api.getSession).mockResolvedValue({
    session: makeSession({ id: 'unused' }),
    lineage: [],
  })
})

// ---------------------------------------------------------------------------
// Data lifecycle
// ---------------------------------------------------------------------------

describe('App: mount', () => {
  it('calls loadInitial and subscribes the sessions topic on mount', async () => {
    await renderApp()

    expect(api.listTags).toHaveBeenCalledTimes(1)
    expect(api.listTagRules).toHaveBeenCalledTimes(1)
    expect(api.getSettings).toHaveBeenCalledTimes(1)

    expect(socket().activeTopics()).toContain('sessions')
  })

  it('creates exactly one OrbitalSocket for the app', async () => {
    await renderApp()
    expect(MockOrbitalSocket.instances).toHaveLength(1)
  })
})

describe('App: session subscription follows selection', () => {
  it('subscribes session:<id> when a session is selected, and unsubscribes the previous one on change', async () => {
    await renderApp()
    expect(socket().activeTopics()).not.toEqual(expect.arrayContaining(['session:a']))

    await act(async () => {
      await useOrbital.getState().select('a')
    })
    expect(socket().activeTopics()).toContain('session:a')
    expect(socket().activeTopics()).toContain('sessions')

    await act(async () => {
      await useOrbital.getState().select('b')
    })
    expect(socket().activeTopics()).not.toContain('session:a')
    expect(socket().activeTopics()).toContain('session:b')
  })

  it('routes session:<id> messages to applySessionEvent for the selected session', async () => {
    // Seed the fixture through the mocked listSessions() response (rather
    // than a separate setState after render) so there's no race between
    // this and the mount-time loadInitial() call overwriting `sessions`
    // with its own (otherwise empty) resolved result.
    vi.mocked(api.listSessions).mockResolvedValue([makeSession({ id: 'a', status: 'idle' })])
    await renderApp()
    await waitFor(() => expect(useOrbital.getState().sessions.a).toBeDefined())

    await act(async () => {
      await useOrbital.getState().select('a')
    })

    act(() => {
      socket().emit('session:a', { event: 'status', status: 'needs_input' })
    })

    expect(useOrbital.getState().sessions.a.status).toBe('needs_input')
  })

  it('unsubscribes session:<id> on unmount', async () => {
    const { unmount } = await renderApp()
    await act(async () => {
      await useOrbital.getState().select('a')
    })
    expect(socket().activeTopics()).toContain('session:a')

    unmount()
    expect(socket().activeTopics()).not.toContain('session:a')
  })
})

// ---------------------------------------------------------------------------
// Keyboard: Esc (⌘N is SpaceMap's own — verified not duplicated here)
// ---------------------------------------------------------------------------

describe('App: keyboard', () => {
  it('⌘N opens the new-session dialog via SpaceMap\'s own handler (not duplicated by App)', async () => {
    await renderApp()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'n', metaKey: true })

    expect(useOrbital.getState().ui.dialog).toBe('new')
    // Exactly one dialog node — a duplicate ⌘N registration in App would
    // still set the same value (idempotent), but this also guards against
    // NewSessionDialog being rendered twice in the tree.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    // Let NewSessionDialog's own recent-dirs fetch (fired by opening it)
    // settle before the test ends, or its resolution lands outside act().
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())
  })

  it('Esc closes an open dialog first, without also deselecting the current session', async () => {
    await renderApp()
    act(() => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 'a', dialog: 'new' } }))
    })
    // Opening NewSessionDialog for real fires its own recent-dirs fetch —
    // let it settle before proceeding, or its resolution lands outside act().
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(useOrbital.getState().ui.dialog).toBeNull()
    expect(useOrbital.getState().ui.selectedId).toBe('a')
  })

  it('Esc deselects the session once no dialog is open', async () => {
    await renderApp()
    act(() => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 'a', dialog: null } }))
    })

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(useOrbital.getState().ui.selectedId).toBeNull()
  })

  it('a second Esc after closing a dialog then deselects (two presses, two effects)', async () => {
    await renderApp()
    act(() => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 'a', dialog: 'new' } }))
    })
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useOrbital.getState().ui.selectedId).toBe('a')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(useOrbital.getState().ui.selectedId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// WS status banner
// ---------------------------------------------------------------------------

describe('App: WS status banner', () => {
  it('shows "reconnecting…" while the socket is not open, and hides it once open', async () => {
    await renderApp()
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument()

    act(() => {
      socket().emitStatus('open')
    })
    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument()

    act(() => {
      socket().emitStatus('closed')
    })
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

describe('App: Toasts', () => {
  it('renders the store toast and dismisses it on click', async () => {
    await renderApp()
    act(() => {
      useOrbital.setState({ toast: { kind: 'error', message: 'Failed to launch session' } })
    })

    expect(screen.getByText('Failed to launch session')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(screen.queryByText('Failed to launch session')).not.toBeInTheDocument()
    expect(useOrbital.getState().toast).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Dialog ownership: only App-owned dialogs render from here; DetailPanel
// owns StopDialog/ClearDialog itself (asserting App doesn't double-render them).
// ---------------------------------------------------------------------------

describe('App: dialog ownership', () => {
  it('opens Settings via the corner trigger, and Tags & rules via the sidebar footer', async () => {
    await renderApp()

    fireEvent.click(screen.getByRole('button', { name: /settings/i }))
    expect(screen.getByText('Settings')).toBeInTheDocument()
    act(() => {
      useOrbital.getState().setDialog(null)
    })

    fireEvent.click(screen.getByText(/tags & rules/i))
    expect(screen.getByText('Tags & rules')).toBeInTheDocument()
  })
})
