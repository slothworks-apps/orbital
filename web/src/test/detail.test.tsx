import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ApiSession, Tag } from '../lib/types'
import { useOrbital, type OrbitalState, type OrbitalUiState } from '../store/store'

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
import { DetailPanel } from '../panels/DetailPanel'

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
  useOrbital.setState({
    sessions: {},
    order: [],
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

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getSession).mockResolvedValue({
    session: makeSession({ id: 'unused' }),
    lineage: [],
  })
})

// ---------------------------------------------------------------------------
// Header: title, cwd, tags, badges, usage
// ---------------------------------------------------------------------------

describe('DetailPanel header', () => {
  it('renders nothing when no session is selected', () => {
    resetStore()
    const { container } = render(<DetailPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows title, cwd, permission mode and status badges for the selected session', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', title: 'My session', status: 'working', permissionMode: 'plan' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    expect(screen.getByDisplayValue('My session')).toBeInTheDocument()
    expect(screen.getByText(/orbital/)).toBeInTheDocument() // shortened cwd
    expect(screen.getByText(/PLAN/)).toBeInTheDocument()
    expect(screen.getByText(/WORKING/)).toBeInTheDocument()
  })

  it('renders output_tokens from usage[id] when present', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a' }) },
      usage: { a: { output_tokens: 4242 } },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    expect(screen.getByText(/4242/)).toBeInTheDocument()
  })

  it('renames the session on Enter, updating the store optimistically and firing the API', async () => {
    const user = userEvent.setup()
    vi.mocked(api.renameSession).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', title: 'Old title' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    const titleInput = screen.getByDisplayValue('Old title')
    await user.clear(titleInput)
    await user.type(titleInput, 'New title{Enter}')

    expect(api.renameSession).toHaveBeenCalledWith('a', 'New title')
    // Optimistic: the store already reflects the new title.
    expect(useOrbital.getState().sessions.a.title).toBe('New title')
  })

  it('renames the session on blur', async () => {
    const user = userEvent.setup()
    vi.mocked(api.renameSession).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', title: 'Old title' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    const titleInput = screen.getByDisplayValue('Old title')
    await user.clear(titleInput)
    await user.type(titleInput, 'Blurred title')
    fireEvent.blur(titleInput)

    expect(api.renameSession).toHaveBeenCalledWith('a', 'Blurred title')
    expect(useOrbital.getState().sessions.a.title).toBe('Blurred title')
  })

  it('toggles tag membership on click, updating the store optimistically and calling setSessionTags', async () => {
    const user = userEvent.setup()
    vi.mocked(api.setSessionTags).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', tagIds: [1] }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    // 'work' (id 1) is already active -> click removes it.
    await user.click(screen.getByRole('button', { name: 'work' }))
    expect(api.setSessionTags).toHaveBeenCalledWith('a', [])
    expect(useOrbital.getState().sessions.a.tagIds).toEqual([])

    // 'personal' (id 2) is inactive -> click adds it.
    await user.click(screen.getByRole('button', { name: 'personal' }))
    expect(api.setSessionTags).toHaveBeenCalledWith('a', [2])
    expect(useOrbital.getState().sessions.a.tagIds).toEqual([2])
  })

  it('shows a subagents strip with name and state when any are present', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a' }) },
      subagents: { a: [{ id: 's1', name: 'researcher', state: 'working' }] },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    expect(screen.getByText(/researcher/)).toBeInTheDocument()
  })

  it('shows lineage dots when getSession resolves a non-empty lineage', async () => {
    vi.mocked(api.getSession).mockResolvedValue({
      session: makeSession({ id: 'a' }),
      lineage: ['root', 'mid'],
    })
    resetStore({
      sessions: { a: makeSession({ id: 'a' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    await waitFor(() => {
      expect(screen.getByLabelText(/lineage/i)).toBeInTheDocument()
    })
  })

  it('does not show lineage dots when lineage is empty', async () => {
    vi.mocked(api.getSession).mockResolvedValue({
      session: makeSession({ id: 'a' }),
      lineage: [],
    })
    resetStore({
      sessions: { a: makeSession({ id: 'a' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    await waitFor(() => expect(api.getSession).toHaveBeenCalled())
    expect(screen.queryByLabelText(/lineage/i)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Footer: prompt / send / stop, terminal read-only
// ---------------------------------------------------------------------------

describe('DetailPanel footer', () => {
  it('sends the prompt on Send click, calling sendPrompt with the trimmed text', async () => {
    const user = userEvent.setup()
    vi.mocked(api.sendMessage).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })
    const sendSpy = vi.spyOn(useOrbital.getState(), 'sendPrompt')

    render(<DetailPanel />)
    const textbox = screen.getByRole('textbox', { name: /prompt/i })
    await user.type(textbox, 'hello there')
    await user.click(screen.getByRole('button', { name: /send/i }))

    expect(sendSpy).toHaveBeenCalledWith('a', 'hello there')
  })

  it('sends on Enter and inserts a newline on Shift+Enter instead of sending', async () => {
    const user = userEvent.setup()
    vi.mocked(api.sendMessage).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })
    const sendSpy = vi.spyOn(useOrbital.getState(), 'sendPrompt')

    render(<DetailPanel />)
    const textbox = screen.getByRole('textbox', { name: /prompt/i }) as HTMLTextAreaElement
    await user.type(textbox, 'line one')
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })
    expect(sendSpy).not.toHaveBeenCalled()

    fireEvent.keyDown(textbox, { key: 'Enter' })
    expect(sendSpy).toHaveBeenCalledWith('a', 'line one')
  })

  it('appends an optimistic user message to the transcript when sending (via the real store action)', async () => {
    const user = userEvent.setup()
    vi.mocked(api.sendMessage).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    const textbox = screen.getByRole('textbox', { name: /prompt/i })
    await user.type(textbox, 'optimistic ping')
    await user.click(screen.getByRole('button', { name: /send/i }))

    expect(await screen.findByText('optimistic ping')).toBeInTheDocument()
  })

  it('shows a Stop button while working, which opens StopDialog rather than calling interrupt directly', async () => {
    const user = userEvent.setup()
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'working' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('button', { name: /^stop$/i }))

    expect(api.interrupt).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: /stop the running turn/i })).toBeInTheDocument()
    expect(useOrbital.getState().ui.dialog).toBe('stop')
  })

  it('does not show a Stop button when not working', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /^stop$/i })).not.toBeInTheDocument()
  })

  it('shows a read-only bar with no input for a live terminal session', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'terminal', status: 'working' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    expect(screen.getByText(/runs in terminal.*read-only/i)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /prompt/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument()
  })

  it('shows the prompt footer (not the read-only bar) for an ended terminal session', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'terminal', status: 'ended' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    expect(screen.getByRole('textbox', { name: /prompt/i })).toBeInTheDocument()
    expect(screen.queryByText(/runs in terminal/i)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Clear flow
// ---------------------------------------------------------------------------

describe('DetailPanel clear flow', () => {
  it('shows the Clear button only for web-sourced sessions', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'terminal' }) },
      ui: { selectedId: 'a' },
    })
    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /^clear$/i })).not.toBeInTheDocument()
  })

  it('opens ClearDialog when confirm_before_clear is not false', async () => {
    const user = userEvent.setup()
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('button', { name: /^clear$/i }))

    expect(api.clearSession).not.toHaveBeenCalled()
    expect(useOrbital.getState().ui.dialog).toBe('clear')
    expect(screen.getByRole('dialog', { name: /clear and start a new session/i })).toBeInTheDocument()
  })

  it('skips the dialog and clears directly when confirm_before_clear is "false"', async () => {
    const user = userEvent.setup()
    vi.mocked(api.clearSession).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      settings: { confirm_before_clear: 'false' },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('button', { name: /^clear$/i }))

    expect(api.clearSession).toHaveBeenCalledWith('a', false)
    expect(useOrbital.getState().ui.dialog).toBe(null)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('"Clear only" calls clearSession with startNew=false and does not change selection', async () => {
    const user = userEvent.setup()
    vi.mocked(api.clearSession).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      ui: { selectedId: 'a', dialog: 'clear' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('button', { name: /clear only/i }))

    await waitFor(() => expect(api.clearSession).toHaveBeenCalledWith('a', false))
    expect(useOrbital.getState().ui.selectedId).toBe('a')
    expect(useOrbital.getState().ui.dialog).toBe(null)
  })

  it('"Clear & start new" calls clearSession with startNew=true and selects the returned sessionId', async () => {
    const user = userEvent.setup()
    vi.mocked(api.clearSession).mockResolvedValue({ ok: true, sessionId: 'b' })
    vi.mocked(api.getMessages).mockResolvedValue([])
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', source: 'web' }),
        b: makeSession({ id: 'b', source: 'web' }),
      },
      ui: { selectedId: 'a', dialog: 'clear' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('button', { name: /clear & start new/i }))

    await waitFor(() => expect(api.clearSession).toHaveBeenCalledWith('a', true))
    await waitFor(() => expect(useOrbital.getState().ui.selectedId).toBe('b'))
    expect(useOrbital.getState().ui.dialog).toBe(null)
  })

  it('"Don\'t ask again" patches confirm_before_clear to "false"', async () => {
    const user = userEvent.setup()
    vi.mocked(api.clearSession).mockResolvedValue({ ok: true })
    vi.mocked(api.patchSettings).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      ui: { selectedId: 'a', dialog: 'clear' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('checkbox', { name: /don't ask again/i }))
    await user.click(screen.getByRole('button', { name: /clear only/i }))

    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ confirm_before_clear: 'false' }))
    expect(useOrbital.getState().settings.confirm_before_clear).toBe('false')
  })

  it('closes ClearDialog on Escape without clearing', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      ui: { selectedId: 'a', dialog: 'clear' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(api.clearSession).not.toHaveBeenCalled()
    expect(useOrbital.getState().ui.dialog).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Stop flow (dialog interaction)
// ---------------------------------------------------------------------------

describe('DetailPanel stop flow', () => {
  it('calls interrupt only after confirming "Stop turn", not on open or Cancel', async () => {
    const user = userEvent.setup()
    vi.mocked(api.interrupt).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'working' }) },
      ui: { selectedId: 'a', dialog: 'stop' },
    })

    render(<DetailPanel />)
    expect(api.interrupt).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /keep running/i }))
    expect(api.interrupt).not.toHaveBeenCalled()
    expect(useOrbital.getState().ui.dialog).toBe(null)
  })

  it('confirming "Stop turn" calls interrupt and closes the dialog', async () => {
    const user = userEvent.setup()
    vi.mocked(api.interrupt).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'working' }) },
      ui: { selectedId: 'a', dialog: 'stop' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('button', { name: /stop turn/i }))

    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith('a'))
    expect(useOrbital.getState().ui.dialog).toBe(null)
  })

  it('closes StopDialog on Escape without interrupting', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'working' }) },
      ui: { selectedId: 'a', dialog: 'stop' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(api.interrupt).not.toHaveBeenCalled()
    expect(useOrbital.getState().ui.dialog).toBe(null)
  })
})
