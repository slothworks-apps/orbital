import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ApiSession, BackgroundTask, ChatMessage, Subagent } from '../lib/types'
import { useOrbital, type OrbitalUiState } from '../store/store'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api, ApiError } from '../lib/api'
import { DetailPanel } from '../panels/DetailPanel'
import { groupToolRuns, insertModelDividers, pairMessages, rewindCountFrom } from '../panels/TranscriptView'
import { rewindConfirmation, rewindTargetIds } from '../lib/rewind'
import { useRewindUi } from '../store/rewind'
import { clickAndType, fieldValue } from './composerField'

/**
 * Rewind (spec 2026-09-29-rewind-design § Behaviour, § Testing): the count
 * over folded rows, which rows can be picked, `/rewind` caught on send, and
 * the pick → confirm-or-pending → cancel / send / refusal transitions.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 'a',
    cwd: '/home/tomin/projects/orbital',
    title: 'auth-refactor',
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

const user = (uuid: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `${uuid}:0`,
  role: 'user',
  uuid,
  text,
  ...extra,
})
const reply = (uuid: string, text: string, model = 'claude-opus-5'): ChatMessage => ({
  id: `${uuid}:0`,
  role: 'assistant',
  uuid,
  text,
  model,
})
const call = (n: number): ChatMessage[] => [
  { id: `tu${n}`, role: 'tool_use', toolName: 'Read', toolUseId: `t${n}`, toolInput: { file_path: `/f${n}` } },
  { id: `tr${n}`, role: 'tool_result', toolUseId: `t${n}`, text: 'ok' },
]

/**
 * A first ask the server did not mark (it has nothing before it), then a
 * pickable one followed by a reply, a folded run of two calls and a closing
 * reply: four rows go if the second ask is picked.
 */
const TRANSCRIPT: ChatMessage[] = [
  user('u1', 'First ask'),
  reply('a1', 'Reply one'),
  user('u2', 'Second ask', { rewindable: true }),
  reply('a2', 'Reply two'),
  ...call(1),
  ...call(2),
  reply('a3', 'All done'),
]

const defaultUi: OrbitalUiState = {
  selectedId: 'a',
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  wsStatus: 'connected',
  dialog: null,
  fileViewer: null,
  sidebarCollapsed: false,
}

function seed(session: ApiSession = makeSession(), extra: Partial<Parameters<typeof useOrbital.setState>[0]> = {}) {
  useOrbital.setState({
    sessions: { [session.id]: session },
    order: [session.id],
    tags: [],
    rules: [],
    settings: {},
    models: [],
    transcripts: { [session.id]: TRANSCRIPT },
    historyLoaded: { [session.id]: true },
    pendingDecisions: {},
    toast: null,
    subagentPanel: null,
    taskOutput: null,
    composerDrafts: {},
    rewindSending: {},
    ui: defaultUi,
    ...extra,
  })
}

const prompt = () => screen.getByRole('textbox', { name: /prompt/i })
const rewindButton = () => screen.getByRole('button', { name: 'Rewind to one of your messages' })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.walkthroughSummary).mockReturnValue(new Promise(() => {}))
  vi.mocked(api.getMessages).mockResolvedValue(TRANSCRIPT)
  useRewindUi.setState({ pick: null, picked: null })
})

// ---------------------------------------------------------------------------
// The count
// ---------------------------------------------------------------------------

