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

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return {
    ApiError: actual.ApiError,
    api: {
      listSessions: vi.fn(),
      getSession: vi.fn(),
      getMessages: vi.fn(),
      sendMessage: vi.fn(),
      interrupt: vi.fn(),
      clearSession: vi.fn(),
      renameSession: vi.fn(),
      setSessionTags: vi.fn(),
      createSession: vi.fn(),
      listTags: vi.fn(),
      createTag: vi.fn(),
      patchTag: vi.fn(),
      deleteTag: vi.fn(),
      listTagRules: vi.fn(),
      createTagRule: vi.fn(),
      patchTagRule: vi.fn(),
      deleteTagRule: vi.fn(),
      previewRule: vi.fn(),
      listProjects: vi.fn(),
      listModels: vi.fn(),
      setSessionModel: vi.fn(),
      getSettings: vi.fn(),
      patchSettings: vi.fn(),
    } satisfies Record<keyof typeof actual.api, unknown>,
  }
})

import { api } from '../lib/api'
import { NewSessionDialog } from '../panels/NewSessionDialog'

const workTag: Tag = { id: 1, name: 'work', hue: 210, is_default: 0 }
const defaultTag: Tag = { id: 2, name: 'default', hue: 60, is_default: 1 }

const defaultUi: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  hideEnded: false,
  wsStatus: 'connected',
  dialog: 'new',
  sidebarCollapsed: false,
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
      })
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
  it('labels the four field groups with 1d\'s mono kickers', async () => {
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())

    for (const kicker of ['PROJECT DIRECTORY', 'PERMISSION MODE', 'FIRST PROMPT']) {
      expect(screen.getByText(kicker)).toBeInTheDocument()
    }
    expect(screen.getByText(/^TAG$/)).toBeInTheDocument()
  })

  it('leaves out 1d\'s "Browse…" button (deferred past v1)', async () => {
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())

    expect(screen.queryByRole('button', { name: /browse/i })).not.toBeInTheDocument()
  })

  it('renders recent dirs as mono path pills under the RECENT kicker, not tag chips', async () => {
    vi.mocked(api.listProjects).mockResolvedValue([{ cwd: '/a/proj', lastModel: null }])
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)

    await waitFor(() => expect(chip('~/a/proj')).toBeInTheDocument())
    expect(screen.getByText('RECENT')).toBeInTheDocument()
    expect(chip('~/a/proj').className).toMatch(/font-mono/)
    expect(chip('~/a/proj')).toHaveAttribute('title', '/a/proj')
  })

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

  it('gives the first-prompt textarea 1d\'s four rows', async () => {
    resetStore()
    render(<NewSessionDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(api.listProjects).toHaveBeenCalled())

    expect(screen.getByLabelText(/first prompt/i)).toHaveAttribute('rows', '4')
  })
})
