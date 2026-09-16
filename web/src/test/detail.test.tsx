import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react'
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
  hideEnded: false,
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
    expect(screen.getByText('plan')).toBeInTheDocument()
    expect(screen.getByText(/WORKING/)).toBeInTheDocument()
  })

  it('renders the INPUT/OUTPUT/CACHE READ grid and a context-usage bar from turn_result usage, including cache creation tokens', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a' }) },
      // 1000 + 500 + 6000 + 2242 = 9742 tokens -> round(9742 / 200_000 * 100) = 5%
      usage: {
        a: {
          input_tokens: 1000,
          cache_read_input_tokens: 500,
          cache_creation_input_tokens: 6000,
          output_tokens: 2242,
        },
      },
      ui: { selectedId: 'a' },
    })

    const { container } = render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    // Canvas 1b's compact notation ("142.3k"), not raw counts.
    const grid = container.querySelector('[data-usage-grid]')!
    expect(grid).toHaveAttribute('data-empty', 'false')
    expect(within(grid as HTMLElement).getByText('INPUT').nextElementSibling).toHaveTextContent('1k')
    expect(within(grid as HTMLElement).getByText('OUTPUT').nextElementSibling).toHaveTextContent('2.2k')
    expect(within(grid as HTMLElement).getByText('CACHE READ').nextElementSibling).toHaveTextContent('500')

    // Cache-creation tokens count towards the context read-out even though
    // they have no cell of their own.
    expect(container.querySelector('[data-context-readout]')).toHaveTextContent('9.7k / 200k ctx')
    const bar = screen.getByRole('progressbar', { name: /context usage/i })
    expect(bar).toHaveAttribute('aria-valuenow', '5')
  })

  it('keeps the usage grid in place with em-dash placeholders (and no progressbar) when there is no usage yet', async () => {
    resetStore({
      // A terminal session never reports turn_result usage at all — the
      // block must still hold its place rather than vanish.
      sessions: { a: makeSession({ id: 'a', source: 'terminal' }) },
      ui: { selectedId: 'a' },
    })

    const { container } = render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    const grid = container.querySelector('[data-usage-grid]')
    expect(grid).toBeInTheDocument()
    expect(grid).toHaveAttribute('data-empty', 'true')
    for (const label of ['INPUT', 'OUTPUT', 'CACHE READ']) {
      expect(within(grid as HTMLElement).getByText(label).nextElementSibling).toHaveTextContent('—')
    }
    expect(container.querySelector('[data-context-readout]')).toHaveTextContent('— / 200k ctx')
    // No value to report -> an empty track, not a progressbar claiming 0%.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('sizes the title field to its own value, so the dashed rule hugs the title (canvas 1b)', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', title: 'auth-refactor' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    // 1b: `width:13ch` for the 13-character "auth-refactor" (+1 for the caret).
    expect(screen.getByDisplayValue('auth-refactor')).toHaveStyle({ width: '14ch' })
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

  it('rolls back the optimistic rename and shows a toast when renameSession rejects', async () => {
    const user = userEvent.setup()
    vi.mocked(api.renameSession).mockRejectedValue(new Error('server exploded'))
    resetStore({
      sessions: { a: makeSession({ id: 'a', title: 'Old title' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    const titleInput = screen.getByDisplayValue('Old title')
    await user.clear(titleInput)
    await user.type(titleInput, 'Rejected title{Enter}')

    await waitFor(() => expect(useOrbital.getState().sessions.a.title).toBe('Old title'))
    expect(screen.getByDisplayValue('Old title')).toBeInTheDocument()
    expect(useOrbital.getState().toast).toMatchObject({ kind: 'error', message: 'server exploded' })
  })

  it('does not wipe an in-progress prompt draft when the title is renamed (C1 regression)', async () => {
    const user = userEvent.setup()
    vi.mocked(api.renameSession).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', title: 'Old title', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    const promptBox = screen.getByRole('textbox', { name: /prompt/i })
    await user.type(promptBox, 'a prompt in progress')

    const titleInput = screen.getByDisplayValue('Old title')
    await user.clear(titleInput)
    await user.type(titleInput, 'New title{Enter}')

    await waitFor(() => expect(useOrbital.getState().sessions.a.title).toBe('New title'))
    expect(promptBox).toHaveValue('a prompt in progress')
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

  it('rolls back the optimistic tag toggle and shows a toast when setSessionTags rejects', async () => {
    const user = userEvent.setup()
    vi.mocked(api.setSessionTags).mockRejectedValue(new Error('tags server down'))
    resetStore({
      sessions: { a: makeSession({ id: 'a', tagIds: [1] }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('button', { name: 'work' }))

    await waitFor(() => expect(useOrbital.getState().sessions.a.tagIds).toEqual([1]))
    expect(useOrbital.getState().toast).toMatchObject({ kind: 'error', message: 'tags server down' })
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

  it('shows a "Continue conversation…" placeholder for an ended session (C4)', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'ended' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    expect(screen.getByRole('textbox', { name: /prompt/i })).toHaveAttribute(
      'placeholder',
      'Continue conversation…'
    )
  })

  it('shows a generic "Send a message…" placeholder for a non-ended session', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    expect(screen.getByRole('textbox', { name: /prompt/i })).toHaveAttribute(
      'placeholder',
      'Send a message…'
    )
  })

  it('shows the ⏎ send · ⇧⏎ newline key hint beside the composer actions (canvas 1b)', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    expect(screen.getByText('⏎ send · ⇧⏎ newline')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send/i })).toHaveTextContent('Send ↑')
  })

  it('hides the composer key hint for a live terminal session (no composer to drive)', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'terminal', status: 'working' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    expect(screen.queryByText('⏎ send · ⇧⏎ newline')).not.toBeInTheDocument()
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
    const clearDialog = screen.getByRole('dialog', { name: /clear and start a new session/i })
    expect(clearDialog).toBeInTheDocument()
    // Spec uses lowercase "/clear", not "/CLEAR" — rendered as the dialog eyebrow.
    expect(clearDialog).toHaveAccessibleName('Clear and start a new session?')
    expect(within(clearDialog).getByText('/clear')).toBeInTheDocument()
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

  it('shows a toast and keeps the dialog open when clearSession rejects (I6)', async () => {
    const user = userEvent.setup()
    vi.mocked(api.clearSession).mockRejectedValue(new Error('clear failed'))
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      ui: { selectedId: 'a', dialog: 'clear' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('button', { name: /clear only/i }))

    await waitFor(() =>
      expect(useOrbital.getState().toast).toMatchObject({ kind: 'error', message: 'clear failed' })
    )
    expect(useOrbital.getState().ui.dialog).toBe('clear')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('does not persist confirm_before_clear and still reports a toast when patchSettings rejects (I7)', async () => {
    const user = userEvent.setup()
    vi.mocked(api.clearSession).mockResolvedValue({ ok: true })
    vi.mocked(api.patchSettings).mockRejectedValue(new Error('settings unreachable'))
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      ui: { selectedId: 'a', dialog: 'clear' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('checkbox', { name: /don't ask again/i }))
    await user.click(screen.getByRole('button', { name: /clear only/i }))

    await waitFor(() =>
      expect(useOrbital.getState().toast).toMatchObject({ kind: 'error', message: 'settings unreachable' })
    )
    // The rejected PATCH must never leave the store claiming the preference stuck.
    expect(useOrbital.getState().settings.confirm_before_clear).toBeUndefined()
    // The clear itself still proceeds even though the preference failed to save.
    expect(api.clearSession).toHaveBeenCalledWith('a', false)
  })

  it('invalidates the cached lineage for a session after clearing it, so it refetches', async () => {
    const user = userEvent.setup()
    vi.mocked(api.clearSession).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      ui: { selectedId: 'a', dialog: 'clear' },
    })

    render(<DetailPanel />)
    // Initial lineage fetch (DetailPanel's header effect + ClearDialog's own preview fetch).
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())
    const callsBeforeClear = vi.mocked(api.getSession).mock.calls.length

    await user.click(screen.getByRole('button', { name: /clear only/i }))
    await waitFor(() => expect(api.clearSession).toHaveBeenCalledWith('a', false))

    // Selection is unchanged (clear-only) and the cache entry for 'a' was
    // dropped, so DetailPanel's lineage effect must refire for the same id.
    await waitFor(() =>
      expect(vi.mocked(api.getSession).mock.calls.length).toBeGreaterThan(callsBeforeClear)
    )
  })

  it('acts on the session the dialog was opened for even if the selection changes while it is open', async () => {
    const user = userEvent.setup()
    vi.mocked(api.clearSession).mockResolvedValue({ ok: true })
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', source: 'web' }),
        b: makeSession({ id: 'b', source: 'web' }),
      },
      ui: { selectedId: 'a', dialog: 'clear' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    // Selection changes elsewhere (e.g. a sidebar click) while the dialog
    // the user opened for 'a' is still open.
    await act(async () => {
      useOrbital.setState((state) => ({ ui: { ...state.ui, selectedId: 'b' } }))
      await Promise.resolve()
    })

    await user.click(screen.getByRole('button', { name: /clear only/i }))

    expect(api.clearSession).toHaveBeenCalledWith('a', false)
    expect(api.clearSession).not.toHaveBeenCalledWith('b', expect.anything())
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

  it('shows a toast and keeps the dialog open (does not close as-if-success) when interrupt rejects (I6)', async () => {
    const user = userEvent.setup()
    vi.mocked(api.interrupt).mockRejectedValue(new Error('interrupt failed'))
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'working' }) },
      ui: { selectedId: 'a', dialog: 'stop' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('button', { name: /stop turn/i }))

    await waitFor(() =>
      expect(useOrbital.getState().toast).toMatchObject({ kind: 'error', message: 'interrupt failed' })
    )
    expect(useOrbital.getState().ui.dialog).toBe('stop')
    expect(screen.getByRole('dialog', { name: /stop the running turn/i })).toBeInTheDocument()
  })

  it('disables "Stop turn" while the interrupt request is in flight', async () => {
    const user = userEvent.setup()
    let resolveInterrupt!: (v: { ok: boolean }) => void
    vi.mocked(api.interrupt).mockReturnValue(
      new Promise((resolve) => {
        resolveInterrupt = resolve
      })
    )
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'working' }) },
      ui: { selectedId: 'a', dialog: 'stop' },
    })

    render(<DetailPanel />)
    const stopTurnButton = screen.getByRole('button', { name: /stop turn/i })
    await user.click(stopTurnButton)

    expect(stopTurnButton).toBeDisabled()

    resolveInterrupt({ ok: true })
    await waitFor(() => expect(useOrbital.getState().ui.dialog).toBe(null))
  })

  it('shows the tool call currently mid-edit in the dialog (C3)', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'working' }) },
      transcripts: {
        a: [
          { id: '1', role: 'user', text: 'run the tests' },
          {
            id: '2',
            role: 'tool_use',
            toolName: 'Bash',
            toolInput: { command: 'npm test' },
            toolUseId: 'tu1',
          },
        ],
      },
      ui: { selectedId: 'a', dialog: 'stop' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    const dialog = screen.getByRole('dialog', { name: /stop the running turn/i })
    // The dialog's mid-edit row splits the dim tool name from the bright
    // argument (canvas 1b), so it is asserted on the row, not one text node.
    const row = within(dialog).getByText(/^Bash/).closest('div')!
    expect(row).toHaveTextContent('Bash: npm test')
    expect(within(row).getByText('running')).toBeInTheDocument()
  })

  it('does not show a mid-edit tool row when nothing is running', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'working' }) },
      transcripts: {
        a: [
          {
            id: '2',
            role: 'tool_use',
            toolName: 'Bash',
            toolInput: { command: 'npm test' },
            toolUseId: 'tu1',
          },
          { id: '3', role: 'tool_result', toolUseId: 'tu1', text: 'PASS' },
        ],
      },
      ui: { selectedId: 'a', dialog: 'stop' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())

    const dialog = screen.getByRole('dialog', { name: /stop the running turn/i })
    expect(within(dialog).queryByText(/^Bash/)).not.toBeInTheDocument()
  })

  it('acts on the session the dialog was opened for even if the selection changes while it is open', async () => {
    const user = userEvent.setup()
    vi.mocked(api.interrupt).mockResolvedValue({ ok: true })
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', source: 'web', status: 'working' }),
        b: makeSession({ id: 'b', source: 'web', status: 'working' }),
      },
      ui: { selectedId: 'a', dialog: 'stop' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.getSession).toHaveBeenCalled())
    await act(async () => {
      useOrbital.setState((state) => ({ ui: { ...state.ui, selectedId: 'b' } }))
      await Promise.resolve()
    })

    await user.click(screen.getByRole('button', { name: /stop turn/i }))

    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith('a'))
    expect(api.interrupt).not.toHaveBeenCalledWith('b')
  })
})
