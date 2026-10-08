import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { ApiSession, OrbitalModel, Tag } from '../lib/types'
import { useOrbital, type OrbitalState, type OrbitalUiState } from '../store/store'

// Same shape as modelcards.test.tsx's fixture, so the two never disagree
// about what a model looks like.
const MODELS: OrbitalModel[] = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', family: 'Opus', version: 'Opus 5 with 1M context', shortVersion: 'Opus 5', variant: '1M', blurb: 'Best for everyday, complex tasks', contextWindow: 1_000_000 },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', shortVersion: 'Sonnet 5', variant: null, blurb: 'Efficient for routine tasks', contextWindow: 200_000 },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', family: 'Haiku', version: 'Haiku 4.5', shortVersion: 'Haiku 4.5', variant: null, blurb: 'Fastest for quick answers', contextWindow: null },
]

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

// Launching now goes through the store, which subscribes to the new session's
// topic before its request goes out — so this file reaches the socket. Mocked
// rather than left real: `getSocket()` would otherwise open a WebSocket
// against jsdom on every launch test.
const { subscribeSpy } = vi.hoisted(() => ({ subscribeSpy: vi.fn(() => () => {}) }))
vi.mock('../lib/socket', () => ({
  getSocket: () => ({ subscribe: subscribeSpy }),
}))

import { api } from '../lib/api'
import { NewSessionDialog, openingLaunch } from '../panels/NewSessionDialog'
import { openingClaudeDir } from '../lib/claudeDirs'
import { editorOf, fieldValue, replaceField } from './composerField'

