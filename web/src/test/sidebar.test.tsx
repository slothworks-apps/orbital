import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ApiSession, Tag } from '../lib/types'
import { useOrbital, type OrbitalState, type OrbitalUiState } from '../store/store'
import { timeAgo, shortenPath } from '../lib/format'

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
      listModels: vi.fn(),
      setSessionModel: vi.fn(),
      patchSettings: vi.fn(),
    } satisfies Record<keyof typeof actual.api, unknown>,
  }
})

import { api } from '../lib/api'
import { Sidebar, type ObserverFactory, type ObserverLike } from '../panels/Sidebar'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    tagIds: [],
    status: 'idle',
    subagents: [],
    ...overrides,
  }
}

const workTag: Tag = { id: 1, name: 'work', hue: 210, is_default: 0 }
const personalTag: Tag = { id: 2, name: 'personal', hue: 330, is_default: 0 }

const defaultUi: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  hideEnded: false,
  wsStatus: 'connected',
  dialog: null,
  sidebarCollapsed: false,
}

function resetStore(
  overrides: Partial<Omit<OrbitalState, 'ui'>> & { ui?: Partial<OrbitalUiState> } = {}
) {
  const sessions = overrides.sessions ?? {}
  useOrbital.setState({
    sessions,
    order: overrides.order ?? Object.keys(sessions),
    tags: [workTag, personalTag],
    rules: [],
    settings: {},
    transcripts: {},
    usage: {},
    historyLoaded: {},
    toast: null,
    ...overrides,
    ui: { ...defaultUi, ...overrides.ui },
  })
}

/** A no-op ObserverFactory — tests that don't care about infinite scroll pass this so no real IntersectionObserver is required in jsdom. */
const noopObserverFactory: ObserverFactory = () => ({
  observe() {},
  disconnect() {},
})

