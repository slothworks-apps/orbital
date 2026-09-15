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
    parentId: null,
    tagIds: [],
    status: 'idle',
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
    subagents: {},
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

    await user.click(screen.getByRole('button', { name: 'work 1' }))

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

    const search = screen.getByRole('textbox', { name: /search sessions/i })
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
    expect(screen.getByText(/tags & rules/i)).toBeInTheDocument()
  })

  it('opens the tags & rules dialog from the footer', async () => {
    const user = userEvent.setup()
    resetStore({ sessions: {} })

    render(<Sidebar observerFactory={noopObserverFactory} />)
    await user.click(screen.getByRole('button', { name: /tags & rules/i }))

    expect(useOrbital.getState().ui.dialog).toBe('tags')
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
    await user.click(screen.getByRole('button', { name: 'work 1' }))

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

    const search = screen.getByRole('textbox', { name: /search sessions/i })
    expect(search).not.toHaveFocus()

    const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })
    window.dispatchEvent(event)

    expect(search).toHaveFocus()
  })
})
