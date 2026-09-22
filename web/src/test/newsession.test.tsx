import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { OrbitalModel, Tag } from '../lib/types'
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
import { NewSessionDialog } from '../panels/NewSessionDialog'

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

  it('fetches recent directories on open and renders them as clickable chips', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([
      { cwd: '/a/proj', lastModel: null },
      { cwd: '/b/proj', lastModel: null },
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
    fireEvent.change(screen.getByLabelText(/first prompt/i), { target: { value: 'do the thing' } })

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

  it('falls back to the first catalog row when the default is not offered', async () => {
    resetStore({ settings: { default_model: 'nonexistent' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([])
    render(<NewSessionDialog open onClose={() => {}} />)
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Opus 5' })).toHaveAttribute('aria-checked', 'true')
    )
  })

  it('adopts the project last-used model when the toggle is on', async () => {
    resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'haiku' }])
    render(<NewSessionDialog open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Haiku 4.5' })).toHaveAttribute('aria-checked', 'true')
    )
    expect(screen.getByText(/last used here: Haiku/)).toBeInTheDocument()
  })

  it('ignores the project last-used model when the toggle is off', async () => {
    resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'false' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'haiku' }])
    render(<NewSessionDialog open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Sonnet 5' })).toHaveAttribute('aria-checked', 'true')
    )
  })

  it('a manual pick survives a later cwd change', async () => {
    resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'haiku' }])
    render(<NewSessionDialog open onClose={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Opus 5' }))
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    await waitFor(() => expect(screen.getByLabelText('PROJECT DIRECTORY')).toHaveValue('/w/x'))
    expect(screen.getByRole('radio', { name: 'Opus 5' })).toHaveAttribute('aria-checked', 'true')
  })

  it('adopts and names the project last-used model when only a resolved id is known (terminal launch)', async () => {
    // A terminal-launched session only ever gets a `resolved_model` — F1.
    resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'claude-opus-5' }])
    render(<NewSessionDialog open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Opus 5' })).toHaveAttribute('aria-checked', 'true')
    )
    // The note names the matched row's shortVersion, never the raw id.
    expect(screen.getByText('last used here: Opus 5')).toBeInTheDocument()
    expect(screen.queryByText(/claude-opus-5/)).not.toBeInTheDocument()
  })

  it('shows no note and falls through to the settings default when the last model matches nothing', async () => {
    resetStore({ settings: { default_model: 'sonnet', remember_model_per_project: 'true' }, models: MODELS })
    vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/w/x', lastModel: 'claude-mystery-1' }])
    render(<NewSessionDialog open onClose={() => {}} />)
    fireEvent.change(screen.getByLabelText('PROJECT DIRECTORY'), { target: { value: '/w/x' } })
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'Sonnet 5' })).toHaveAttribute('aria-checked', 'true')
    )
    expect(screen.queryByText(/last used here/)).not.toBeInTheDocument()
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

  it('mounts the composer, with its mirror and the dialog`s own hint copy', async () => {
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())

    expect(document.querySelector('[data-composer-mirror]')).not.toBeNull()
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

    // Not swallowed by the composer: the textarea's own newline happens.
    expect(fireEvent.keyDown(field(), { key: 'Enter' })).toBe(true)
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
    fireEvent.change(field(), { target: { value: '/com' } })
    await screen.findByRole('option', { name: /\/commit/ })

    fireEvent.keyDown(field(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(api.createSession).toHaveBeenCalled())
    // The accept did not happen — ⌘⏎ was the dialog's.
    expect(field()).toHaveValue('/com')
  })

  it('opens the popup below the field (canvas 9d)', async () => {
    vi.mocked(api.commands).mockResolvedValue([
      { name: '/commit', description: 'Commit', source: 'project' },
    ])
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)

    fireEvent.change(field(), { target: { value: '/com' } })
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

    fireEvent.change(field(), { target: { value: '/' } })
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
    fireEvent.change(field(), { target: { value: 'kept under the marker' } })

    fireEvent.dragEnter(surface(), { dataTransfer: makeDataTransfer([png()]) })

    expect(surface()).toHaveAttribute('data-drop-armed', 'true')
    expect(marker()).toHaveTextContent('DROP TO ATTACH')
    expect(field()).toHaveValue('kept under the marker')
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
      clipboardData: makeDataTransfer([fakeFile('spec.pdf', 'application/pdf')]),
    })

    await waitFor(() => expect(refusal()).not.toBeNull())
    expect(refusal()).toHaveTextContent('IMAGES ONLY')
    expect(refusal()).toHaveTextContent('application/pdf')
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