/** RFC 4122 v4, the only shape the CLI accepts as a session id. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const workTag: Tag = { id: 1, name: 'work', hue: 210, is_default: 0 }
const defaultTag: Tag = { id: 2, name: 'default', hue: 60, is_default: 1 }

const defaultUi: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  wsStatus: 'connected',
  dialog: 'new',
  sidebarCollapsed: false,
  fileViewer: null,
}

function resetStore(
  overrides: Partial<Omit<OrbitalState, 'ui'>> & { ui?: Partial<OrbitalUiState> } = {}
) {
  useOrbital.setState({
    sessions: {},
    order: [],
    tags: [workTag, defaultTag],
    rules: [],
    models: [],
    settings: {},
    transcripts: {},
    historyLoaded: {},
    toast: null,
    ...overrides,
    ui: { ...defaultUi, ...overrides.ui },
  })
}

// jsdom implements neither half of the object-URL pair, and the attachment chips
// mint a preview per file. Installed for the file rather than per test: RTL's
// cleanup unmounts AFTER `afterEach`, and the hook revokes on unmount.
URL.createObjectURL = vi.fn(() => 'blob:preview')
URL.revokeObjectURL = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.listProjects).mockResolvedValue([])
  vi.mocked(api.previewRule).mockResolvedValue({ tagId: null, ruleId: null })
  vi.mocked(api.getMessages).mockResolvedValue([])
})

function chip(name: string) {
  return screen.getByRole('button', { name })
}

describe('NewSessionDialog', () => {
  it('prefills cwd and permission mode from settings when opened', async () => {
    resetStore({ settings: { default_project_dir: '/home/tomin/work', default_permission_mode: 'plan' } })

    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())

    expect(screen.getByLabelText(/project directory/i)).toHaveValue('/home/tomin/work')
    expect(screen.getByRole('radio', { name: /^plan$/i })).toHaveAttribute('aria-checked', 'true')
  })

  it('opens on the previous launch`s directory, mode and manual tag instead of the defaults', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: 2, ruleId: 10 })
    resetStore({
      settings: {
        default_project_dir: '/home/tomin/default',
        default_permission_mode: 'acceptEdits',
        new_session_last_cwd: '/home/tomin/orbital',
        new_session_last_mode: 'plan',
        new_session_last_tag: '1',
      },
    })

    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.previewRule).toHaveBeenCalled())

    expect(screen.getByLabelText(/project directory/i)).toHaveValue('/home/tomin/orbital')
    expect(screen.getByRole('radio', { name: /^plan$/i })).toHaveAttribute('aria-checked', 'true')
    // The remembered pick beats the rule's match in its own directory…
    expect(chip('work')).toHaveAttribute('data-active', 'true')

    // …and nowhere else.
    fireEvent.change(screen.getByLabelText(/project directory/i), { target: { value: '/elsewhere' } })
    await waitFor(() => expect(chip('default')).toHaveAttribute('data-active', 'true'))
  })

  it('never carries bypassPermissions over to the next open', async () => {
    resetStore({
      settings: { default_permission_mode: 'acceptEdits', new_session_last_mode: 'bypassPermissions' },
    })

    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())

    expect(screen.getByRole('radio', { name: /^acceptEdits$/i })).toHaveAttribute('aria-checked', 'true')
  })

  it('remembers the launch, storing the tag only when it was picked by hand', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: 1, ruleId: 10 })
    vi.mocked(api.createSession).mockResolvedValue('s1')
    resetStore()

    const { unmount } = render(<NewSessionDialog open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/project directory/i), { target: { value: ' /home/tomin/orbital ' } })
    fireEvent.click(screen.getByRole('radio', { name: /^plan$/i }))
    await waitFor(() => expect(chip('work')).toHaveAttribute('data-active', 'true'))
    fireEvent.click(screen.getByRole('button', { name: /launch session/i }))

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({
        new_session_last_cwd: '/home/tomin/orbital',
        new_session_last_mode: 'plan',
        new_session_last_tag: '',
      })
    )
    unmount()

    render(<NewSessionDialog open onClose={vi.fn()} />)
    fireEvent.click(chip('default'))
    fireEvent.click(screen.getByRole('button', { name: /launch session/i }))
    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenLastCalledWith(expect.objectContaining({ new_session_last_tag: '2' }))
    )
  })

  it('fetches recent directories on open and renders them as clickable chips', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { cwd: '/a/proj', lastModel: null, lastAt: null },
      { cwd: '/b/proj', lastModel: null, lastAt: null },
    ])
    resetStore()

    render(<NewSessionDialog open onClose={vi.fn()} />)

    await waitFor(() => expect(chip('~/a/proj')).toBeInTheDocument())
    fireEvent.click(chip('~/b/proj'))
    expect(screen.getByLabelText(/project directory/i)).toHaveValue('/b/proj')
  })

  it('auto-matches a tag via debounced previewRule as cwd changes', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: 1, ruleId: 10 })
    resetStore()

    render(<NewSessionDialog open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/project directory/i), { target: { value: '/home/tomin/work/x' } })

    await waitFor(() =>
      expect(api.previewRule).toHaveBeenCalledWith({
        cwd: '/home/tomin/work/x',
        title: '',
        permissionMode: 'acceptEdits',
      })
    )
    await waitFor(() => expect(chip('work')).toHaveAttribute('data-active', 'true'))
    expect(screen.getByText(/auto-matched by rule/i)).toBeInTheDocument()
  })

  it('lets a manual tag pick override the auto-match, even after cwd changes again', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: 1, ruleId: 10 })
    resetStore()

    render(<NewSessionDialog open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/project directory/i), { target: { value: '/home/tomin/work/a' } })
    await waitFor(() => expect(chip('work')).toHaveAttribute('data-active', 'true'))

    fireEvent.click(chip('default'))
    expect(chip('default')).toHaveAttribute('data-active', 'true')
    expect(chip('work')).toHaveAttribute('data-active', 'false')

    fireEvent.change(screen.getByLabelText(/project directory/i), { target: { value: '/home/tomin/work/b' } })
    await waitFor(() => expect(api.previewRule).toHaveBeenCalledTimes(2))

    // Manual choice still wins over the fresh auto-match.
    expect(chip('default')).toHaveAttribute('data-active', 'true')
    expect(chip('work')).toHaveAttribute('data-active', 'false')
    expect(screen.queryByText(/auto-matched by rule/i)).not.toBeInTheDocument()
  })

  it('launches with the previewed tag id, then selects the new session and closes', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: 1, ruleId: 10 })
    vi.mocked(api.createSession).mockResolvedValue('new-session-id')
    resetStore()
    const onClose = vi.fn()

    render(<NewSessionDialog open onClose={onClose} />)
    fireEvent.change(screen.getByLabelText(/project directory/i), { target: { value: '/home/tomin/work' } })
    await waitFor(() => expect(chip('work')).toHaveAttribute('data-active', 'true'))
    replaceField(screen.getByRole('textbox', { name: /first prompt/i }), 'do the thing')

    fireEvent.click(screen.getByRole('button', { name: /launch session/i }))

    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith({
        cwd: '/home/tomin/work',
        prompt: 'do the thing',
        permissionMode: 'acceptEdits',
        tagId: 1,
        model: undefined,
        // Minted by the browser, not the server, so the subscribe below could
        // happen first. See `docs/fixes/first-turn-can-outrun-the-ws-subscription.md`.
        sessionId: expect.stringMatching(UUID_V4),
      })
    )

    // The point of the whole arrangement: the topic was subscribed BEFORE the
    // request that starts the session went out, not after it came back.
    const launchedId = vi.mocked(api.createSession).mock.calls[0][0].sessionId
    expect(subscribeSpy).toHaveBeenCalledWith(`session:${launchedId}`, expect.any(Function))
    expect(subscribeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.createSession).mock.invocationCallOrder[0]
    )

    expect(onClose).toHaveBeenCalled()
    await waitFor(() => expect(useOrbital.getState().ui.selectedId).toBe('new-session-id'))
  })

  it('launches on ⌘↵', async () => {
    vi.mocked(api.createSession).mockResolvedValue('new-session-id')
    resetStore()

    render(<NewSessionDialog open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/project directory/i), { target: { value: '/home/tomin/work' } })

    fireEvent.keyDown(document, { key: 'Enter', metaKey: true })

    await waitFor(() => expect(api.createSession).toHaveBeenCalled())
  })

  it('does not launch on ⌘↵ (or via click) with an empty cwd', async () => {
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())

    fireEvent.keyDown(document, { key: 'Enter', metaKey: true })
    expect(api.createSession).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /launch session/i })).toBeDisabled()
  })

  it('shows a footer caption naming the model, permission mode and destination tag', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: 1, ruleId: 10 })
    resetStore({ settings: { default_model: 'sonnet' }, models: MODELS })

    render(<NewSessionDialog open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/project directory/i), { target: { value: '/home/tomin/work' } })

    await waitFor(() => expect(chip('work')).toHaveAttribute('data-active', 'true'))
    expect(screen.getByText(/Sonnet 5 · acceptEdits/)).toBeInTheDocument()
    expect(screen.getByText('WORK')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Model preselection and launch (canvas 4b)
// ---------------------------------------------------------------------------

describe('NewSessionDialog — model group (4b)', () => {
  it('preselects the settings default model', async () => {
    resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([])
    render(<NewSessionDialog open onClose={() => {}} />)
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Sonnet 5' })).toHaveAttribute('aria-checked', 'true')
    )
  })

  it('falls back to the first catalog row when there is no default', async () => {
    resetStore({ settings: {}, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([])
    render(<NewSessionDialog open onClose={() => {}} />)
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Opus 5' })).toHaveAttribute('aria-checked', 'true')
    )
  })

  it('preselects Other, already trusted, when the default is an id the catalog does not list', async () => {
    resetStore({ settings: { default_model: 'claude-opus-4-6' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.createSession).mockResolvedValue('new-1')
    render(<NewSessionDialog open onClose={() => {}} />)
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Other' })).toHaveAttribute('aria-checked', 'true')
    )
    expect(screen.getByRole('radio', { name: 'Opus 5' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText('Model id')).toHaveValue('claude-opus-4-6')
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    fireEvent.click(screen.getByRole('button', { name: /Launch session/ }))
    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-4-6' }))
    )
    // Trusted: it ran or was validated before, so it is not probed again.
    expect(api.validateModel).not.toHaveBeenCalled()
  })

  it('adopts the project last-used model when the toggle is on', async () => {
    resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'haiku', lastAt: null }])
    render(<NewSessionDialog open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Haiku 4.5' })).toHaveAttribute('aria-checked', 'true')
    )
    expect(screen.getByText(/last used here: Haiku/)).toBeInTheDocument()
  })

  it('ignores the project last-used model when the toggle is off', async () => {
    resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'false' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'haiku', lastAt: null }])
    render(<NewSessionDialog open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Sonnet 5' })).toHaveAttribute('aria-checked', 'true')
    )
  })

  it('a manual pick survives a later cwd change', async () => {
    resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'haiku', lastAt: null }])
    render(<NewSessionDialog open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Opus 5' }))
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    await waitFor(() => expect(screen.getByLabelText('PROJECT DIRECTORY')).toHaveValue('/w/x'))
    expect(screen.getByRole('radio', { name: 'Opus 5' })).toHaveAttribute('aria-checked', 'true')
  })

  it('adopts and names the project last-used model when only a resolved id is known (terminal launch)', async () => {
    // A terminal-launched session only ever gets a `resolved_model` — F1.
    resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'claude-opus-5', lastAt: null }])
    render(<NewSessionDialog open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Opus 5' })).toHaveAttribute('aria-checked', 'true')
    )
    // The note names the matched row's shortVersion, never the raw id.
    expect(screen.getByText('last used here: Opus 5')).toBeInTheDocument()
    expect(screen.queryByText(/claude-opus-5/)).not.toBeInTheDocument()
  })

  it('preselects Other with the project last model when no catalog row matches it, and shows no note', async () => {
    resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'claude-mystery-1', lastAt: null }])
    render(<NewSessionDialog open onClose={() => {}} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Other' })).toHaveAttribute('aria-checked', 'true')
    )
    expect(screen.getByRole('radio', { name: 'Sonnet 5' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText('Model id')).toHaveValue('claude-mystery-1')
    expect(screen.queryByText(/last used here/)).not.toBeInTheDocument()
  })

  it('holds Launch until an Other id validates, and releases it for a catalog pick', async () => {
    resetStore({ settings: { default_model: 'sonnet' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.createSession).mockResolvedValue('new-1')
    let settle!: (v: Awaited<ReturnType<typeof api.validateModel>>) => void
    vi.mocked(api.validateModel).mockImplementation(() => new Promise((r) => (settle = r)))
    render(<NewSessionDialog open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    const launch = screen.getByRole('button', { name: /Launch session/ })
    await waitFor(() => expect(launch).toBeEnabled())

    fireEvent.click(screen.getByRole('radio', { name: 'Other' }))
    expect(launch).toBeDisabled()
    // ⌘⏎ is held too, not only the button.
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true })

    const field = screen.getByLabelText('Model id')
    fireEvent.change(field, { target: { value: 'claude-opus-4-6' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(api.validateModel).toHaveBeenCalledWith('claude-opus-4-6')
    expect(screen.getByText('checking…')).toBeInTheDocument()
    expect(launch).toBeDisabled()

    settle({ ok: true, model: 'claude-opus-4-6', resolvedModel: 'claude-opus-4-6', contextWindow: 200_000 })
    await waitFor(() => expect(launch).toBeEnabled())
    expect(api.createSession).not.toHaveBeenCalled()
    // The footer names a custom id verbatim.
    expect(screen.getAllByText(/claude-opus-4-6 · acceptEdits/).length).toBeGreaterThan(0)

    // Typing over a validated id takes it back.
    fireEvent.change(field, { target: { value: 'claude-opus-4-6x' } })
    expect(launch).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: 'Haiku 4.5' }))
    expect(launch).toBeEnabled()
    expect(screen.queryByLabelText('Model id')).not.toBeInTheDocument()
    fireEvent.click(launch)
    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }))
    )
  })

  it('launches with the chosen model', async () => {
    resetStore({ settings: { default_model: 'sonnet' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([])
    vi.mocked(api.createSession).mockResolvedValue('new-1')
    render(<NewSessionDialog open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Haiku 4.5' }))
    fireEvent.click(screen.getByRole('button', { name: /Launch session/ }))
    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }))
    )
  })
})

// ---------------------------------------------------------------------------
// Canvas 1d structure
// ---------------------------------------------------------------------------

describe('NewSessionDialog — canvas 1d structure', () => {
  it('puts the auto-match caption inline in the TAG kicker (1d)', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: 1, ruleId: 10 })
    resetStore({
      rules: [{ id: 10, tag_id: 1, position: 0, enabled: 1, condition: 'path_matches', pattern: '~/work/**' }],
    })

    render(<NewSessionDialog open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/project directory/i), {
      target: { value: '/home/tomin/work' },
    })

    await waitFor(() => expect(chip('work')).toHaveAttribute('data-active', 'true'))
    const caption = screen.getByText(/auto-matched by rule ~\/work\/\*\*/)
    expect(caption.parentElement?.textContent).toMatch(/^TAG/)
  })
})

