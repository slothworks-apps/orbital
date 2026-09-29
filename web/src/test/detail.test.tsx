import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ApiSession, OrbitalModel, Subagent, Tag } from '../lib/types'
import {
  useOrbital,
  clampDetailPanelWidth,
  DETAIL_PANEL_MIN_PX,
  type OrbitalState,
  type OrbitalUiState,
} from '../store/store'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { DetailPanel } from '../panels/DetailPanel'
import { ModelSwitcher } from '../panels/ModelSwitcher'
import { installKeyListener } from '../lib/commands'
import { clickAndType, fieldValue, replaceField } from './composerField'

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

function makeSubagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    id: 'agent-1',
    name: 'Run the eslint and jest suites',
    state: 'working',
    toolUseId: 'tool-1',
    startedAt: 0,
    ...overrides,
  }
}

/** An open `subagentPanel` for session `sessionId` — the shape task 8's
 * pairing tests need `useOrbital`'s state to carry; the panel's own
 * content is `subagentpanel.test.tsx`'s concern, not this file's. */
function openSubagentPanelFor(sessionId: string) {
  return {
    sessionId,
    subagent: makeSubagent(),
    messages: [],
    droppedCount: 0,
    found: true,
  }
}

const workTag: Tag = { id: 1, name: 'work', hue: 210, is_default: 0 }
const personalTag: Tag = { id: 2, name: 'personal', hue: 330, is_default: 0 }

// Same shape as `modelcards.test.tsx`'s fixture — the two must not disagree
// about what a model looks like.
const MODELS: OrbitalModel[] = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', family: 'Opus', version: 'Opus 5 with 1M context', shortVersion: 'Opus 5', variant: '1M', blurb: 'Best for everyday, complex tasks', contextWindow: 1_000_000 },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', shortVersion: 'Sonnet 5', variant: null, blurb: 'Efficient for routine tasks', contextWindow: 200_000 },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', family: 'Haiku', version: 'Haiku 4.5', shortVersion: 'Haiku 4.5', variant: null, blurb: 'Fastest for quick answers', contextWindow: null },
]

const webSession = makeSession({ id: 'a', source: 'web' })
const terminalSession = makeSession({ id: 'b', source: 'terminal', status: 'ended' })

const defaultUi: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  wsStatus: 'connected',
  dialog: null,
  fileViewer: null,
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
    models: [],
    transcripts: {},
    historyLoaded: {},
    toast: null,
    // Reset explicitly rather than left to `setState`'s shallow merge: a
    // test that opens the subagent panel (task 8) and does not close it
    // again would otherwise leak it into whatever test runs next in this
    // file.
    subagentPanel: null,
    taskOutput: null,
    stoppingTasks: {},
    // Same reason: a draft typed in one test would sit in the next one's
    // composer.
    composerDrafts: {},
    ...overrides,
    ui: { ...defaultUi, ...overrides.ui },
  })
}

/**
 * Seeds a single session (+ its models/usage) and renders the panel — the
 * shared entry point for the model-chip tests, which only ever care about
 * one session at a time. Kept `async` for its callers even though mounting
 * settles synchronously now: the walkthrough-summary effect it used to have
 * to wait out never resolves in this file's default mock (see `beforeEach`
 * below), so there is nothing left to await.
 */
async function renderDetail({
  session,
  models = [],
}: {
  session: ApiSession
  models?: OrbitalModel[]
}) {
  resetStore({
    sessions: { [session.id]: session },
    models,
    ui: { selectedId: session.id },
  })
  return render(<DetailPanel />)
}

beforeEach(() => {
  vi.clearAllMocks()
  // The walkthrough-entry effect fires for every web session on mount
  // (`DetailPanel`'s `walkthroughSummary` effect) and used to settle inside
  // whatever `waitFor(api.getSession)` a test happened to await for the now-
  // removed lineage fetch — coincidence, not something any of these tests
  // were actually about. A default that never resolves means the effect's
  // `.then` never fires unless a test opts in, so mounting a web session no
  // longer needs an unrelated flush just to keep this quiet. The two tests
  // that care about the walkthrough entry override this themselves.
  vi.mocked(api.walkthroughSummary).mockReturnValue(new Promise(() => {}))
})

// ---------------------------------------------------------------------------
// Header: the pin toggle (canvas 4b/4d)
// ---------------------------------------------------------------------------

