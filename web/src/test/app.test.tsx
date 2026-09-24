import { StrictMode } from 'react'
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import type { ApiSession, Subagent } from '../lib/types'

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

  interface StatusSub {
    cb: (status: string) => void
    active: boolean
  }

  class MockOrbitalSocket {
    static instances: MockOrbitalSocket[] = []
    url: string
    subscriptions: Subscription[] = []
    statusSubs: StatusSub[] = []
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

    // Mirrors the real OrbitalSocket.onStatusChange contract (ws.ts): pushes
    // the callback, invokes it immediately with the current status, and
    // returns an unsubscribe function — App's effect relies on this return
    // value for cleanup (task-14 review finding I1).
    onStatusChange(cb: (status: string) => void): () => void {
      const entry: StatusSub = { cb, active: true }
      this.statusSubs.push(entry)
      cb(this.status)
      return () => {
        entry.active = false
      }
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
      for (const s of this.statusSubs) {
        if (s.active) s.cb(status)
      }
    }

    /** Test helper: count of still-active onStatusChange registrations
     * (registrations minus unsubscribes) — used to catch a leaked
     * registration from a mount/unmount cycle whose effect cleanup didn't
     * unsubscribe (task-14 review finding I1). */
    activeStatusSubCount(): number {
      return this.statusSubs.filter((s) => s.active).length
    }

    /** Test helper: wipe accumulated subscriptions/callbacks between tests —
     * the module-level socket App.tsx creates is a true singleton for this
     * whole file (constructed once at import time), so without this, state
     * from one test's mount would bleed into the next. */
    reset(): void {
      this.subscriptions = []
      this.statusSubs = []
      this.status = 'connecting'
    }
  }

  return { MockOrbitalSocket, resolveWsUrl: () => 'ws://mock/ws' }
})