// ---------------------------------------------------------------------------
// FIRST PROMPT is the shared Composer (canvas 9d)
// ---------------------------------------------------------------------------

describe('NewSessionDialog — FIRST PROMPT is the composer', () => {
  const field = () => screen.getByRole('textbox', { name: /first prompt/i })

  it('mounts the composer, with its editor and the dialog`s own hint copy', async () => {
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())

    expect(document.querySelector('[data-composer-field]')).not.toBeNull()
    expect(
      screen.getByText('⏎ newline · ⌘⏎ start session · ⌘V paste image')
    ).toBeInTheDocument()
    // The kicker still labels it, so the field keeps its id.
    expect(field()).toHaveAttribute('id', 'new-session-prompt')
  })

  it('leaves ⏎ as a newline — it never launches', async () => {
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/project directory/i), {
      target: { value: '/home/tomin/work' },
    })

    // The composer's own newline happens: a second paragraph, no launch.
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(editorOf(field()).state.doc.childCount).toBe(2)
    expect(api.createSession).not.toHaveBeenCalled()
  })

  it('still launches on ⌘⏎ from inside the field, even with the popup open', async () => {
    vi.mocked(api.createSession).mockResolvedValue('new-session-id')
    vi.mocked(api.commands).mockResolvedValue([
      { name: '/commit', description: 'Commit', source: 'project' },
    ])
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/project directory/i), {
      target: { value: '/home/tomin/work' },
    })

    // Open the completion popup, which owns a bare ⏎ but never a chord.
    replaceField(field(), '/com')
    await screen.findByRole('option', { name: /\/commit/ })

    fireEvent.keyDown(field(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(api.createSession).toHaveBeenCalled())
    // The accept did not happen — ⌘⏎ was the dialog's.
    expect(fieldValue(field())).toBe('/com')
  })

  it('opens the popup below the field (canvas 9d)', async () => {
    vi.mocked(api.commands).mockResolvedValue([
      { name: '/commit', description: 'Commit', source: 'project' },
    ])
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)

    replaceField(field(), '/com')
    await screen.findByRole('option', { name: /\/commit/ })

    const well = document.querySelector('[data-composer-well]') as HTMLElement
    well.getBoundingClientRect = () =>
      ({ left: 100, right: 518, top: 300, bottom: 320, width: 418, height: 20 }) as DOMRect
    fireEvent(window, new Event('resize'))

    const shell = document.querySelector('[data-completion-popup]') as HTMLElement
    expect(shell.dataset.placement).toBe('below')
  })

  it('completes against the chosen directory, not a session', async () => {
    vi.mocked(api.commands).mockResolvedValue([])
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/project directory/i), {
      target: { value: '/home/tomin/work ' },
    })

    replaceField(field(), '/')
    await waitFor(() =>
      expect(api.commands).toHaveBeenCalledWith({ cwd: '/home/tomin/work' })
    )
  })
})