describe('DetailPanel pin toggle', () => {
  it('names the action it would perform and carries the state in aria-pressed', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', status: 'ended' }) },
      ui: { selectedId: 'a' },
    })
    render(<DetailPanel />)

    const toggle = screen.getByRole('button', { name: 'Pin session' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    act(() => {
      useOrbital.setState((s) => ({
        sessions: { ...s.sessions, a: { ...s.sessions.a, pinnedAt: 5 } },
      }))
    })

    expect(screen.getByRole('button', { name: 'Unpin session' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })

  it('pins the selected session through the store', async () => {
    const user = userEvent.setup()
    resetStore({
      sessions: { a: makeSession({ id: 'a', status: 'ended' }) },
      ui: { selectedId: 'a' },
    })
    const pinSpy = vi.spyOn(useOrbital.getState(), 'setSessionPinned').mockResolvedValue(undefined)
    render(<DetailPanel />)

    await user.click(screen.getByRole('button', { name: 'Pin session' }))
    expect(pinSpy).toHaveBeenCalledWith('a', true)
  })

  it('carries the pin in the footer of an ended session, and nothing for a live one', async () => {
    const now = Date.now()
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', status: 'ended', lastAt: now - 2 * 60 * 60_000, pinnedAt: 5 }),
      },
      ui: { selectedId: 'a' },
    })
    render(<DetailPanel />)

    expect(screen.getByText(/stays on the map until you unpin it/)).toBeInTheDocument()

    act(() => {
      useOrbital.setState((s) => ({
        sessions: { ...s.sessions, a: { ...s.sessions.a, pinnedAt: null } },
      }))
    })
    expect(screen.getByText(/^ended 2h ago$/)).toBeInTheDocument()

    act(() => {
      useOrbital.setState((s) => ({
        sessions: { ...s.sessions, a: { ...s.sessions.a, status: 'idle' } },
      }))
    })
    expect(screen.queryByText(/^ended /)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Header: title, cwd, tags, badges, usage
// ---------------------------------------------------------------------------

/**
 * The title is a two-line clamp at rest and a textarea only while it is being
 * edited (canvas `Feature - Detail header` 9e), so a rename starts by opening
 * it. Returns the field.
 */
async function openTitle(user: ReturnType<typeof userEvent.setup>, current: string) {
  await user.click(screen.getByRole('button', { name: current }))
  return screen.getByRole('textbox', { name: 'Session title' })
}

describe('DetailPanel header', () => {
  it('renders nothing when no session is selected', () => {
    resetStore()
    const { container } = render(<DetailPanel />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows title, cwd, the permission-mode readout and the status badge for the selected session', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', title: 'My session', status: 'working', permissionMode: 'plan' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    // At rest the title is read as text, not as a field (canvas
    // `Feature - Detail header` 9e): the field appears on click.
    expect(screen.getByRole('button', { name: 'My session' })).toBeInTheDocument()
    expect(screen.getByText(/orbital/)).toBeInTheDocument() // shortened cwd
    // The mode is a dot in a 24×22 box, not a word — it reaches a reader
    // through the readout's accessible name and its tooltip.
    expect(screen.getByRole('img', { name: 'permission mode: plan' })).toBeInTheDocument()
    expect(screen.queryByText('plan')).toBeNull()
    expect(screen.getByText(/WORKING/)).toBeInTheDocument()
  })

  it("draws the context bar from the session's persisted contextUsedTokens, with no turn_result anywhere in the store", async () => {
    resetStore({
      // The number the server wrote on the row and republished — the same
      // field the map's arc reads. Nothing here has seen a `turn_result`,
      // which is the point: a reloaded tab has none and must still show the
      // gauge. 100_000 / 200_000 -> 50 %.
      sessions: { a: makeSession({ id: 'a', model: 'sonnet', contextUsedTokens: 100_000 }) },
      models: MODELS,
      ui: { selectedId: 'a' },
    })

    const { container } = render(<DetailPanel />)

    // Canvas 1b's compact notation ("142.3k"), not raw counts.
    expect(container.querySelector('[data-context-readout]')).toHaveTextContent(/100k\s*\/ 200k$/)
    const bar = screen.getByRole('progressbar', { name: /context usage/i })
    expect(bar).toHaveAttribute('aria-valuenow', '50')
    // An ordinary fill gets no note — the read-out is not ambiguous (1b-alt).
    expect(container.querySelector('[data-context-note]')).not.toBeInTheDocument()
  })

  it('shows the readout against the real denominator, dashed, when nothing has measured the context yet', async () => {
    resetStore({
      // A fresh web session: no turn has ended and no compaction has run, so
      // `contextUsedTokens` is null. Giving it a model that matches a MODELS
      // row (so contextWindowFor resolves a real number, not null) is the
      // point of this test: this is the one place Orbital draws a denominator
      // without having measured anything, so it is the last place a wrong
      // number could still surface.
      sessions: { a: makeSession({ id: 'a', source: 'web', model: 'sonnet', contextUsedTokens: null }) },
      models: MODELS,
      ui: { selectedId: 'a' },
    })

    const { container } = render(<DetailPanel />)

    // The window IS known (sonnet -> 200k), so the readout renders — honestly
    // unmeasured, not unknown.
    expect(container.querySelector('[data-context-readout]')).toHaveTextContent(/—\s*\/ 200k$/)
    // No value to report -> an empty track, not a progressbar claiming 0%.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    // ...and the note says which of the two em-dash readings this is.
    expect(container.querySelector('[data-context-note]')).toHaveTextContent('NOT MEASURED YET')
  })

  it('clamps a session measured past its own window to a full bar, while the readout still states what was measured', async () => {
    resetStore({
      // A window learned smaller than the session's actual use. Same clamp
      // the arc applies, because it is now literally the same function.
      sessions: { a: makeSession({ id: 'a', model: 'sonnet', contextUsedTokens: 500_000 }) },
      models: MODELS,
      ui: { selectedId: 'a' },
    })

    const { container } = render(<DetailPanel />)

    expect(screen.getByRole('progressbar', { name: /context usage/i })).toHaveAttribute(
      'aria-valuenow',
      '100'
    )
    expect(container.querySelector('[data-context-readout]')).toHaveTextContent(/500k\s*\/ 200k$/)
    // The note is what stops a full bar over "500k / 200k" reading as a bug.
    expect(container.querySelector('[data-context-note]')).toHaveTextContent('OVER WINDOW')
  })

  it('keeps showing an ended session\'s last known fill, which the map deliberately drops (canvas 1i: "ended · no gauge")', async () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', model: 'sonnet', status: 'ended', contextUsedTokens: 100_000 }),
      },
      models: MODELS,
      ui: { selectedId: 'a' },
    })

    const { container } = render(<DetailPanel />)

    expect(container.querySelector('[data-context-readout]')).toHaveTextContent(/100k\s*\/ 200k$/)
  })

  it('hides the context bar entirely for a terminal session, which can never report one (owner\'s ruling: hide, don\'t dash)', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'terminal' }) },
      models: MODELS,
      ui: { selectedId: 'a' },
    })

    const { container } = render(<DetailPanel />)

    expect(container.querySelector('[data-context-readout]')).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('renames the session on Enter, updating the store optimistically and firing the API', async () => {
    const user = userEvent.setup()
    vi.mocked(api.renameSession).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', title: 'Old title' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    const titleInput = await openTitle(user, 'Old title')
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
    const titleInput = await openTitle(user, 'Old title')
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
    const titleInput = await openTitle(user, 'Old title')
    await user.clear(titleInput)
    await user.type(titleInput, 'Rejected title{Enter}')

    await waitFor(() => expect(useOrbital.getState().sessions.a.title).toBe('Old title'))
    expect(screen.getByRole('button', { name: 'Old title' })).toBeInTheDocument()
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
    clickAndType(promptBox, 'a prompt in progress')

    const titleInput = await openTitle(user, 'Old title')
    await user.clear(titleInput)
    await user.type(titleInput, 'New title{Enter}')

    await waitFor(() => expect(useOrbital.getState().sessions.a.title).toBe('New title'))
    expect(fieldValue(promptBox)).toBe('a prompt in progress')
  })

  it('keeps each session its own prompt draft across switching away and back', async () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', source: 'web', status: 'idle' }),
        b: makeSession({ id: 'b', source: 'web', status: 'idle' }),
      },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    clickAndType(screen.getByRole('textbox', { name: /prompt/i }), 'half a thought')

    act(() => useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 'b' } })))
    const promptBox = screen.getByRole('textbox', { name: /prompt/i })
    expect(fieldValue(promptBox)).toBe('')
    clickAndType(promptBox, 'yes')

    act(() => useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 'a' } })))
    expect(fieldValue(screen.getByRole('textbox', { name: /prompt/i }))).toBe('half a thought')
    expect(useOrbital.getState().composerDrafts.b).toBe('yes')
  })

  // 1b: the tag row is a dropdown, not a row of toggles — a session wears
  // one tag, so picking REPLACES rather than adds.
  it('shows the session tag as a dropdown listing every tag, the current one checked', async () => {
    const user = userEvent.setup()
    resetStore({
      sessions: { a: makeSession({ id: 'a', tagIds: [1] }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    const trigger = screen.getByRole('combobox', { name: 'Change tag' })
    expect(trigger).toHaveTextContent('work')
    await user.click(trigger)

    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.getAttribute('data-label'))).toEqual(['work', 'personal'])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('ONE TAG PER SESSION · SETS PLANET HUE')).toBeInTheDocument()
  })

  it('replaces the tag when another is picked, updating the store optimistically and calling setSessionTags', async () => {
    const user = userEvent.setup()
    vi.mocked(api.setSessionTags).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', tagIds: [1] }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    await user.click(screen.getByRole('combobox', { name: 'Change tag' }))
    await user.click(screen.getByRole('option', { name: /personal/ }))

    expect(api.setSessionTags).toHaveBeenCalledWith('a', [2])
    expect(useOrbital.getState().sessions.a.tagIds).toEqual([2])
  })

  it('rolls back the optimistic tag change and shows a toast when setSessionTags rejects', async () => {
    const user = userEvent.setup()
    vi.mocked(api.setSessionTags).mockRejectedValue(new Error('tags server down'))
    resetStore({
      sessions: { a: makeSession({ id: 'a', tagIds: [1] }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)
    await user.click(screen.getByRole('combobox', { name: 'Change tag' }))
    await user.click(screen.getByRole('option', { name: /personal/ }))

    await waitFor(() => expect(useOrbital.getState().sessions.a.tagIds).toEqual([1]))
    expect(useOrbital.getState().toast).toMatchObject({ kind: 'error', message: 'tags server down' })
  })

  it('offers the walkthrough only for an Orbital session with file changes', async () => {
    vi.mocked(api.walkthroughSummary).mockResolvedValue({ steps: 3, files: 2, blindAlleys: 0, subagents: 0 })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      ui: { selectedId: 'a' },
      settings: { walkthrough_enabled: 'true' },
    })

    render(<DetailPanel />)

    expect(await screen.findByRole('button', { name: 'Walkthrough' })).toBeInTheDocument()
  })

  it('neither offers nor asks for the walkthrough while its Experimental switch is off', async () => {
    vi.mocked(api.walkthroughSummary).mockResolvedValue({ steps: 3, files: 2, blindAlleys: 0, subagents: 0 })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Walkthrough' })).toBeNull()
    expect(api.walkthroughSummary).not.toHaveBeenCalled()
  })

  it('hides the walkthrough control for a terminal session and for a session without changes', async () => {
    vi.mocked(api.walkthroughSummary).mockResolvedValue({ steps: 0, files: 0, blindAlleys: 0, subagents: 0 })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      ui: { selectedId: 'a' },
      settings: { walkthrough_enabled: 'true' },
    })

    render(<DetailPanel />)
    await waitFor(() => expect(api.walkthroughSummary).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Walkthrough' })).toBeNull()

    cleanup()
    resetStore({
      sessions: { b: makeSession({ id: 'b', source: 'terminal' }) },
      ui: { selectedId: 'b' },
      settings: { walkthrough_enabled: 'true' },
    })
    render(<DetailPanel />)

    expect(screen.queryByRole('button', { name: 'Walkthrough' })).toBeNull()
    expect(api.walkthroughSummary).toHaveBeenCalledTimes(1) // not asked for a terminal session
  })
})

