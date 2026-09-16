import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import type { ApiSession } from '../lib/types'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ApiError: actual.ApiError,
    api: {
      ...actual.api,
      getSession: vi.fn(),
      getMessages: vi.fn(),
      listSessions: vi.fn(),
    },
  }
})

import { api } from '../lib/api'
import { useOrbital } from '../store/store'
import { readSessionParam, withSessionParam, useSessionUrl, SESSION_PARAM } from '../lib/sessionUrl'

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

/** Mounts just the hook, with `ready` already true unless a test says otherwise. */
function Probe({ ready = true }: { ready?: boolean }) {
  useSessionUrl(ready)
  return null
}

function url(): string {
  return window.location.search
}

function goTo(search: string): void {
  window.history.replaceState(null, '', `/${search}`)
}

function setSessions(sessions: ApiSession[]): void {
  const map: Record<string, ApiSession> = {}
  for (const s of sessions) map[s.id] = s
  useOrbital.setState({ sessions: map, order: sessions.map((s) => s.id) })
}

beforeEach(() => {
  vi.clearAllMocks()
  goTo('')
  useOrbital.setState({
    sessions: {},
    order: [],
    transcripts: {},
    historyLoaded: {},
    ui: { ...useOrbital.getState().ui, selectedId: null },
  })
  vi.mocked(api.getMessages).mockResolvedValue([])
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('session URL helpers', () => {
  it('reads the session id out of the query string', () => {
    expect(readSessionParam('http://x/?session=abc')).toBe('abc')
    expect(readSessionParam('http://x/')).toBeNull()
  })

  it('treats an empty parameter as no selection', () => {
    expect(readSessionParam('http://x/?session=')).toBeNull()
  })

  it('sets and clears the parameter, leaving everything else alone', () => {
    const base = 'http://x/app?tab=map&q=hello#frag'
    expect(withSessionParam('abc', base)).toBe(`/app?tab=map&q=hello&${SESSION_PARAM}=abc#frag`)
    expect(withSessionParam(null, `http://x/app?${SESSION_PARAM}=abc&tab=map`)).toBe('/app?tab=map')
  })

  it('replaces an existing id rather than appending a second one', () => {
    expect(withSessionParam('new', `http://x/?${SESSION_PARAM}=old`)).toBe(`/?${SESSION_PARAM}=new`)
  })
})

// ---------------------------------------------------------------------------
// useSessionUrl
// ---------------------------------------------------------------------------

describe('useSessionUrl', () => {
  it('restores the selection named by the URL on mount', async () => {
    setSessions([makeSession({ id: 'a' })])
    goTo('?session=a')

    render(<Probe />)

    await waitFor(() => expect(useOrbital.getState().ui.selectedId).toBe('a'))
    // The restore is the entry the user landed on, not a step they took.
    expect(url()).toBe('?session=a')
    expect(api.getSession).not.toHaveBeenCalled()
  })

  it('fetches a session the initial page did not include, then selects it', async () => {
    const session = makeSession({ id: 'old' })
    vi.mocked(api.getSession).mockResolvedValue({ session, lineage: [] })
    goTo('?session=old')

    render(<Probe />)

    await waitFor(() => expect(useOrbital.getState().ui.selectedId).toBe('old'))
    expect(api.getSession).toHaveBeenCalledWith('old')
    // And it is in the store, so the detail panel has something to render.
    expect(useOrbital.getState().sessions.old).toEqual(session)
  })

  it('drops a link to a session the server no longer knows, selecting nothing', async () => {
    vi.mocked(api.getSession).mockRejectedValue(new Error('404'))
    goTo('?session=gone')

    render(<Probe />)

    await waitFor(() => expect(url()).toBe(''))
    expect(useOrbital.getState().ui.selectedId).toBeNull()
  })

  it('waits for the initial load before restoring', async () => {
    setSessions([makeSession({ id: 'a' })])
    goTo('?session=a')

    const { rerender } = render(<Probe ready={false} />)
    await Promise.resolve()
    expect(useOrbital.getState().ui.selectedId).toBeNull()
    expect(api.getSession).not.toHaveBeenCalled()

    rerender(<Probe ready />)
    await waitFor(() => expect(useOrbital.getState().ui.selectedId).toBe('a'))
  })

  it('never pushes the restored id back out of the URL', async () => {
    const session = makeSession({ id: 'slow' })
    let resolveFetch: (value: { session: ApiSession; lineage: string[] }) => void = () => {}
    vi.mocked(api.getSession).mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      })
    )
    goTo('?session=slow')

    render(<Probe />)
    // The selection is still null here — the mirror must not read that as a
    // deselection while the restore is in flight.
    await act(async () => {
      resolveFetch({ session, lineage: [] })
    })

    await waitFor(() => expect(useOrbital.getState().ui.selectedId).toBe('slow'))
    expect(url()).toBe('?session=slow')
  })

  it('pushes each selection change into history', async () => {
    setSessions([makeSession({ id: 'a' }), makeSession({ id: 'b' })])
    render(<Probe />)
    await waitFor(() => expect(url()).toBe(''))

    await act(async () => {
      await useOrbital.getState().select('a')
    })
    expect(url()).toBe('?session=a')

    await act(async () => {
      await useOrbital.getState().select('b')
    })
    expect(url()).toBe('?session=b')
  })

  it('clears the parameter when the selection is dropped', async () => {
    setSessions([makeSession({ id: 'a' })])
    goTo('?session=a')
    render(<Probe />)
    await waitFor(() => expect(useOrbital.getState().ui.selectedId).toBe('a'))

    act(() => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null } }))
    })

    expect(url()).toBe('')
  })

  it('follows Back and Forward', async () => {
    setSessions([makeSession({ id: 'a' })])
    render(<Probe />)
    await waitFor(() => expect(url()).toBe(''))

    await act(async () => {
      await useOrbital.getState().select('a')
    })
    expect(url()).toBe('?session=a')

    // jsdom updates the URL on history.back() but fires popstate only on the
    // next task, so the event is what the hook actually listens for.
    await act(async () => {
      goTo('')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(useOrbital.getState().ui.selectedId).toBeNull()
    // Following the URL must not push a new entry of its own.
    expect(url()).toBe('')

    await act(async () => {
      goTo('?session=a')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await waitFor(() => expect(useOrbital.getState().ui.selectedId).toBe('a'))
    expect(url()).toBe('?session=a')
  })
})