// ---------------------------------------------------------------------------
// Image intake in the dialog (canvas 9d-D). The same chips and the same drop
// state as the panel, with three differences the mount owns: the upload has no
// session to go through, the drop target is the dialog surface, and the footer
// counts what is attached.
// ---------------------------------------------------------------------------

describe('NewSessionDialog — image intake (9d-D)', () => {
  const REF = `${'a'.repeat(64)}.png`

  const field = () => screen.getByRole('textbox', { name: /first prompt/i })
  const surface = () => screen.getByRole('dialog')
  const chips = () => screen.queryAllByTestId('attachment-chip')
  const marker = () => screen.queryByTestId('drop-marker')
  const refusal = () => screen.queryByTestId('composer-refusal')
  const launchButton = () => screen.getByRole('button', { name: /launch session/i })

  function fakeFile(name: string, type: string, size = 421_888): File {
    const file = new File([new Uint8Array(1)], name, { type })
    Object.defineProperty(file, 'size', { value: size })
    return file
  }

  const png = (name = 'flamegraph.png', size = 421_888) => fakeFile(name, 'image/png', size)

  /** jsdom has no DataTransfer — the same shim `composerintake.test.tsx` uses. */
  function makeDataTransfer(files: File[]) {
    return {
      files,
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      types: files.length > 0 ? ['Files'] : [],
      dropEffect: '',
      effectAllowed: '',
    } as unknown as DataTransfer
  }

  function fillCwd(value = '/home/tomin/work') {
    fireEvent.change(screen.getByLabelText(/project directory/i), { target: { value } })
  }

  beforeEach(() => {
    vi.mocked(api.uploadAttachment).mockResolvedValue({
      kind: 'ok',
      entry: { ref: REF, w: 2048, h: 1152, bytes: 421_888 },
    })
  })

  it('takes a pasted image through the sessionless route and carries the ref into the launch', async () => {
    vi.mocked(api.createSession).mockResolvedValue('new-1')
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    fillCwd()

    fireEvent.paste(field(), { clipboardData: makeDataTransfer([png()]) })

    await waitFor(() => expect(chips()).toHaveLength(1))
    // `null`, not a session id: the session does not exist until Launch.
    expect(api.uploadAttachment).toHaveBeenCalledWith(null, expect.any(File), {
      signal: expect.any(AbortSignal),
    })
    // The chip lives in the FIRST PROMPT well, above the text (9d-D).
    expect(document.querySelector('[data-composer-well] [data-composer-chips]')).not.toBeNull()
    await waitFor(() => expect(chips()[0]).toHaveAttribute('data-state', 'uploaded'))

    fireEvent.click(launchButton())
    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ attachments: [REF] })
      )
    )
    // Text and chips clear together (9c-3).
    expect(chips()).toHaveLength(0)
  })

  it('launches without an `attachments` key when nothing is attached', async () => {
    vi.mocked(api.createSession).mockResolvedValue('new-1')
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    fillCwd()

    fireEvent.click(launchButton())
    await waitFor(() => expect(api.createSession).toHaveBeenCalled())
    expect(vi.mocked(api.createSession).mock.calls[0][0].attachments).toBeUndefined()
  })

  it('waits for an upload still in flight rather than launching without it', async () => {
    let settle!: (value: { kind: 'ok'; entry: typeof entryValue }) => void
    const entryValue = { ref: REF, w: 2048, h: 1152, bytes: 421_888 }
    vi.mocked(api.uploadAttachment).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve
      })
    )
    vi.mocked(api.createSession).mockResolvedValue('new-1')
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    fillCwd()
    fireEvent.paste(field(), { clipboardData: makeDataTransfer([png()]) })
    await waitFor(() => expect(chips()).toHaveLength(1))

    fireEvent.click(launchButton())
    // The launch is queued behind the upload — nothing has gone out yet.
    await Promise.resolve()
    expect(api.createSession).not.toHaveBeenCalled()

    settle({ kind: 'ok', entry: entryValue })
    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ attachments: [REF] })
      )
    )
  })

  it('arms the DIALOG on a drag carrying images, and the well becomes the marker', async () => {
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    replaceField(field(), 'kept under the marker')

    fireEvent.dragEnter(surface(), { dataTransfer: makeDataTransfer([png()]) })

    expect(surface()).toHaveAttribute('data-drop-armed', 'true')
    expect(marker()).toHaveTextContent('DROP TO ATTACH')
    expect(fieldValue(field())).toBe('kept under the marker')
  })

  it('is not armed by a drag over the scrim outside the dialog surface', async () => {
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)

    fireEvent.dragEnter(document.body, { dataTransfer: makeDataTransfer([png()]) })
    expect(surface()).not.toHaveAttribute('data-drop-armed')
    expect(marker()).toBeNull()
  })

  it('chips a dropped image on the dialog surface', async () => {
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    const dt = makeDataTransfer([png('dropped.png')])
    fireEvent.dragEnter(surface(), { dataTransfer: dt })
    fireEvent.dragOver(surface(), { dataTransfer: dt })
    fireEvent.drop(surface(), { dataTransfer: dt })

    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(chips()[0].querySelector('[data-chip-name]')).toHaveTextContent('dropped.png')
    expect(surface()).not.toHaveAttribute('data-drop-armed')
  })

  it('replaces the dialog hint line with the refusal, in place', async () => {
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)

    fireEvent.paste(field(), {
      clipboardData: makeDataTransfer([fakeFile('dump.bin', 'application/octet-stream', 130 * 1024 * 1024)]),
    })

    await waitFor(() => expect(refusal()).not.toBeNull())
    expect(refusal()).toHaveTextContent('TOO LARGE TO ATTACH')
    expect(refusal()).toHaveTextContent('dump.bin')
    expect(chips()).toHaveLength(0)
    expect(api.uploadAttachment).not.toHaveBeenCalled()
    expect(
      screen.queryByText('⏎ newline · ⌘⏎ start session · ⌘V paste image')
    ).not.toBeInTheDocument()
  })

  it('counts the images in the footer summary, ahead of the session`s shape (9d-D)', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: 1, ruleId: 10 })
    resetStore({ settings: { default_model: 'sonnet' }, models: MODELS })
    render(<NewSessionDialog open onClose={vi.fn()} />)
    fillCwd()
    await waitFor(() => expect(chip('work')).toHaveAttribute('data-active', 'true'))

    fireEvent.paste(field(), { clipboardData: makeDataTransfer([png()]) })
    // The whole caption, in order: the count leads, then the session's shape.
    const caption = () => surface().querySelector('footer')!.textContent
    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(caption()).toMatch(/^1 image · Sonnet 5 · acceptEdits · WORK/)

    fireEvent.paste(field(), { clipboardData: makeDataTransfer([png('second.png')]) })
    await waitFor(() => expect(chips()).toHaveLength(2))
    expect(caption()).toMatch(/^2 images · Sonnet 5/)
  })

  it('counts only what the launch would carry — a failed chip is not an image the session gets', async () => {
    vi.mocked(api.uploadAttachment).mockRejectedValue(new Error('network'))
    resetStore({ settings: { default_model: 'sonnet' }, models: MODELS })
    render(<NewSessionDialog open onClose={vi.fn()} />)

    fireEvent.paste(field(), { clipboardData: makeDataTransfer([png()]) })
    await waitFor(() => expect(chips()[0]).toHaveAttribute('data-state', 'failed'))
    // The chip is still there, saying so itself; the footer does not promise it.
    expect(surface().querySelector('footer')!.textContent).toMatch(/^Sonnet 5 · /)
  })

  it('drops the chips when the dialog closes, so the next open starts empty', async () => {
    resetStore()
    const { rerender } = render(<NewSessionDialog open onClose={vi.fn()} />)
    fireEvent.paste(field(), { clipboardData: makeDataTransfer([png()]) })
    await waitFor(() => expect(chips()).toHaveLength(1))

    rerender(<NewSessionDialog open={false} onClose={vi.fn()} />)
    rerender(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(chips()).toHaveLength(0))
  })
})