// ---------------------------------------------------------------------------
// Model chip, switcher and the context bar it scales (canvas 4a)
// ---------------------------------------------------------------------------

describe('DetailPanel model chip', () => {
  it('shows the session model next to the permission badge', async () => {
    await renderDetail({ session: { ...webSession, model: 'opus[1m]' }, models: MODELS })
    // Short version plus the variant — the full "Opus 5 with 1M context" would
    // wrap this row (see the naming table in the plan header).
    expect(screen.getByRole('button', { name: /Change model/ })).toHaveTextContent('Opus 5 (1M)')
  })

  it('names a terminal session from its resolved model, without a variant the context bar cannot back up', async () => {
    // Only the variant-STRIPPED match here (`claude-opus-5` vs the row's
    // `claude-opus-5[1m]`), so contextWindowFor resolves null and no bar is
    // drawn at all (moot in this case anyway, since a terminal session hides
    // the whole usage block) — the chip must not claim 1M when there is no
    // read-out to back it up (F2).
    await renderDetail({ session: { ...terminalSession, resolvedModel: 'claude-opus-5' }, models: MODELS })
    expect(screen.getByText('Opus 5')).toBeInTheDocument()
    expect(screen.queryByText('Opus 5 (1M)')).not.toBeInTheDocument()
  })

  it('keeps the variant when the resolved model matches a row exactly', async () => {
    await renderDetail({ session: { ...terminalSession, resolvedModel: 'claude-opus-5[1m]' }, models: MODELS })
    expect(screen.getByText('Opus 5 (1M)')).toBeInTheDocument()
  })

  it('opens the switcher and marks the current model', async () => {
    await renderDetail({ session: { ...webSession, model: 'sonnet' }, models: MODELS })
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }))
    expect(screen.getByRole('option', { name: 'Sonnet 5' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/APPLIES FROM NEXT TURN/)).toBeInTheDocument()
  })

  it('switches the model once the switch is confirmed', async () => {
    vi.mocked(api.setSessionModel).mockResolvedValue({ ok: true })
    await renderDetail({ session: { ...webSession, model: 'sonnet', contextUsedTokens: 143_300 }, models: MODELS })
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }))
    fireEvent.click(screen.getByRole('option', { name: 'Haiku 4.5' }))

    // Every switch asks: the new model reads the whole context again.
    expect(api.setSessionModel).not.toHaveBeenCalled()
    expect(screen.getByText(/143\.3k tokens/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }))
    await waitFor(() => expect(api.setSessionModel).toHaveBeenCalledWith(webSession.id, 'haiku'))
  })

  it('keeps the model when the switch is cancelled', async () => {
    await renderDetail({ session: { ...webSession, model: 'sonnet' }, models: MODELS })
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }))
    fireEvent.click(screen.getByRole('option', { name: 'Haiku 4.5' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Switch' })).not.toBeInTheDocument())
    expect(api.setSessionModel).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Change model/ })).toHaveTextContent('Sonnet 5')
  })

  it('closes on an outside pointerdown, matching every other popover in the app (F4)', async () => {
    await renderDetail({ session: { ...webSession, model: 'sonnet' }, models: MODELS })
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('closes the popover when the selected session changes underneath it', () => {
    const sessionA = { ...webSession, model: 'sonnet' }
    const sessionB = { ...webSession, id: 'other', model: 'haiku' }
    const { rerender } = render(<ModelSwitcher session={sessionA} models={MODELS} defaultValue={null} />)
    fireEvent.click(screen.getByRole('button', { name: /Change model/ }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    rerender(<ModelSwitcher session={sessionB} models={MODELS} defaultValue={null} />)

    // Must not survive to describe the wrong session (F4).
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('is inert with an explanatory title when the catalog is empty', async () => {
    await renderDetail({ session: { ...webSession, model: 'sonnet' }, models: [] })
    expect(screen.queryByRole('button', { name: /Change model/ })).not.toBeInTheDocument()
    expect(screen.getByTitle(/model list could not be read/i)).toBeInTheDocument()
  })

  it('does not offer a switch on a session live in a terminal', async () => {
    await renderDetail({ session: { ...terminalSession, status: 'working', model: null, resolvedModel: 'claude-sonnet-5' }, models: MODELS })
    expect(screen.queryByRole('button', { name: /Change model/ })).not.toBeInTheDocument()
  })

  it('scales the context bar to the session model', async () => {
    await renderDetail({
      session: { ...webSession, model: 'opus[1m]', contextUsedTokens: 100_000 },
      models: MODELS,
    })
    expect(screen.getByTestId('context-readout')).toHaveTextContent(/100k\s*\/ 1M$/)
    expect(screen.getByRole('progressbar', { name: 'Context usage' })).toHaveAttribute('aria-valuenow', '10')
  })

  it('draws no context bar or read-out for a model it cannot place, rather than guessing a size', async () => {
    await renderDetail({ session: { ...webSession, model: null, resolvedModel: 'claude-mystery-1' }, models: MODELS })
    expect(screen.queryByTestId('context-readout')).not.toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
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
    clickAndType(textbox, 'hello there')
    await user.click(screen.getByRole('button', { name: /send/i }))

    expect(sendSpy).toHaveBeenCalledWith('a', 'hello there')
  })

  it('sends on Enter and inserts a newline on Shift+Enter instead of sending', async () => {
    vi.mocked(api.sendMessage).mockResolvedValue({ ok: true })
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })
    const sendSpy = vi.spyOn(useOrbital.getState(), 'sendPrompt')

    render(<DetailPanel />)
    const textbox = screen.getByRole('textbox', { name: /prompt/i })
    clickAndType(textbox, 'line one')
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
    clickAndType(textbox, 'optimistic ping')
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
    expect(screen.queryByRole('button', { name: /^stop$/i })).not.toBeInTheDocument()
  })

  it('shows a read-only bar with no input for a live terminal session', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'terminal', status: 'working' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

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

    expect(screen.getByRole('textbox', { name: /prompt/i })).toBeInTheDocument()
    expect(screen.queryByText(/runs in terminal/i)).not.toBeInTheDocument()
  })

  it('shows a "Continue conversation…" placeholder for an ended session (C4)', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'ended' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    expect(screen.getByRole('textbox', { name: /prompt/i })).toHaveAttribute(
      'aria-placeholder',
      'Continue conversation…'
    )
  })

  it('shows a generic "Send a message…" placeholder for a non-ended session', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    expect(screen.getByRole('textbox', { name: /prompt/i })).toHaveAttribute(
      'aria-placeholder',
      'Send a message…'
    )
  })

  // The composer is `panels/Composer` now (spec: 2026-09-20-composer-design),
  // so the hint carries the paste affordance and the field is its editor.
  it('shows the panel mount`s key hint beside the composer actions (canvas 9a)', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    expect(screen.getByText('⏎ send · ⇧⏎ newline · ⌘V paste image')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send/i })).toHaveTextContent('Send ↑')
  })

  it('mounts the composer`s editor as the panel`s prompt field', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    expect(document.querySelector('[data-composer-field]')).not.toBeNull()
  })

  it('hides the composer key hint for a live terminal session (no composer to drive)', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'terminal', status: 'working' }) },
      ui: { selectedId: 'a' },
    })

    render(<DetailPanel />)

    expect(screen.queryByText(/⏎ send/)).not.toBeInTheDocument()
    expect(document.querySelector('[data-composer-field]')).toBeNull()
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

    expect(api.clearSession).toHaveBeenCalledWith('a', true)
    expect(useOrbital.getState().ui.dialog).toBe(null)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
    await user.click(screen.getByRole('button', { name: /clear & start new/i }))

    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ confirm_before_clear: 'false' }))
    expect(useOrbital.getState().settings.confirm_before_clear).toBe('false')
  })

  it('closes ClearDialog on Escape without clearing', async () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web' }) },
      ui: { selectedId: 'a', dialog: 'clear' },
    })

    render(<DetailPanel />)
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
    await user.click(screen.getByRole('button', { name: /clear & start new/i }))

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
    await user.click(screen.getByRole('button', { name: /clear & start new/i }))

    await waitFor(() =>
      expect(useOrbital.getState().toast).toMatchObject({ kind: 'error', message: 'settings unreachable' })
    )
    // The rejected PATCH must never leave the store claiming the preference stuck.
    expect(useOrbital.getState().settings.confirm_before_clear).toBeUndefined()
    // The clear itself still proceeds even though the preference failed to save.
    expect(api.clearSession).toHaveBeenCalledWith('a', true)
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

    // Selection changes elsewhere (e.g. a sidebar click) while the dialog
    // the user opened for 'a' is still open.
    await act(async () => {
      useOrbital.setState((state) => ({ ui: { ...state.ui, selectedId: 'b' } }))
      await Promise.resolve()
    })

    await user.click(screen.getByRole('button', { name: /clear & start new/i }))

    expect(api.clearSession).toHaveBeenCalledWith('a', true)
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
    await act(async () => {
      useOrbital.setState((state) => ({ ui: { ...state.ui, selectedId: 'b' } }))
      await Promise.resolve()
    })

    await user.click(screen.getByRole('button', { name: /stop turn/i }))

    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith('a'))
    expect(api.interrupt).not.toHaveBeenCalledWith('b')
  })
})