describe('rewindCountFrom', () => {
  const groupsOf = (messages: ChatMessage[]) => insertModelDividers(groupToolRuns(pairMessages(messages)))
  const indexOf = (groups: ReturnType<typeof groupsOf>, id: string) =>
    groups.findIndex((g) => g.kind === 'message' && g.item.message.id === id)

  it('counts the picked message and everything after it, a folded run as one', () => {
    const groups = groupsOf(TRANSCRIPT)
    // u2, a2, the run of two calls, a3.
    expect(rewindCountFrom(groups, indexOf(groups, 'u2:0'))).toBe(4)
  })

  it('leaves system dividers out: the model switch, an earlier rewind, a compaction mark', () => {
    const messages: ChatMessage[] = [
      user('u1', 'First'),
      reply('a1', 'One', 'claude-opus-5'),
      user('u2', 'Second', { rewindable: true }),
      reply('a2', 'Two', 'claude-sonnet-5'), // a model divider lands before this
      { id: 'rewind:f:d', role: 'rewind', rewind: { hiddenCount: 3 } },
      { id: 'c1', role: 'compaction' },
      ...call(1),
      { id: 'th', role: 'thinking', text: 'hm', model: 'claude-sonnet-5' },
      reply('a3', 'Three', 'claude-sonnet-5'),
    ]
    const groups = groupsOf(messages)
    expect(groups.some((g) => g.kind === 'model-divider')).toBe(true)
    // u2, a2, the lone call, thinking, a3.
    expect(rewindCountFrom(groups, indexOf(groups, 'u2:0'))).toBe(5)
  })

  it('counts a run as one however many calls it folds', () => {
    const short = groupsOf([user('u', 'Go', { rewindable: true }), ...call(1), ...call(2)])
    const long = groupsOf([user('u', 'Go', { rewindable: true }), ...call(1), ...call(2), ...call(3), ...call(4)])
    expect(rewindCountFrom(short, 0)).toBe(2)
    expect(rewindCountFrom(long, 0)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Which rows can be picked
// ---------------------------------------------------------------------------

describe('rewindTargetIds', () => {
  it('offers what the server marked and not the session’s first message', () => {
    expect([...rewindTargetIds(TRANSCRIPT)]).toEqual(['u2:0'])
  })

  it('offers a just-sent turn once it has its uuid, when something was said before it', () => {
    const local: ChatMessage = { id: 'local:1', role: 'user', text: 'Again', uuid: 'n1' }
    expect(rewindTargetIds([...TRANSCRIPT, local]).has('local:1')).toBe(true)
    // No uuid yet: the send has not answered.
    expect(rewindTargetIds([...TRANSCRIPT, { ...local, uuid: undefined }]).has('local:1')).toBe(false)
    // The session's first turn has nothing before it.
    expect(rewindTargetIds([local]).has('local:1')).toBe(false)
  })

  it('puts the send’s uuid on the optimistic turn, which makes it pickable', async () => {
    seed()
    vi.mocked(api.sendMessage).mockResolvedValue({ ok: true, uuid: 'n1' })
    await act(() => useOrbital.getState().sendPrompt('a', 'Again'))
    const held = useOrbital.getState().transcripts.a
    const local = held[held.length - 1]
    expect(local.uuid).toBe('n1')
    expect(rewindTargetIds(held).has(local.id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// When the stop dialog asks
// ---------------------------------------------------------------------------

describe('rewindConfirmation', () => {
  const task = (overrides: Partial<BackgroundTask> = {}): BackgroundTask => ({
    id: 't',
    kind: 'shell',
    label: 'dev server',
    command: 'npm run dev',
    state: 'running',
    startedAt: 0,
    hasOutput: true,
    ...overrides,
  })
  const agent = (overrides: Partial<Subagent> = {}): Subagent => ({
    id: 's',
    name: 'tests',
    state: 'working',
    startedAt: 0,
    ...overrides,
  })

  it('asks nothing when nothing runs', () => {
    expect(rewindConfirmation(makeSession({ backgroundTasks: [task({ state: 'ended' })] }), null, 1000)).toBeNull()
  })

  it('names the turn alone as stopping the session', () => {
    const c = rewindConfirmation(makeSession({ status: 'working' }), { label: 'Edit: a.ts', startedAt: 0 }, 4200)
    expect(c).toMatchObject({ eyebrow: 'SESSION IS WORKING', title: 'Stop the session and rewind?' })
    expect(c!.items).toEqual([{ glyph: '⚙', kind: 'turn', label: 'Edit: a.ts', elapsed: '4.2s' }])
  })

  it('counts tasks and subagents once the turn is over', () => {
    const c = rewindConfirmation(makeSession({ backgroundTasks: [task(), task({ id: 'u', kind: 'monitor' })] }), null, 1000)
    expect(c).toMatchObject({ eyebrow: '2 TASKS RUNNING', title: 'End 2 running tasks and rewind?' })
  })

  it('stops the session and ends the tasks when both run', () => {
    const c = rewindConfirmation(
      makeSession({ status: 'working', backgroundTasks: [task(), task({ id: 'u' })], subagents: [agent()] }),
      null,
      1000,
    )
    expect(c).toMatchObject({ eyebrow: 'SESSION IS WORKING', title: 'Stop the session and end 3 tasks?' })
    expect(c!.items.map((i) => i.kind)).toEqual(['shell', 'shell', 'agent'])
  })
})

// ---------------------------------------------------------------------------
// The panel: entering, picking, pending, cancel, send, refusal
// ---------------------------------------------------------------------------

describe('rewind in the detail panel', () => {
  it('catches /rewind on send: pick mode opens and nothing goes to the agent', () => {
    seed()
    render(<DetailPanel />)
    clickAndType(prompt(), '/rewind')
    fireEvent.keyDown(prompt(), { key: 'Enter' })

    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(screen.getByText('Pick one of your messages to rewind to')).toBeInTheDocument()
    expect(fieldValue(prompt())).toBe('')
    expect(rewindButton()).toHaveAttribute('aria-pressed', 'true')
  })

  it('offers only the pickable rows, and Esc leaves pick mode', async () => {
    seed()
    render(<DetailPanel />)
    await userEvent.setup().click(rewindButton())

    const targets = document.querySelectorAll('[data-rewind-target]')
    expect(targets).toHaveLength(1)
    expect(targets[0]).toHaveTextContent('Second ask')

    // The first ask is not a target: a click on it picks nothing.
    fireEvent.click(screen.getByText('First ask'))
    expect(api.startRewind).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText('Pick one of your messages to rewind to')).not.toBeInTheDocument()
  })

  it('previews the cut on hover with the same count the pick sends', async () => {
    seed()
    render(<DetailPanel />)
    await userEvent.setup().click(rewindButton())
    fireEvent.mouseEnter(document.querySelector('[data-rewind-target]')!)
    expect(screen.getByText('REWIND TO HERE · 4 HIDDEN')).toBeInTheDocument()
  })

  it('rewinds at once when nothing runs, then Cancel rewind restores the draft held before the pick', async () => {
    seed(makeSession(), { composerDrafts: { a: 'half-written thought' } })
    vi.mocked(api.startRewind).mockResolvedValue({ text: 'Second ask' })
    vi.mocked(api.cancelRewind).mockResolvedValue({ draft: 'half-written thought' })
    render(<DetailPanel />)
    const u = userEvent.setup()

    await u.click(rewindButton())
    fireEvent.click(screen.getByText('Second ask'))

    expect(api.startRewind).toHaveBeenCalledWith('a', { uuid: 'u2', hiddenCount: 4, draft: 'half-written thought' })
    await screen.findByText('4 messages hidden')
    expect(screen.getByText('4 HIDDEN · BACK ON CANCEL')).toBeInTheDocument()
    expect(fieldValue(prompt())).toBe('Second ask')
    // No ↶ while pending: Cancel rewind is the way back.
    expect(screen.queryByRole('button', { name: 'Rewind to one of your messages' })).not.toBeInTheDocument()
    expect(document.querySelector('[data-variant="rewind"]')).toHaveTextContent('REWIND PENDING')

    await u.click(screen.getByRole('button', { name: 'Cancel rewind' }))
    expect(api.cancelRewind).toHaveBeenCalledWith('a')
    await waitFor(() => expect(fieldValue(prompt())).toBe('half-written thought'))
    expect(screen.queryByText('4 messages hidden')).not.toBeInTheDocument()
    expect(screen.queryByText('4 HIDDEN · BACK ON CANCEL')).not.toBeInTheDocument()
  })

  it('asks first while the session works; Keep running sends nothing, Stop and rewind does', async () => {
    seed(makeSession({ status: 'working' }))
    vi.mocked(api.startRewind).mockResolvedValue({ text: 'Second ask' })
    render(<DetailPanel />)
    const u = userEvent.setup()

    await u.click(rewindButton())
    fireEvent.click(screen.getByText('Second ask'))
    expect(await screen.findByText('Stop the session and rewind?')).toBeInTheDocument()
    expect(api.startRewind).not.toHaveBeenCalled()

    await u.click(screen.getByRole('button', { name: 'Keep running' }))
    expect(api.startRewind).not.toHaveBeenCalled()

    await u.click(rewindButton())
    fireEvent.click(screen.getByText('Second ask'))
    await u.click(await screen.findByRole('button', { name: /Stop and rewind/ }))
    expect(api.startRewind).toHaveBeenCalledWith('a', { uuid: 'u2', hiddenCount: 4, draft: '' })
  })

  it('leaves everything as it was when the server turns the pick down', async () => {
    seed(makeSession(), { composerDrafts: { a: 'keep me' } })
    vi.mocked(api.startRewind).mockRejectedValue(
      new ApiError(JSON.stringify({ error: 'not_rewindable' }), 409, '/api/sessions/a/rewind'),
    )
    render(<DetailPanel />)
    await userEvent.setup().click(rewindButton())
    fireEvent.click(screen.getByText('Second ask'))

    await waitFor(() => expect(useOrbital.getState().toast?.kind).toBe('error'))
    expect(fieldValue(prompt())).toBe('keep me')
    expect(useOrbital.getState().transcripts.a).toHaveLength(TRANSCRIPT.length)
    expect(screen.queryByText(/messages hidden/)).not.toBeInTheDocument()
  })

  it('does nothing with /rewind while a rewind is pending', async () => {
    seed(makeSession({ rewindPending: { hiddenCount: 4, text: 'Second ask' } }))
    render(<DetailPanel />)
    clickAndType(prompt(), '/rewind')
    fireEvent.keyDown(prompt(), { key: 'Enter' })
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(screen.queryByText('Pick one of your messages to rewind to')).not.toBeInTheDocument()
    // The field still starts with a slash, so the command catalog is fetched; let it land.
    await act(async () => {})
  })
})

describe('sending a pending rewind', () => {
  it('drops the strip at once and, when the CLI refuses, keeps the edit as an ordinary draft', async () => {
    const pendingTranscript = TRANSCRIPT.slice(0, 2)
    seed(makeSession({ rewindPending: { hiddenCount: 4, text: 'Second ask' } }), {
      transcripts: { a: pendingTranscript },
    })
    vi.mocked(api.sendMessage).mockResolvedValue({ ok: true, revived: true, uuid: 'n1', rewind: true })
    render(<DetailPanel />)
    expect(screen.getByText('4 messages hidden')).toBeInTheDocument()

    await act(() => useOrbital.getState().sendPrompt('a', 'Second ask, but better'))
    expect(screen.queryByText('4 messages hidden')).not.toBeInTheDocument()
    expect(screen.queryByText('4 HIDDEN · BACK ON CANCEL')).not.toBeInTheDocument()
    // The server's upsert still carries the row until the CLI answers; the strip stays gone.
    act(() =>
      useOrbital.getState().applySessionsEvent({
        event: 'upsert',
        session: makeSession({ rewindPending: { hiddenCount: 4, text: 'Second ask' } }),
      }),
    )
    expect(screen.queryByText('4 messages hidden')).not.toBeInTheDocument()

    act(() =>
      useOrbital.getState().applySessionEvent('a', {
        event: 'rewind_refused',
        message: 'Resume rejected by --resume-drops-turn: …',
        hiddenCount: 4,
      }),
    )
    const state = useOrbital.getState()
    expect(state.transcripts.a).toEqual(pendingTranscript)
    expect(state.composerDrafts.a).toBe('Second ask, but better')
    expect(state.toast?.kind).toBe('rewind_refused')
    expect(state.sessions.a.rewindPending).toBeNull()
    expect(state.rewindSending.a).toBeUndefined()
    await waitFor(() => expect(fieldValue(prompt())).toBe('Second ask, but better'))
    expect(screen.queryByText(/messages hidden/)).not.toBeInTheDocument()
  })

  it('clears the refusal toast on the next send', async () => {
    seed(makeSession(), { toast: { kind: 'rewind_refused', message: 'refused' } })
    vi.mocked(api.sendMessage).mockResolvedValue({ ok: true })
    await act(() => useOrbital.getState().sendPrompt('a', 'plain turn'))
    expect(useOrbital.getState().toast).toBeNull()
  })
})