describe('NewSessionDialog — opens on the selected planet', () => {
  const planet = (overrides: Partial<ApiSession> = {}): ApiSession => ({
    id: 'p1',
    cwd: '/home/tomin/planet',
    title: 'planet',
    firstAt: 1,
    lastAt: 100,
    messageCount: 1,
    source: 'web',
    permissionMode: 'acceptEdits',
    model: null,
    resolvedModel: null,
    tagIds: [1],
    status: 'idle',
    subagents: [],
    ...overrides,
  })

  it('takes the planet`s directory and tag, and keeps the last launch`s mode', () => {
    const settings = {
      new_session_last_cwd: '/home/tomin/orbital',
      new_session_last_mode: 'plan',
      new_session_last_tag: '2',
    }
    expect(openingLaunch(settings, planet(), [workTag, defaultTag])).toEqual({
      cwd: '/home/tomin/planet',
      permissionMode: 'plan',
      tag: { cwd: '/home/tomin/planet', tagId: 1, pickedByHand: false },
    })
  })

  it('skips a planet tag that no longer exists, and leaves another directory to the rules', () => {
    const settings = { new_session_last_cwd: '/home/tomin/orbital', new_session_last_tag: '2' }
    expect(openingLaunch(settings, planet({ tagIds: [99] }), [workTag, defaultTag]).tag).toBeNull()
  })

  it('falls back to the remembered hand pick when an untagged planet shares its directory', () => {
    const settings = { new_session_last_cwd: '/home/tomin/planet', new_session_last_tag: '2' }
    expect(openingLaunch(settings, planet({ tagIds: [] }), [workTag, defaultTag]).tag).toEqual({
      cwd: '/home/tomin/planet',
      tagId: 2,
      pickedByHand: true,
    })
  })

  it('is the last launch when nothing is selected', () => {
    const settings = { new_session_last_cwd: '/home/tomin/orbital', new_session_last_tag: '2' }
    expect(openingLaunch(settings, null, [workTag, defaultTag])).toEqual({
      cwd: '/home/tomin/orbital',
      permissionMode: 'acceptEdits',
      tag: { cwd: '/home/tomin/orbital', tagId: 2, pickedByHand: true },
    })
  })

  it('opens on the planet, and a launch does not store its tag as a hand pick', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: 2, ruleId: 10 })
    vi.mocked(api.createSession).mockResolvedValue('s1')
    resetStore({
      sessions: { p1: planet() },
      order: ['p1'],
      settings: { new_session_last_cwd: '/home/tomin/orbital' },
      ui: { selectedId: 'p1' },
    })

    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.previewRule).toHaveBeenCalled())

    expect(screen.getByLabelText(/project directory/i)).toHaveValue('/home/tomin/planet')
    expect(chip('work')).toHaveAttribute('data-active', 'true')

    fireEvent.click(screen.getByRole('button', { name: /launch session/i }))
    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/home/tomin/planet', tagId: 1 })),
    )
    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith(
        expect.objectContaining({ new_session_last_cwd: '/home/tomin/planet', new_session_last_tag: '' }),
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// The Claude directory (spec 2026-10-04-multiple-claude-directories-design § 3)
// ---------------------------------------------------------------------------

describe('openingClaudeDir — the prefill order', () => {
  const dirs = [
    { id: 1, name: 'Personal' },
    { id: 2, name: 'Work' },
    { id: 3, name: 'Client' },
  ]

  it('takes the selected planet`s directory first', () => {
    expect(openingClaudeDir({ dirs, planet: 3, last: 2, fallback: 1 })).toBe(3)
  })

  it('takes the last launch`s choice when no planet is selected', () => {
    expect(openingClaudeDir({ dirs, planet: null, last: 2, fallback: 1 })).toBe(2)
  })

  it('falls back to the default when nothing launched yet', () => {
    expect(openingClaudeDir({ dirs, planet: undefined, last: null, fallback: 3 })).toBe(3)
  })

  it('lets a removed directory fall through to the next step', () => {
    expect(openingClaudeDir({ dirs, planet: 9, last: 2, fallback: 1 })).toBe(2)
    expect(openingClaudeDir({ dirs, planet: 9, last: 8, fallback: 1 })).toBe(1)
    // Even the default may be stale in the store: the first directory there is.
    expect(openingClaudeDir({ dirs, planet: 9, last: 8, fallback: 7 })).toBe(1)
  })

  it('has nothing to choose from a server without directories', () => {
    expect(openingClaudeDir({ dirs: [], planet: 1, last: 1, fallback: 1 })).toBeNull()
  })
})

describe('NewSessionDialog — the Claude directory', () => {
  const dirs = [
    { id: 1, name: 'Personal' },
    { id: 2, name: 'Work' },
  ]

  it('launches under the selected planet`s directory, with that account`s models', async () => {
    vi.mocked(api.createSession).mockResolvedValue('s1')
    resetStore({
      sessions: {
        p1: {
          id: 'p1', cwd: '/home/tomin/planet', title: 'planet', firstAt: 1, lastAt: 100, messageCount: 1,
          source: 'web', permissionMode: 'acceptEdits', model: null, resolvedModel: null, tagIds: [],
          status: 'idle', subagents: [], claudeDirId: 2,
        },
      },
      order: ['p1'],
      claudeDirs: dirs,
      defaultClaudeDir: 1,
      lastClaudeDir: 1,
      ui: { selectedId: 'p1' },
    })

    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(api.listModels).toHaveBeenCalledWith(2))

    fireEvent.click(screen.getByRole('button', { name: /launch session/i }))
    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ claudeDirId: 2 })),
    )
  })

  it('offers no choice and sends none with a single directory', async () => {
    vi.mocked(api.createSession).mockResolvedValue('s1')
    resetStore({
      settings: { default_project_dir: '/home/tomin/work' },
      claudeDirs: [dirs[0]],
      defaultClaudeDir: 1,
      lastClaudeDir: null,
    })

    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())
    expect(screen.queryByRole('group', { name: 'Claude directory' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /launch session/i }))
    await waitFor(() => expect(api.createSession).toHaveBeenCalled())
    expect(vi.mocked(api.createSession).mock.calls[0][0]).not.toHaveProperty('claudeDirId')
  })
})