// ---------------------------------------------------------------------------
// Resizable width (docs/ideas/resizable-detail-panel.md)
// ---------------------------------------------------------------------------

describe('DetailPanel — resizable width', () => {
  // jsdom has no PointerEvent constructor and drops `clientX` from
  // fireEvent.pointerDown's synthesized event — a MouseEvent with the
  // pointer type carries the coordinate, and React dispatches by type.
  const firePointer = (el: Element, type: string, clientX: number) =>
    fireEvent(el, new MouseEvent(type, { bubbles: true, clientX }))

  it('dragging updates the stored width live and PATCHes once on release', async () => {
    vi.mocked(api.patchSettings).mockResolvedValue({ ok: true })
    await renderDetail({ session: webSession })
    const handle = screen.getByRole('separator', { name: /resize panel/i })

    // Right-docked panel: moving the pointer LEFT makes it wider.
    firePointer(handle, 'pointerdown', 500)
    firePointer(handle, 'pointermove', 460)
    expect(useOrbital.getState().settings.detail_panel_width).toBe('490')
    firePointer(handle, 'pointermove', 440)
    expect(useOrbital.getState().settings.detail_panel_width).toBe('510')

    // Live via the store only — persisted once, on release.
    expect(api.patchSettings).not.toHaveBeenCalled()
    firePointer(handle, 'pointerup', 440)
    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ detail_panel_width: '510' })
    )
    expect(api.patchSettings).toHaveBeenCalledTimes(1)
  })

  it('clamps the drag to the 360px floor', async () => {
    vi.mocked(api.patchSettings).mockResolvedValue({ ok: true })
    await renderDetail({ session: webSession })
    const handle = screen.getByRole('separator', { name: /resize panel/i })

    firePointer(handle, 'pointerdown', 500)
    firePointer(handle, 'pointermove', 900)
    expect(useOrbital.getState().settings.detail_panel_width).toBe('360')
  })

  it('double-click resets to the export 450 and saves it', async () => {
    vi.mocked(api.patchSettings).mockResolvedValue({ ok: true })
    await renderDetail({ session: webSession })
    act(() => {
      useOrbital.setState((s) => ({
        settings: { ...s.settings, detail_panel_width: '600' },
      }))
    })

    fireEvent.doubleClick(screen.getByRole('separator', { name: /resize panel/i }))

    expect(useOrbital.getState().settings.detail_panel_width).toBe('450')
    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ detail_panel_width: '450' })
    )
  })
})