/** Captures the callback passed to the factory so a test can fire it manually to simulate the sentinel entering the viewport. */
function makeCapturingObserverFactory(): {
  factory: ObserverFactory
  trigger: () => void
} {
  let capturedCallback: IntersectionObserverCallback | null = null
  const observerLike: ObserverLike = { observe() {}, disconnect() {} }
  const factory: ObserverFactory = (callback) => {
    capturedCallback = callback
    return observerLike
  }
  const trigger = () => {
    capturedCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
  }
  return { factory, trigger }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// timeAgo
// ---------------------------------------------------------------------------

describe('timeAgo', () => {
  const now = 1_000_000_000_000

  it('reads "now" for anything under a minute old', () => {
    expect(timeAgo(now - 30_000, now)).toBe('now')
  })

  it('formats minutes', () => {
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m')
  })

  it('formats hours once past 60 minutes', () => {
    expect(timeAgo(now - 3 * 60 * 60_000, now)).toBe('3h')
  })

  it('formats days once past 24 hours', () => {
    expect(timeAgo(now - 2 * 24 * 60 * 60_000, now)).toBe('2d')
  })

  it('falls back to a short date past 30 days', () => {
    const result = timeAgo(now - 40 * 24 * 60 * 60_000, now)
    expect(result).not.toMatch(/d$/)
  })
})

// ---------------------------------------------------------------------------
// shortenPath
// ---------------------------------------------------------------------------

describe('shortenPath', () => {
  it('keeps only the last two segments, ellipsized, for deep paths', () => {
    expect(shortenPath('/Users/tomin/Projects/slothworks/orbital')).toBe('~/…/slothworks/orbital')
  })

  it('shows short paths in full without an ellipsis', () => {
    expect(shortenPath('/a/b')).toBe('~/a/b')
    expect(shortenPath('/a')).toBe('~/a')
  })
})

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

describe('Sidebar', () => {
  it('splits sessions into ACTIVE (non-ended) and HISTORY (ended) sections', () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Working one', status: 'working', tagIds: [1] }),
        b: makeSession({ id: 'b', title: 'Idle one', status: 'idle', tagIds: [1] }),
        c: makeSession({ id: 'c', title: 'Done one', status: 'ended', tagIds: [1], lastAt: Date.now() - 5 * 60_000 }),
      },
    })

    render(<Sidebar observerFactory={noopObserverFactory} />)

    const active = screen.getByRole('list', { name: /active sessions/i })
    const history = screen.getByRole('list', { name: /session history/i })

    expect(within(active).getByText('Working one')).toBeInTheDocument()
    expect(within(active).getByText('Idle one')).toBeInTheDocument()
    expect(within(active).queryByText('Done one')).not.toBeInTheDocument()

    expect(within(history).getByText('Done one')).toBeInTheDocument()
    expect(within(history).queryByText('Working one')).not.toBeInTheDocument()

    // relative time is rendered somewhere in the history row
    expect(within(history).getByText('5m')).toBeInTheDocument()
  })

  // Artboard 3b: the badge sits on the name line, so it reads as a property
  // of the session rather than of its status — status keeps the right edge.
  it('badges a live terminal row read-only and leaves an orbital row unmarked', () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Attached one', status: 'idle', source: 'terminal' }),
        b: makeSession({ id: 'b', title: 'Orbital one', status: 'idle', source: 'web' }),
      },
    })

    render(<Sidebar observerFactory={noopObserverFactory} />)

    const attached = screen.getByRole('button', { name: /Attached one/ })
    const badge = within(attached).getByText('read-only')
    expect(badge).toHaveAttribute(
      'title',
      'Attached from an external terminal · read-only in Orbital'
    )
    expect(within(screen.getByRole('button', { name: /Orbital one/ })).queryByText('read-only')).toBeNull()
  })

  // An ended terminal session is not read-only: `continue` resumes it as a
  // new web session, so the badge would be a lie in HISTORY.
  it('never badges a history row, terminal or not', () => {
    resetStore({
      sessions: {
        a: makeSession({
          id: 'a',
          title: 'Finished one',
          status: 'ended',
          source: 'terminal',
          lastAt: Date.now() - 5 * 60_000,
        }),
      },
    })

    render(<Sidebar observerFactory={noopObserverFactory} />)

    const history = screen.getByRole('list', { name: /session history/i })
    expect(within(history).getByText('Finished one')).toBeInTheDocument()
    expect(within(history).queryByText('read-only')).toBeNull()
  })

  it('narrows the ACTIVE list by origin and leaves HISTORY untouched', async () => {
    const user = userEvent.setup()
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Attached one', status: 'idle', source: 'terminal' }),
        b: makeSession({ id: 'b', title: 'Orbital one', status: 'idle', source: 'web' }),
        c: makeSession({
          id: 'c',
          title: 'Finished terminal',
          status: 'ended',
          source: 'terminal',
          lastAt: Date.now() - 5 * 60_000,
        }),
      },
    })

    render(<Sidebar observerFactory={noopObserverFactory} />)

    await user.click(screen.getByRole('combobox', { name: /filter sessions by origin/i }))
    await user.click(screen.getByRole('option', { name: /started in orbital/ }))

    const active = screen.getByRole('list', { name: /active sessions/i })
    expect(within(active).getByText('Orbital one')).toBeInTheDocument()
    expect(within(active).queryByText('Attached one')).toBeNull()

    const history = screen.getByRole('list', { name: /session history/i })
    expect(within(history).getByText('Finished terminal')).toBeInTheDocument()
  })

  it('carries the short origin label on the trigger and counts on the options', async () => {
    const user = userEvent.setup()
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Attached one', status: 'idle', source: 'terminal' }),
        b: makeSession({ id: 'b', title: 'Orbital one', status: 'idle', source: 'web' }),
        c: makeSession({ id: 'c', title: 'Orbital two', status: 'working', source: 'web' }),
        // Ended rows are not in the ACTIVE list, so they are not in its counts.
        d: makeSession({
          id: 'd',
          title: 'Finished terminal',
          status: 'ended',
          source: 'terminal',
          lastAt: Date.now() - 5 * 60_000,
        }),
      },
    })

    render(<Sidebar observerFactory={noopObserverFactory} />)

    const trigger = screen.getByRole('combobox', { name: /filter sessions by origin/i })
    const triggerLabel = () => trigger.textContent?.replace('▾', '').trim()
    expect(triggerLabel()).toBe('all')

    await user.click(trigger)
    // `all sessions` always equals the number beside the ACTIVE heading.
    expect(screen.getByRole('option', { name: /all sessions/ })).toHaveTextContent('3')
    expect(screen.getByRole('option', { name: /started in orbital/ })).toHaveTextContent('2')
    expect(screen.getByRole('option', { name: /other terminals/ })).toHaveTextContent('1')

    await user.click(screen.getByRole('option', { name: /other terminals/ }))
    expect(triggerLabel()).toBe('read-only')
  })

  it('narrows the visible list when a tag chip is clicked', async () => {
    const user = userEvent.setup()
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Work session', status: 'idle', tagIds: [1] }),
        b: makeSession({ id: 'b', title: 'Personal session', status: 'idle', tagIds: [2] }),
      },
    })

    render(<Sidebar observerFactory={noopObserverFactory} />)

    expect(screen.getByText('Work session')).toBeInTheDocument()
    expect(screen.getByText('Personal session')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'work' }))

    expect(screen.getByText('Work session')).toBeInTheDocument()
    expect(screen.queryByText('Personal session')).not.toBeInTheDocument()

    expect(useOrbital.getState().ui.filterTagId).toBe(1)
  })

  it('narrows the visible list as the user types into search', async () => {
    const user = userEvent.setup()
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Alpha session', status: 'idle' }),
        b: makeSession({ id: 'b', title: 'Beta session', status: 'idle' }),
      },
    })

    render(<Sidebar observerFactory={noopObserverFactory} />)

    const search = screen.getByRole('searchbox', { name: /search sessions/i })
    await user.type(search, 'Alpha')

    expect(screen.getByText('Alpha session')).toBeInTheDocument()
    expect(screen.queryByText('Beta session')).not.toBeInTheDocument()
  })

  it('calls select(id) when a row is clicked', async () => {
    const user = userEvent.setup()
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Alpha session', status: 'idle' }),
      },
    })
    vi.mocked(api.getMessages).mockResolvedValue([])
    const selectSpy = vi.spyOn(useOrbital.getState(), 'select')

    render(<Sidebar observerFactory={noopObserverFactory} />)
    await user.click(screen.getByText('Alpha session'))

    expect(selectSpy).toHaveBeenCalledWith('a')
  })

  it('renders the footer with the visible session count', () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Alpha', status: 'idle' }),
        b: makeSession({ id: 'b', title: 'Beta', status: 'ended' }),
      },
    })

    render(<Sidebar observerFactory={noopObserverFactory} />)

    expect(screen.getByText(/2 sessions/)).toBeInTheDocument()
    // Canvas 1a's footer is the session count and SETTINGS — the old
    // "tags & rules ›" link is gone, that screen is a Settings section now.
    expect(screen.getByText('SETTINGS')).toBeInTheDocument()
    expect(screen.queryByText(/tags & rules/i)).not.toBeInTheDocument()
  })

  // 1a puts a settings button in both layers — the footer pill and the
  // collapsed rail's icon — so it stays reachable whichever state the
  // sidebar is in.
  it('opens settings from the footer and from the collapsed rail', async () => {
    const user = userEvent.setup()
    resetStore({ sessions: {} })

    render(<Sidebar observerFactory={noopObserverFactory} />)
    const entries = screen.getAllByRole('button', { name: /settings/i })
    expect(entries).toHaveLength(2)

    for (const entry of entries) {
      act(() => {
        useOrbital.setState((s) => ({ ui: { ...s.ui, dialog: null } }))
      })
      await user.click(entry)
      expect(useOrbital.getState().ui.dialog).toBe('settings')
    }
  })

  // 1a splits the two lists visually: active rows sit at 9px vertical with a
  // semibold title, history rows tighten to 8px and drop to medium.
  it('renders history rows tighter and lighter than active rows', () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Alpha', status: 'idle' }),
        b: makeSession({ id: 'b', title: 'Beta', status: 'ended' }),
      },
    })

    render(<Sidebar observerFactory={noopObserverFactory} />)

    const activeRow = screen.getByRole('button', { name: /Alpha/ })
    const historyRow = screen.getByRole('button', { name: /Beta/ })
    expect(activeRow.className).toMatch(/py-\[9px\]/)
    expect(historyRow.className).toMatch(/py-2/)
    expect(within(activeRow).getByText('Alpha').className).toMatch(/font-semibold/)
    expect(within(historyRow).getByText('Beta').className).toMatch(/font-medium/)
  })

  it('toggles sidebarCollapsed via the collapse button', async () => {
    const user = userEvent.setup()
    resetStore({ sessions: {} })

    render(<Sidebar observerFactory={noopObserverFactory} />)
    await user.click(screen.getByRole('button', { name: /collapse sidebar/i }))

    expect(useOrbital.getState().ui.sidebarCollapsed).toBe(true)
  })

  it('fetches the next page and appends sessions when the sentinel intersects', async () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Alpha', status: 'ended', lastAt: 1 }),
      },
    })
    const nextPage = [makeSession({ id: 'b', title: 'Bravo', status: 'ended', lastAt: 2 })]
    vi.mocked(api.listSessions).mockResolvedValue(nextPage)

    const { factory, trigger } = makeCapturingObserverFactory()
    render(<Sidebar observerFactory={factory} />)

    await act(async () => {
      trigger()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.listSessions).toHaveBeenCalledWith(expect.objectContaining({ offset: 1 }))
    expect(await screen.findByText('Bravo')).toBeInTheDocument()
  })

  it('passes the active tag filter and the filtered-count offset to the next page fetch', async () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Alpha', status: 'ended', tagIds: [1], lastAt: 1 }),
        b: makeSession({ id: 'b', title: 'Bravo', status: 'ended', tagIds: [1], lastAt: 2 }),
        c: makeSession({ id: 'c', title: 'Charlie', status: 'ended', tagIds: [2], lastAt: 3 }),
      },
      ui: { filterTagId: 1 },
    })
    vi.mocked(api.listSessions).mockResolvedValue([])

    const { factory, trigger } = makeCapturingObserverFactory()
    render(<Sidebar observerFactory={factory} />)

    // Only 'a' and 'b' match filterTagId 1 — 'c' (tag 2) is excluded from
    // the store-side visible count, which must be the offset cursor since
    // the server applies the same tag filter before slicing by offset.
    await act(async () => {
      trigger()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 2, tag: 1 })
    )
  })

  it('passes the active search filter and its filtered-count offset to the next page fetch', async () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Alpha session', status: 'ended', lastAt: 1 }),
        b: makeSession({ id: 'b', title: 'Beta session', status: 'ended', lastAt: 2 }),
      },
      ui: { search: 'Alpha' },
    })
    vi.mocked(api.listSessions).mockResolvedValue([])

    const { factory, trigger } = makeCapturingObserverFactory()
    render(<Sidebar observerFactory={factory} />)

    await act(async () => {
      trigger()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(api.listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 1, q: 'Alpha' })
    )
  })

  // Paging covers HISTORY too, and HISTORY is not origin-scoped — a server
  // -side origin filter would drop history rows before they could be shown.
  it('never sends the origin filter to the next page fetch', async () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Alpha', status: 'ended', source: 'web', lastAt: 1 }),
        b: makeSession({ id: 'b', title: 'Bravo', status: 'ended', source: 'terminal', lastAt: 2 }),
      },
      ui: { sourceFilter: 'terminal' },
    })
    vi.mocked(api.listSessions).mockResolvedValue([])

    const { factory, trigger } = makeCapturingObserverFactory()
    render(<Sidebar observerFactory={factory} />)

    await act(async () => {
      trigger()
      await Promise.resolve()
      await Promise.resolve()
    })

    const params = vi.mocked(api.listSessions).mock.calls[0][0]
    expect(params).not.toHaveProperty('source', 'terminal')
    // The cursor counts every row the list holds, history included.
    expect(params).toMatchObject({ offset: 2 })
  })

  it('re-arms pagination (resets end-of-list) when the active filter changes', async () => {
    const user = userEvent.setup()
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', title: 'Alpha', status: 'ended', tagIds: [1], lastAt: 1 }),
      },
    })
    // First page comes back empty -> Sidebar marks the list exhausted for
    // the current (no-op) filter and stops observing.
    vi.mocked(api.listSessions).mockResolvedValue([])

    const { factory, trigger } = makeCapturingObserverFactory()
    render(<Sidebar observerFactory={factory} />)

    await act(async () => {
      trigger()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.listSessions).toHaveBeenCalledTimes(1)

    // Switching the tag filter must re-arm pagination even though the
    // previous filter combination had already reached its end.
    await user.click(screen.getByRole('button', { name: 'work' }))

    await act(async () => {
      trigger()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.listSessions).toHaveBeenCalledTimes(2)
    expect(api.listSessions).toHaveBeenLastCalledWith(expect.objectContaining({ tag: 1 }))
  })

  it('⌘K focuses the search input', () => {
    resetStore({ sessions: {} })
    render(<Sidebar observerFactory={noopObserverFactory} />)

    const search = screen.getByRole('searchbox', { name: /search sessions/i })
    expect(search).not.toHaveFocus()

    const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(event)

    expect(search).toHaveFocus()
  })
})