describe('NewSessionDialog — ⌘D and four or more directories (canvas 44c, 44f)', () => {
  it('steps to the next directory on ⌘D, skipping one missing on disk, and launches under it', async () => {
    vi.mocked(api.createSession).mockResolvedValue('s1')
    resetStore({
      settings: { default_project_dir: '/home/tomin/work' },
      claudeDirs: [
        { id: 1, name: 'Personal' },
        { id: 2, name: 'Work', exists: false },
        { id: 3, name: 'Client' },
      ],
      defaultClaudeDir: 1,
      lastClaudeDir: null,
    })

    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Personal' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Work' })).toBeDisabled()

    // Letters bind by character, so a Czech QWERTZ D is still `d`.
    fireEvent.keyDown(document, { key: 'd', code: 'KeyD', metaKey: true })
    expect(screen.getByRole('button', { name: 'Client' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: /launch session/i }))
    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ claudeDirId: 3 })),
    )
  })

  it('moves the choice to the header control with four directories', async () => {
    vi.mocked(api.createSession).mockResolvedValue('s1')
    resetStore({
      settings: { default_project_dir: '/home/tomin/work' },
      claudeDirs: [
        { id: 1, name: 'Personal' },
        { id: 2, name: 'Work' },
        { id: 3, name: 'Client' },
        { id: 4, name: 'Sandbox' },
      ],
      defaultClaudeDir: 1,
      lastClaudeDir: 2,
    })

    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())
    expect(screen.queryByRole('group', { name: 'Claude directory' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /CLAUDE DIR/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sandbox' }))

    fireEvent.click(screen.getByRole('button', { name: /launch session/i }))
    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ claudeDirId: 4 })),
    )
  })
})