// ---------------------------------------------------------------------------
// File viewer mount (spec: 2026-09-19-file-viewer-design)
// ---------------------------------------------------------------------------

describe('DetailPanel file viewer', () => {
  it('mounts the viewer for the selected session when a file is open', async () => {
    vi.mocked(api.filePreview).mockResolvedValue({
      kind: 'ok',
      content: 'const a = 1',
      size: 11,
      mtimeMs: Date.now(),
      lines: 1,
    })
    resetStore({
      sessions: { a: webSession },
      order: ['a'],
      ui: { selectedId: 'a', fileViewer: { path: 'web/src/App.tsx', line: null } },
    })

    render(<DetailPanel />)

    expect(await screen.findByRole('dialog', { name: /File web\/src\/App\.tsx/ })).toBeInTheDocument()
  })

  it('mounts no viewer while none is open', () => {
    resetStore({ sessions: { a: webSession }, order: ['a'], ui: { selectedId: 'a' } })
    render(<DetailPanel />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Image intake in the panel mount (spec: 2026-09-20-composer-design § Image
// intake; canvas 9c).
// ---------------------------------------------------------------------------

describe('DetailPanel image intake', () => {
  /** jsdom has no DataTransfer; `items` is what the drop state reads. */
  function imageDrag(files: File[] = []) {
    return {
      files,
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      types: ['Files'],
    } as unknown as DataTransfer
  }

  const png = (name = 'after-390.png') =>
    new File([new Uint8Array([1])], name, { type: 'image/png' })

  const ENTRY = { ref: 'aaa.png', w: 1170, h: 760, bytes: 200_704 }

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:preview')
    URL.revokeObjectURL = vi.fn()
    vi.mocked(api.uploadAttachment).mockResolvedValue({ kind: 'ok', entry: ENTRY })
  })

  async function mountPanel() {
    resetStore({
      sessions: { a: makeSession({ id: 'a', source: 'web', status: 'idle' }) },
      ui: { selectedId: 'a' },
    })
    return render(<DetailPanel />)
  }

  it('arms the whole panel on a drag carrying images, dimming what is behind the marker', async () => {
    const { container } = await mountPanel()
    const shell = container.querySelector('[data-drop-target]') as HTMLElement

    fireEvent.dragEnter(shell, { dataTransfer: imageDrag([png()]) })

    expect(shell).toHaveAttribute('data-drop-armed', 'true')
    expect(screen.getByTestId('drop-marker')).toHaveTextContent('DROP TO ATTACH')
    // 9c-1: the transcript drops to .35 so nothing competes with the marker.
    expect(container.querySelector('[data-transcript-dim]')!.className).toContain('opacity-35')
  })

  it('arms Send on an uploaded chip alone and sends an image-only turn', async () => {
    const { container } = await mountPanel()
    const sendSpy = vi.spyOn(useOrbital.getState(), 'sendPrompt')
    const send = () => screen.getByRole('button', { name: /send/i })
    expect(send()).toBeDisabled()

    const shell = container.querySelector('[data-drop-target]') as HTMLElement
    fireEvent.drop(shell, { dataTransfer: imageDrag([png()]) })

    await waitFor(() => expect(send()).toBeEnabled())
    fireEvent.click(send())

    await waitFor(() =>
      expect(sendSpy).toHaveBeenCalledWith('a', '', [
        { entry: ENTRY, name: 'after-390.png', source: 'file' },
      ]),
    )
    // Text and chips clear together (9c-3).
    expect(screen.queryAllByTestId('attachment-chip')).toHaveLength(0)
  })

  it('queues a send made while an upload is still in flight', async () => {
    let land: (value: { kind: 'ok'; entry: typeof ENTRY }) => void = () => {}
    vi.mocked(api.uploadAttachment).mockReturnValue(
      new Promise((resolve) => {
        land = resolve
      }),
    )
    const { container } = await mountPanel()
    const sendSpy = vi.spyOn(useOrbital.getState(), 'sendPrompt')

    const shell = container.querySelector('[data-drop-target]') as HTMLElement
    fireEvent.drop(shell, { dataTransfer: imageDrag([png()]) })
    await waitFor(() => expect(screen.getAllByTestId('attachment-chip')).toHaveLength(1))

    const textbox = screen.getByRole('textbox', { name: /prompt/i })
    replaceField(textbox, 'both at 390')
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    // The field cleared at once; the turn has not gone out yet.
    expect(fieldValue(textbox)).toBe('')
    expect(sendSpy).not.toHaveBeenCalled()

    await act(async () => {
      land({ kind: 'ok', entry: ENTRY })
    })
    await waitFor(() =>
      expect(sendSpy).toHaveBeenCalledWith('a', 'both at 390', [
        { entry: ENTRY, name: 'after-390.png', source: 'file' },
      ]),
    )
  })

  it('drops the chips when the panel moves to another session', async () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', source: 'web' }),
        b: makeSession({ id: 'b', source: 'web' }),
      },
      ui: { selectedId: 'a' },
    })
    const { container } = render(<DetailPanel />)

    const shell = container.querySelector('[data-drop-target]') as HTMLElement
    fireEvent.drop(shell, { dataTransfer: imageDrag([png()]) })
    await waitFor(() => expect(screen.getAllByTestId('attachment-chip')).toHaveLength(1))

    await act(async () => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: 'b' } }))
    })
    expect(screen.queryAllByTestId('attachment-chip')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Header: regenerating the name
// ---------------------------------------------------------------------------

describe('DetailPanel regenerate-name button', () => {
  it('says so when the model decides the current name still fits', async () => {
    vi.mocked(api.retitleSession).mockResolvedValue({ title: 'Session title', changed: false })
    await renderDetail({ session: webSession })

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate name' }))

    await waitFor(() => {
      expect(useOrbital.getState().toast).toMatchObject({ kind: 'info' })
    })
  })

  it('stays quiet when the name actually moved — the new one arrives on its own', async () => {
    vi.mocked(api.retitleSession).mockResolvedValue({ title: 'Space map zoom', changed: true })
    await renderDetail({ session: webSession })

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate name' }))

    await waitFor(() => expect(api.retitleSession).toHaveBeenCalledWith('a'))
    expect(useOrbital.getState().toast).toBeNull()
  })

  // The button beside it (Clear) IS gated on `source`. This one must not be:
  // the server names a session from the transcript on disk, which a terminal
  // session has exactly like a web one.
  it('is offered for a terminal session too', async () => {
    await renderDetail({ session: terminalSession })

    expect(screen.getByRole('button', { name: 'Regenerate name' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Where the header carries session stats
// (canvas `Feature - Header gauges` 11c, setting `header_session_stats`)
// ---------------------------------------------------------------------------

describe('DetailPanel session stats placement', () => {
  async function renderWith(headerSessionStats: string) {
    resetStore({
      sessions: { a: webSession },
      settings: { header_session_stats: headerSessionStats },
      ui: { selectedId: 'a' },
    })
    return render(<DetailPanel />)
  }

  it('draws the strip by default', async () => {
    const { container } = await renderWith('bar')

    expect(container.querySelector('[data-session-stats-row]')).toBeInTheDocument()
    expect(container.querySelector('[data-session-stats-button]')).not.toBeInTheDocument()
  })

  it('drops the strip into the utility row when the setting says button only', async () => {
    const { container } = await renderWith('button')

    expect(container.querySelector('[data-session-stats-row]')).not.toBeInTheDocument()
    const icon = container.querySelector('[data-session-stats-button]')
    expect(icon).toBeInTheDocument()
    // 11c/23a fix the order of the strip: stats · pin · clear · end ‖
    // collapse (no detach outside the desktop app). The pin
    // and Clear come wrapped in their tooltips, so the buttons are read out
    // of the strip rather than off its direct children.
    // Buttons only: the row's first element is the path and its git reading,
    // which carries an `aria-label` of its own and is not part of the strip.
    // The folded form's ⋯ keeps a hidden seat in the expanded strip, so
    // only buttons outside an `aria-hidden` seat count.
    const strip = icon?.closest('div')
    const names = [...(strip?.querySelectorAll('button[aria-label]') ?? [])]
      .filter((el) => !el.closest('[aria-hidden="true"]'))
      .map((el) => el.getAttribute('aria-label'))
    expect(names).toEqual(['Session stats', 'Pin session', 'Clear', 'End session', 'Collapse panel'])
  })
})

// ---------------------------------------------------------------------------
// The subagent pairing (task 8, spec § 8 "Layout"): with the subagent panel
// open, the detail panel's width is resolved against the pair's 75%
// ceiling — via `resolvePanelPairWidths` (unit-tested for the arithmetic
// itself in `store.test.ts`) — instead of `clampDetailPanelWidth` alone.
// These tests exercise that end to end through the real `<DetailPanel>`, so
// a wiring mistake (the wrong width reaching `<Panel>`, or the pairing
// firing when it should not) fails here even if the pure function is
// correct in isolation.
// ---------------------------------------------------------------------------

describe('DetailPanel — the subagent pairing (task 8)', () => {
  const originalInnerWidth = window.innerWidth

  function setViewportWidth(px: number) {
    Object.defineProperty(window, 'innerWidth', { value: px, configurable: true })
  }

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
  })

  /** The width `<Panel side="right">` is actually drawn at — read off its
   * own inline style, the same live value the drag handle's math writes. */
  function panelWidthPx(container: HTMLElement): number {
    const panel = container.querySelector('[data-side="right"]') as HTMLElement
    return Number(panel.style.width.replace('px', ''))
  }

  it('regression: with no subagent panel open, the width is exactly clampDetailPanelWidth — 60% share included', async () => {
    // A stored width past the pair's own 75% ceiling but under the
    // single-panel 60% one: if this were ever routed through
    // `resolvePanelPairWidths` regardless of whether a subagent panel is
    // open, the two ceilings would disagree and this assertion would fail.
    setViewportWidth(1000)
    resetStore({
      sessions: { a: webSession },
      settings: { detail_panel_width: '900' },
      ui: { selectedId: 'a' },
    })
    const { container } = render(<DetailPanel />)

    expect(panelWidthPx(container)).toBe(clampDetailPanelWidth(900, 1000))
    expect(panelWidthPx(container)).toBe(600)
  })

  it('both panels fit under the ceiling at a wide viewport: the detail panel keeps its stored width', async () => {
    setViewportWidth(1600)
    resetStore({
      sessions: { a: webSession },
      settings: { detail_panel_width: '450' },
      ui: { selectedId: 'a' },
      subagentPanel: openSubagentPanelFor('a'),
    })
    const { container } = render(<DetailPanel />)

    expect(panelWidthPx(container)).toBe(450)
  })

  it('the ceiling bites: the detail panel shrinks, giving up exactly what the subagent panel (plus the gutter) needs', async () => {
    // Ceiling at 1100px viewport = 825; 450 (stored) + 16 (gutter) + 380
    // (subagent default) = 846 overshoots it, so the detail panel gives way
    // to 825 - 16 - 380 = 429 (fix round 1: the ceiling check is
    // gutter-inclusive — see the ADR `panel-pair-ceiling-includes-the-gutter`).
    setViewportWidth(1100)
    resetStore({
      sessions: { a: webSession },
      settings: { detail_panel_width: '450' },
      ui: { selectedId: 'a' },
      subagentPanel: openSubagentPanelFor('a'),
    })
    const { container } = render(<DetailPanel />)

    expect(panelWidthPx(container)).toBe(429)
  })

  it('the ceiling bites harder: the detail panel pins at its own 360px floor', async () => {
    // Ceiling at 900px viewport = 675; even 360 + 16 (gutter) + 380 (756)
    // overshoots it, so the detail panel pins at its floor (the subagent
    // panel is the one that gives up the rest — `resolvePanelPairWidths`'s
    // own tests cover that half; `SubagentPanel` is not mounted by this
    // component).
    setViewportWidth(900)
    resetStore({
      sessions: { a: webSession },
      settings: { detail_panel_width: '450' },
      ui: { selectedId: 'a' },
      subagentPanel: openSubagentPanelFor('a'),
    })
    const { container } = render(<DetailPanel />)

    expect(panelWidthPx(container)).toBe(DETAIL_PANEL_MIN_PX)
  })

  it('dragging the detail panel wider while the subagent panel is open cannot push the pair past the ceiling', async () => {
    const firePointer = (el: Element, type: string, clientX: number) =>
      fireEvent(el, new MouseEvent(type, { bubbles: true, clientX }))

    // Ceiling at 1200px viewport = 900. The single-panel ceiling alone
    // (60% of 1200 = 720) lets the drag reach 720 — the pair ceiling does
    // not, so the panel must draw narrower than what was actually dragged
    // to: 900 - 16 (gutter) - 380 (subagent) = 504.
    setViewportWidth(1200)
    resetStore({
      sessions: { a: webSession },
      settings: { detail_panel_width: '450' },
      ui: { selectedId: 'a' },
      subagentPanel: openSubagentPanelFor('a'),
    })
    const { container } = render(<DetailPanel />)

    const handle = screen.getByRole('separator', { name: /resize panel/i })
    firePointer(handle, 'pointerdown', 500)
    firePointer(handle, 'pointermove', 230) // startWidth 450 + (500 - 230) = 720

    // The NOMINAL stored width still tracks the drag up to its own
    // single-panel ceiling, exactly as it always has (requirement 1).
    expect(useOrbital.getState().settings.detail_panel_width).toBe('720')
    // But the panel is never actually DRAWN past the pair ceiling.
    expect(panelWidthPx(container)).toBe(504)
    expect(panelWidthPx(container)).toBeLessThan(720)
  })

  it('closing the subagent panel returns the detail panel to its stored width', async () => {
    // Ceiling bites hard enough at this viewport to pin the detail panel at
    // its 360px floor while open (fix round 1's own worked example — see
    // `store.test.ts`'s "locks the gutter-inclusive reading in at V=1000"
    // test); closing the subagent panel must hand the detail panel its
    // stored 450 back regardless.
    setViewportWidth(1000)
    resetStore({
      sessions: { a: webSession },
      settings: { detail_panel_width: '450' },
      ui: { selectedId: 'a' },
      subagentPanel: openSubagentPanelFor('a'),
    })
    const { container } = render(<DetailPanel />)
    expect(panelWidthPx(container)).toBe(DETAIL_PANEL_MIN_PX)

    act(() => {
      useOrbital.setState({ subagentPanel: null })
    })

    expect(panelWidthPx(container)).toBe(450)
  })
})

// ---------------------------------------------------------------------------
// Session shortcuts (spec 2026-09-23-shortcuts-design § 2): each one does what
// the header or composer control it stands for does, and only while that
// control is on screen.
// ---------------------------------------------------------------------------

describe('DetailPanel session shortcuts', () => {
  let uninstallKeys: () => void
  beforeEach(() => {
    uninstallKeys = installKeyListener()
  })
  afterEach(() => {
    uninstallKeys()
    delete (window as { orbitalDesktop?: unknown }).orbitalDesktop
  })

  /** Dispatches a keydown and reports whether a command took it. */
  function press(init: KeyboardEventInit): boolean {
    const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
    act(() => {
      document.body.dispatchEvent(event)
    })
    return event.defaultPrevented
  }

  it('⌘. opens the Stop dialog only while the session is working, as the Stop button does', async () => {
    await renderDetail({ session: makeSession({ id: 'a', status: 'idle' }) })
    expect(press({ key: '.', code: 'Period', metaKey: true })).toBe(false)
    expect(useOrbital.getState().ui.dialog).toBeNull()

    await act(async () => {
      useOrbital.setState((s) => ({
        sessions: { ...s.sessions, a: { ...s.sessions.a, status: 'working' } },
      }))
    })
    press({ key: '.', code: 'Period', metaKey: true })
    expect(useOrbital.getState().ui.dialog).toBe('stop')
  })

  it('⌘⌫ opens the End dialog for an Orbital session, never for a terminal one', async () => {
    await renderDetail({ session: webSession })
    press({ key: 'Backspace', code: 'Backspace', metaKey: true })
    expect(useOrbital.getState().ui.dialog).toBe('end')

    cleanup()
    await renderDetail({ session: makeSession({ id: 't', source: 'terminal' }) })
    expect(press({ key: 'Backspace', code: 'Backspace', metaKey: true })).toBe(false)
    expect(useOrbital.getState().ui.dialog).toBeNull()
  })

  it('⌘P toggles the pin', async () => {
    // Spied before the render, as the pin toggle's own test does: the panel
    // reads the action off the store when it renders.
    resetStore({ sessions: { a: webSession }, ui: { selectedId: 'a' } })
    const pinSpy = vi.spyOn(useOrbital.getState(), 'setSessionPinned').mockResolvedValue(undefined)
    render(<DetailPanel />)

    press({ key: 'p', code: 'KeyP', metaKey: true })
    expect(pinSpy).toHaveBeenCalledWith('a', true)
  })

  it('⌘T opens the tag select', async () => {
    await renderDetail({ session: makeSession({ id: 'a', tagIds: [1] }) })

    press({ key: 't', code: 'KeyT', metaKey: true })

    const trigger = screen.getByRole('combobox', { name: 'Change tag' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('listbox', { name: 'Change tag' })).toBeInTheDocument()
  })

  it('⌘⇧D opens the session in a window of its own when the desktop bridge is there', async () => {
    const detachSession = vi.fn()
    ;(window as { orbitalDesktop?: unknown }).orbitalDesktop = { detachSession }
    await renderDetail({ session: webSession })

    press({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true })
    expect(detachSession).toHaveBeenCalledWith('a')
  })

  it('⌘⇧D leaves the key alone in a browser, where there is no detach control', async () => {
    await renderDetail({ session: webSession })
    expect(press({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true })).toBe(false)
  })
})