vi.mock('../lib/ws', () => ({
  OrbitalSocket: MockOrbitalSocket,
  resolveWsUrl,
}))

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { useOrbital } from '../store/store'
import { installKeyListener } from '../lib/commands'
import App from '../App'
import { STATS_PATH } from '../stats/route'
import { stubLocationAssign } from './stubLocationAssign'

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
    model: null,
    resolvedModel: null,
    tagIds: [],
    status: 'idle',
    subagents: [],
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
    historyLoaded: {},
    transcriptErrors: {},
    errors: [],
    errorsUnseen: 0,
    toast: null,
    // Reset explicitly (`setState` merges rather than replaces): a test
    // below that opens the subagent panel and does not close it again
    // would otherwise leak it into whatever test runs next.
    subagentPanel: null,
    ui: {
      selectedId: null,
      filterTagId: 'all',
      search: '',
      sourceFilter: 'all',
      wsStatus: 'connecting',
      dialog: null,
      sidebarCollapsed: false,
      fileViewer: null,
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
  // App mirrors the selection into the address bar (`lib/sessionUrl`), and
  // jsdom keeps one URL for the whole file — without this, the session a test
  // selects is restored into the NEXT test on mount.
  window.history.replaceState(null, '', '/')

  vi.mocked(api.listSessions).mockResolvedValue([])
  vi.mocked(api.listTags).mockResolvedValue([])
  vi.mocked(api.listTagRules).mockResolvedValue([])
  vi.mocked(api.getSettings).mockResolvedValue({})
  vi.mocked(api.getMessages).mockResolvedValue([])
  vi.mocked(api.listProjects).mockResolvedValue([])
  vi.mocked(api.listModels).mockResolvedValue({ models: [], contextWindows: {} })
  vi.mocked(api.patchSettings).mockResolvedValue({ ok: true })
  vi.mocked(api.getSession).mockResolvedValue({
    session: makeSession({ id: 'unused' }),
  })
  // Selecting a web session mounts `DetailPanel`, whose walkthrough-entry
  // effect calls this on every mount. A default that never resolves means
  // that fetch never lands mid-test as an update no test here is actually
  // about — see `detail.test.tsx`'s identical default and
  // `docs/fixes/detailpanel-model-chip-updates-outside-act.md`.
  vi.mocked(api.walkthroughSummary).mockReturnValue(new Promise(() => {}))
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

// ---------------------------------------------------------------------------
// StrictMode: React 18 double-invokes mount/cleanup/mount for every
// component in dev. Task-14 review finding I1 — `onStatusChange` had no
// unsubscribe, so the first (discarded) mount's callback registration was
// never cleaned up, leaking a duplicate that fires on every future status
// change. Fixed by having `onStatusChange` return an unsubscribe and using
// it as the effect's cleanup; this asserts the fix holds under the exact
// double-mount cycle that exposed the bug.
// ---------------------------------------------------------------------------

describe('App: StrictMode double-mount', () => {
  it('does not crash under StrictMode, and leaves exactly one active onStatusChange registration', async () => {
    render(
      <StrictMode>
        <App />
      </StrictMode>
    )
    await waitFor(() => expect(api.listSessions).toHaveBeenCalled())

    expect(socket().activeStatusSubCount()).toBe(1)

    // The single surviving registration still behaves correctly (not a
    // leftover from the discarded first mount) — one emitStatus call
    // should update wsStatus exactly once, not fire a duplicate/no-op path.
    act(() => {
      socket().emitStatus('open')
    })
    expect(useOrbital.getState().ui.wsStatus).toBe('open')
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
// Keyboard: ⌘N (App's `global.new-session`) and Esc
// ---------------------------------------------------------------------------

describe('App: keyboard', () => {
  // `main.tsx` installs the app's one keydown listener; App alone does not.
  let uninstallKeys: () => void
  beforeAll(() => {
    uninstallKeys = installKeyListener()
  })
  afterAll(() => uninstallKeys())

  it('⌘N opens the new-session dialog', async () => {
    await renderApp()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'n', code: 'KeyN', metaKey: true })

    expect(useOrbital.getState().ui.dialog).toBe('new')
    // Exactly one dialog node — guards against NewSessionDialog being
    // rendered twice in the tree.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)

    // Let NewSessionDialog's own recent-dirs fetch (fired by opening it)
    // settle before the test ends, or its resolution lands outside act().
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())
  })

  it('⌥N no longer opens the dialog — the binding moved to ⌘N', async () => {
    await renderApp()

    fireEvent.keyDown(document, { key: '˜', code: 'KeyN', altKey: true })

    expect(useOrbital.getState().ui.dialog).toBeNull()
  })

  it('⌘⌥N does not open the dialog — the binding is ⌘N alone', async () => {
    await renderApp()

    fireEvent.keyDown(document, { key: '˜', code: 'KeyN', altKey: true, metaKey: true })

    expect(useOrbital.getState().ui.dialog).toBeNull()
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
// Keyboard: the app-level commands App registers (spec 2026-09-23-shortcuts
// § 2) — dialogs, pages and cycling through the sidebar's order
// ---------------------------------------------------------------------------

describe('App: navigation shortcuts', () => {
  let uninstallKeys: () => void
  beforeAll(() => {
    uninstallKeys = installKeyListener()
  })
  afterAll(() => uninstallKeys())

  /** Presses a chord and lets `select`'s async tail (the transcript fetch) settle inside act. */
  async function press(init: KeyboardEventInit) {
    await act(async () => {
      fireEvent.keyDown(document, init)
    })
  }
  const ctrlTab = { key: 'Tab', code: 'Tab', ctrlKey: true }
  const ctrlShiftTab = { key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }
  const selected = () => useOrbital.getState().ui.selectedId

  it('⌃⇥ walks the sidebar order top to bottom — PINNED first — and wraps', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([
      makeSession({ id: 'newer', lastAt: 300 }),
      makeSession({ id: 'older', lastAt: 200 }),
      makeSession({ id: 'pinned', lastAt: 100, pinnedAt: 1 }),
      makeSession({ id: 'history', lastAt: 400, status: 'ended' }),
    ])
    await renderApp()
    await waitFor(() => expect(useOrbital.getState().sessions.newer).toBeDefined())

    await press(ctrlTab)
    expect(selected()).toBe('pinned')
    await press(ctrlTab)
    expect(selected()).toBe('newer')
    await press(ctrlTab)
    expect(selected()).toBe('older')
    await press(ctrlTab)
    expect(selected()).toBe('pinned')
  })

  it('⌃⇧⇥ walks it bottom to top, starting from the last row with nothing selected', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([
      makeSession({ id: 'a', lastAt: 300 }),
      makeSession({ id: 'b', lastAt: 200 }),
    ])
    await renderApp()
    await waitFor(() => expect(useOrbital.getState().sessions.a).toBeDefined())

    await press(ctrlShiftTab)
    expect(selected()).toBe('b')
    await press(ctrlShiftTab)
    expect(selected()).toBe('a')
    await press(ctrlShiftTab)
    expect(selected()).toBe('b')
  })

  it('does not move the selection under an open dialog, which may be acting on it', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([
      makeSession({ id: 'a', lastAt: 300 }),
      makeSession({ id: 'b', lastAt: 200 }),
    ])
    await renderApp()
    await waitFor(() => expect(useOrbital.getState().sessions.a).toBeDefined())
    act(() => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, dialog: 'settings' } }))
    })

    await press(ctrlTab)
    expect(selected()).toBeNull()
  })

  it('⌘J jumps to the next session waiting on input, skipping the one already open', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([
      makeSession({ id: 'a', lastAt: 400, status: 'needs_input' }),
      makeSession({ id: 'b', lastAt: 300, status: 'working' }),
      makeSession({ id: 'c', lastAt: 200, status: 'needs_input' }),
    ])
    await renderApp()
    await waitFor(() => expect(useOrbital.getState().sessions.a).toBeDefined())

    await press({ key: 'j', code: 'KeyJ', metaKey: true })
    expect(selected()).toBe('a')
    await press({ key: 'j', code: 'KeyJ', metaKey: true })
    expect(selected()).toBe('c')
    await press({ key: 'j', code: 'KeyJ', metaKey: true })
    expect(selected()).toBe('a')
  })

  it('⌘J does nothing when no session is waiting on input', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([
      makeSession({ id: 'a', lastAt: 400, status: 'working' }),
      makeSession({ id: 'b', lastAt: 300, status: 'idle' }),
    ])
    await renderApp()
    await waitFor(() => expect(useOrbital.getState().sessions.a).toBeDefined())

    await press({ key: 'j', code: 'KeyJ', metaKey: true })
    expect(selected()).toBeNull()
  })

  it('⌘, opens Settings and ⌘⇧E the error log', async () => {
    await renderApp()

    await press({ key: ',', code: 'Comma', metaKey: true })
    expect(useOrbital.getState().ui.dialog).toBe('settings')

    await press({ key: 'E', code: 'KeyE', metaKey: true, shiftKey: true })
    expect(useOrbital.getState().ui.dialog).toBe('errors')
  })

  it('⌘2 loads /stats, but not from under a dialog, whose draft leaving would drop', async () => {
    const { assign, restore } = stubLocationAssign()
    try {
      await renderApp()
      act(() => {
        useOrbital.setState((s) => ({ ui: { ...s.ui, dialog: 'settings' } }))
      })

      await press({ key: '2', code: 'Digit2', metaKey: true })
      expect(assign).not.toHaveBeenCalled()

      act(() => {
        useOrbital.setState((s) => ({ ui: { ...s.ui, dialog: null } }))
      })
      await press({ key: '2', code: 'Digit2', metaKey: true })
      expect(assign).toHaveBeenCalledWith(STATS_PATH)
    } finally {
      restore()
    }
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
  it('opens Settings from the sidebar footer, and reaches Tags & rules from its nav', async () => {
    await renderApp()

    // Both sidebar layers stay mounted (they cross-fade), so the Settings
    // entry point exists twice: once in the expanded footer, once in the rail.
    const settingsEntries = screen.getAllByRole('button', { name: /open settings/i })
    expect(settingsEntries).toHaveLength(2)
    fireEvent.click(settingsEntries[settingsEntries.length - 1])
    // No section remembered yet, so it lands on the nav's first row.
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument()

    // Tags & rules is now a section of that same dialog, not a second one.
    fireEvent.click(screen.getByRole('button', { name: 'Tags & rules' }))
    expect(screen.getByRole('heading', { name: 'Tags & rules' })).toBeInTheDocument()
    expect(screen.getByText(/AUTO-TAG RULES/)).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Deep links: the selection lives in the address bar (`lib/sessionUrl` covers
// the sync itself; this is the wiring through the real App).
// ---------------------------------------------------------------------------

describe('App: session in the URL', () => {
  it('reopens the session the URL names, after the initial load has landed', async () => {
    const session = makeSession({ id: 'deep', title: 'Deep linked' })
    vi.mocked(api.listSessions).mockResolvedValue([session])
    window.history.replaceState(null, '', '/?session=deep')

    await renderApp()

    await waitFor(() => expect(useOrbital.getState().ui.selectedId).toBe('deep'))
    // The panel opens on it, and the URL is left exactly as it was found —
    // the entry the user landed on, not a step they took.
    // The panel's own title, not the sidebar row of the same name — at rest
    // it is a clamp that opens the field (canvas `Feature - Detail header` 9e).
    expect(await screen.findByTitle('Rename this session')).toHaveTextContent('Deep linked')
    expect(window.location.search).toBe('?session=deep')
  })

  it('puts a session picked on the map into the URL', async () => {
    const session = makeSession({ id: 'picked', title: 'Picked' })
    vi.mocked(api.listSessions).mockResolvedValue([session])
    await renderApp()

    await act(async () => {
      await useOrbital.getState().select('picked')
    })

    expect(window.location.search).toBe('?session=picked')
  })
})

// ---------------------------------------------------------------------------
// Map aggregate readout — plain text since tag clusters: an ended session
// leaves the map unless pinned (spec 2026-09-24-sessions-end-only-by-hand-
// design § 3), so the 2a/2b suppression toggle is gone.
// ---------------------------------------------------------------------------

describe('map aggregate readout', () => {
  /** Two live sessions plus two ended ones, pinned so they stay on the map. */
  async function renderWithEnded() {
    const recent = Date.now() - 60_000
    vi.mocked(api.listSessions).mockResolvedValue([
      makeSession({ id: 'w', status: 'working', lastAt: recent }),
      makeSession({ id: 'i', status: 'idle', lastAt: recent }),
      makeSession({ id: 'e1', status: 'ended', lastAt: recent, pinnedAt: recent }),
      makeSession({ id: 'e2', status: 'ended', lastAt: recent, pinnedAt: recent }),
    ])
    return renderApp()
  }

  it('renders every segment, ENDED included, as plain text — no pressable parts', async () => {
    await renderWithEnded()
    const row = screen.getByText(/2 ENDED/).closest('div') as HTMLElement
    expect(row).toHaveTextContent('1 WORKING')
    expect(row).toHaveTextContent('1 IDLE')
    expect(within(row).queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByText(/MAP ONLY · HISTORY LIST UNCHANGED/)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Errors trigger: an icon in the map HUD above the zoom stack, with the
// unseen count as its badge — no longer the plain pill above "New session".
// ---------------------------------------------------------------------------

describe('errors trigger in the map HUD', () => {
  it('carries the unseen count in its badge and its accessible name (canvas 5a)', async () => {
    await renderApp()
    act(() => {
      useOrbital.setState({ errorsUnseen: 3 })
    })

    const trigger = screen.getByRole('button', { name: 'Error log — 3 unseen' })
    expect(within(trigger).getByText('3')).toBeInTheDocument()
  })

  it('caps the badge at 99+ while the accessible name keeps the real count (canvas 5c)', async () => {
    await renderApp()
    act(() => {
      useOrbital.setState({ errorsUnseen: 120 })
    })

    const trigger = screen.getByRole('button', { name: 'Error log — 120 unseen' })
    expect(within(trigger).getByText('99+')).toBeInTheDocument()
  })

  it('drops the badge, not the button, when everything is seen', async () => {
    await renderApp()

    const trigger = screen.getByRole('button', { name: 'Error log' })
    expect(within(trigger).queryByText('0')).not.toBeInTheDocument()
  })

  it('opens the error log', async () => {
    await renderApp()

    fireEvent.click(screen.getByRole('button', { name: 'Error log' }))

    expect(useOrbital.getState().ui.dialog).toBe('errors')
    expect(screen.getByRole('heading', { name: 'Errors' })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Task 8 (spec § 8 "Layout"): placing the subagent panel. `DetailPanel.tsx`
// and `SpaceMap.tsx` each resolve their own widths/offsets (covered in
// `detail.test.tsx` and `spacemap.test.tsx`); this is the one additional
// right-offset site the brief calls out by name — App's OWN wrapper `div`
// around `<DetailPanel>`, which used to be a static `right-4` and now has to
// make room for `<SubagentPanel>` sitting to its right. A mistake here is
// exactly "an overlay lands underneath a panel": the math could be correct
// in `store.ts` and still never reach the DOM.
// ---------------------------------------------------------------------------

describe('App: placing the subagent panel', () => {
  const originalInnerWidth = window.innerWidth

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
  })

  function makeSubagentFixture(overrides: Partial<Subagent> = {}): Subagent {
    return {
      id: 'agent-1',
      name: 'Run the eslint and jest suites',
      state: 'working',
      toolUseId: 'tool-1',
      startedAt: 0,
      ...overrides,
    }
  }

  it('mounts the subagent panel and pushes the detail panel left by its width plus both gutters', async () => {
    // Wide enough (1600) that 450 + 380 sits comfortably under the pair's
    // 75% ceiling — neither panel is shrunk, so the offset is exactly
    // 16 (edge inset) + 380 (subagent) + 16 (gutter) = 412.
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true })
    vi.mocked(api.listSessions).mockResolvedValue([makeSession({ id: 'a' })])
    await renderApp()
    act(() => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 'a' } }))
    })

    // Nothing subagent-shaped is on screen until the panel opens.
    expect(screen.queryByText('SUBAGENT · READ-ONLY')).not.toBeInTheDocument()

    act(() => {
      useOrbital.setState({
        subagentPanel: {
          sessionId: 'a',
          subagent: makeSubagentFixture(),
          messages: [],
          droppedCount: 0,
          found: true,
        },
      })
    })

    // The panel itself is on screen — task 7's own chrome, now actually
    // placed rather than merely built.
    expect(screen.getByText('SUBAGENT · READ-ONLY')).toBeInTheDocument()
    expect(screen.getByText(/read-only · a subagent takes no input/i)).toBeInTheDocument()

    // The detail panel's own `<Panel>` (data-side="right") sits two DOM
    // levels inside App's positioning wrapper: the wrapper itself, then
    // `DetailPanel`'s presence div (ErrorBoundary renders no node of its
    // own when nothing has crashed).
    const detailPanelEl = document.querySelector('[data-side="right"]') as HTMLElement
    const wrapper = detailPanelEl.parentElement?.parentElement as HTMLElement
    expect(wrapper.style.right).toBe('412px')
  })

  it('shrinks the subagent panel itself once the ceiling bites, and offsets the detail panel by the SHRUNK width (fix round 1)', async () => {
    // Reviewer finding 3: every other rendered test in this suite (and in
    // detail.test.tsx/spacemap.test.tsx) happened to land at a viewport
    // where the subagent panel stayed at its 380 default — so a bug that
    // fed `detailPanelRightPx` the WRONG field (`.detailWidthPx` instead of
    // `.subagentWidthPx`), or that hardcoded `SUBAGENT_PANEL_DEFAULT_PX`
    // instead of reading the resolved value, would have passed the whole
    // suite. V=1000 is `resolvePanelPairWidths`'s own worked example for
    // fix round 1 (`store.test.ts`: "locks the gutter-inclusive reading in
    // at V=1000") — it resolves to {360, 374}, so this is the one rendered
    // test where the subagent panel's OWN width actually differs from its
    // default and can be checked against `<SubagentPanel>`'s real DOM node.
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
    vi.mocked(api.listSessions).mockResolvedValue([makeSession({ id: 'a' })])
    await renderApp()
    act(() => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 'a' } }))
    })
    act(() => {
      useOrbital.setState({
        subagentPanel: {
          sessionId: 'a',
          subagent: makeSubagentFixture(),
          messages: [],
          droppedCount: 0,
          found: true,
        },
      })
    })
    expect(screen.getByText('SUBAGENT · READ-ONLY')).toBeInTheDocument()

    // The subagent panel's own `<Panel side="subagent">` — its REAL rendered
    // width, read the same way `detail.test.tsx`'s `panelWidthPx` reads the
    // detail side.
    const subagentPanelEl = document.querySelector('[data-side="subagent"]') as HTMLElement
    expect(subagentPanelEl.style.width).toBe('374px')

    // The detail panel's wrapper offset: 16 (edge inset) + 374 (the
    // SHRUNK subagent width, not the 380 default) + 16 (gutter) = 406.
    const detailPanelEl = document.querySelector('[data-side="right"]') as HTMLElement
    const wrapper = detailPanelEl.parentElement?.parentElement as HTMLElement
    expect(wrapper.style.right).toBe('406px')
  })

  it('re-clamps the pair when the window shrinks, with no store write to prompt it', async () => {
    // The pair's ceiling is a fraction of the viewport, so a narrower window
    // has to shrink an open pair on its own. The widths used to be read off
    // `window.innerWidth` during render and stayed at whatever the last
    // unrelated re-render saw. The two viewports are the ones the tests above
    // already pin: roomy (neither panel shrunk) and V=1000 (the subagent
    // panel shrunk).
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true })
    vi.mocked(api.listSessions).mockResolvedValue([makeSession({ id: 'a' })])
    await renderApp()
    act(() => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 'a' } }))
    })
    act(() => {
      useOrbital.setState({
        subagentPanel: {
          sessionId: 'a',
          subagent: makeSubagentFixture(),
          messages: [],
          droppedCount: 0,
          found: true,
        },
      })
    })
    const subagentPanelEl = () => document.querySelector('[data-side="subagent"]') as HTMLElement
    const wrapper = () =>
      (document.querySelector('[data-side="right"]') as HTMLElement).parentElement
        ?.parentElement as HTMLElement
    expect(subagentPanelEl().style.width).toBe('380px')
    expect(wrapper().style.right).toBe('412px')

    const writes = vi.fn()
    const unsubscribe = useOrbital.subscribe(writes)
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
    act(() => {
      fireEvent(window, new Event('resize'))
    })

    await waitFor(() => expect(subagentPanelEl().style.width).toBe('374px'))
    expect(wrapper().style.right).toBe('406px')
    expect(writes).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('closing the detail panel closes the subagent panel with it, restoring the plain 16px inset', async () => {
    vi.mocked(api.listSessions).mockResolvedValue([makeSession({ id: 'a' })])
    await renderApp()
    act(() => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 'a' } }))
    })
    act(() => {
      useOrbital.setState({
        subagentPanel: {
          sessionId: 'a',
          subagent: makeSubagentFixture(),
          messages: [],
          droppedCount: 0,
          found: true,
        },
      })
    })
    expect(screen.getByText('SUBAGENT · READ-ONLY')).toBeInTheDocument()

    // Deselecting the session — the store's own subscription (store.ts,
    // "closes the subagent panel whenever the selected session stops being
    // its parent") closes the subagent panel too, not this component.
    act(() => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null } }))
    })

    expect(screen.queryByText('SUBAGENT · READ-ONLY')).not.toBeInTheDocument()
    expect(useOrbital.getState().subagentPanel).toBeNull()
  })
})