// Spec 2026-10-08-mcpjson-approval-design § Clients: Launch asks about the
// project's undecided `.mcp.json` servers before anything spawns.
describe('NewSessionDialog — the .mcp.json question', () => {
  const SERVERS = [
    { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], source: 'npm' as const },
    { name: 'db-tools', command: './scripts/mcp-db.sh', args: ['--port', '5433'], source: 'file' as const, file: 'scripts/mcp-db.sh' },
  ]

  async function openAndLaunch() {
    vi.mocked(api.createSession).mockResolvedValue('s1')
    resetStore({ settings: { default_project_dir: '/w/indexer' } })
    render(<NewSessionDialog open onClose={vi.fn()} />)
    replaceField(screen.getByRole('textbox', { name: /first prompt/i }), 'profile it')
    fireEvent.click(screen.getByRole('button', { name: /launch session/i }))
  }

  const choice = (server: string, label: string) =>
    within(screen.getByRole('radiogroup', { name: server })).getByRole('radio', { name: label })

  it('launches straight away when nothing is undecided, sending no answers', async () => {
    vi.mocked(api.mcpjson).mockResolvedValue([])
    await openAndLaunch()
    await waitFor(() => expect(api.createSession).toHaveBeenCalled())
    expect(vi.mocked(api.mcpjson).mock.calls[0][0]).toBe('/w/indexer')
    expect(api.createSession).toHaveBeenCalledWith(expect.not.objectContaining({ mcpjson: expect.anything() }))
  })

  it('asks first, and launches with every answer once all are given', async () => {
    vi.mocked(api.mcpjson).mockResolvedValue(SERVERS)
    await openAndLaunch()
    await screen.findByRole('dialog', { name: 'This project wants to run MCP servers' })
    expect(api.createSession).not.toHaveBeenCalled()

    const start = screen.getByRole('button', { name: /start session/i })
    fireEvent.click(choice('playwright', 'Allow'))
    expect(screen.getByText('1 of 2 answered')).toBeInTheDocument()
    // Not ready: neither the button nor ⌘⏎ launches.
    fireEvent.click(start)
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true })
    expect(api.createSession).not.toHaveBeenCalled()

    fireEvent.click(choice('db-tools', "Don't allow"))
    expect(choice('db-tools', "Don't allow")).toHaveAttribute('aria-checked', 'true')
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true })
    await waitFor(() =>
      expect(api.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/w/indexer', prompt: 'profile it', mcpjson: { allow: ['playwright'], deny: ['db-tools'] } }),
      ),
    )
  })

  it('goes back to the form with every field kept, and launches nothing', async () => {
    vi.mocked(api.mcpjson).mockResolvedValue(SERVERS.slice(0, 1))
    await openAndLaunch()
    await screen.findByRole('dialog', { name: 'This project wants to run an MCP server' })
    fireEvent.click(choice('playwright', 'Allow'))
    fireEvent.click(screen.getByRole('button', { name: '← Back' }))

    expect(screen.getByRole('dialog', { name: 'New session' })).toBeInTheDocument()
    expect(screen.getByLabelText(/project directory/i)).toHaveValue('/w/indexer')
    expect(fieldValue(screen.getByRole('textbox', { name: /first prompt/i }))).toBe('profile it')
    expect(api.createSession).not.toHaveBeenCalled()

    // Launching again asks again, from no answers.
    fireEvent.click(screen.getByRole('button', { name: /launch session/i }))
    await screen.findByRole('dialog', { name: 'This project wants to run an MCP server' })
    expect(choice('playwright', 'Allow')).toHaveAttribute('aria-checked', 'false')
  })

  it('treats esc on the question as Back, not as closing the dialog', async () => {
    vi.mocked(api.mcpjson).mockResolvedValue(SERVERS.slice(0, 1))
    const onClose = vi.fn()
    vi.mocked(api.createSession).mockResolvedValue('s1')
    resetStore({ settings: { default_project_dir: '/w/indexer' } })
    render(<NewSessionDialog open onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /launch session/i }))
    await screen.findByRole('dialog', { name: 'This project wants to run an MCP server' })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(await screen.findByRole('dialog', { name: 'New session' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('launches without answers when the servers cannot be read — the Mac keeps them out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(api.mcpjson).mockRejectedValue(new Error('relay down'))
    await openAndLaunch()
    await waitFor(() => expect(api.createSession).toHaveBeenCalled())
    expect(api.createSession).toHaveBeenCalledWith(expect.not.objectContaining({ mcpjson: expect.anything() }))
  })
})
