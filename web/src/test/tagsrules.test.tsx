import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { ApiSession, Tag, TagRule } from '../lib/types'
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
      getSettings: vi.fn(),
      patchSettings: vi.fn(),
    } satisfies Record<keyof typeof actual.api, unknown>,
  }
})

import { api } from '../lib/api'
import { TagsRules } from '../panels/TagsRules'

const workTag: Tag = { id: 1, name: 'work', hue: 210, is_default: 0 }
const defaultTag: Tag = { id: 2, name: 'default', hue: 60, is_default: 1 }

const rule1: TagRule = { id: 10, tag_id: 1, position: 0, enabled: 1, condition: 'path_matches', pattern: '/work/**' }
const rule2: TagRule = { id: 20, tag_id: 2, position: 1, enabled: 1, condition: 'title_contains', pattern: 'bug' }

function makeSession(overrides: Partial<ApiSession> & { id: string }): ApiSession {
  return {
    cwd: '/x',
    title: 'x',
    firstAt: 1,
    lastAt: 1,
    messageCount: 0,
    source: 'web',
    permissionMode: 'acceptEdits',
    parentId: null,
    tagIds: [],
    status: 'idle',
    ...overrides,
  }
}

const defaultUi: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  wsStatus: 'connected',
  dialog: 'tags',
  sidebarCollapsed: false,
}

function resetStore(
  overrides: Partial<Omit<OrbitalState, 'ui'>> & { ui?: Partial<OrbitalUiState> } = {}
) {
  useOrbital.setState({
    sessions: {},
    order: [],
    tags: [workTag, defaultTag],
    rules: [rule1, rule2],
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
  vi.mocked(api.previewRule).mockResolvedValue({ tagId: null, ruleId: null })
})

describe('TagsRules', () => {
  it('renders nothing when closed', () => {
    resetStore()
    const { container } = render(<TagsRules open={false} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows session and rule counts per tag', () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', tagIds: [1] }),
        b: makeSession({ id: 'b', tagIds: [1] }),
      },
    })
    render(<TagsRules open onClose={vi.fn()} />)

    expect(screen.getByText('2 sessions · 1 rules')).toBeInTheDocument()
    expect(screen.getByText('0 sessions · 1 rules')).toBeInTheDocument()
  })

  it('disables delete for the default tag but not others', () => {
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Delete default' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete work' })).not.toBeDisabled()
  })

  it('renames a tag on blur', async () => {
    vi.mocked(api.patchTag).mockResolvedValue({ ok: true })
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    const nameField = screen.getByLabelText('Tag name for work')
    fireEvent.change(nameField, { target: { value: 'projects' } })
    fireEvent.blur(nameField)

    await waitFor(() => expect(api.patchTag).toHaveBeenCalledWith(1, { name: 'projects' }))
    expect(useOrbital.getState().tags.find((t) => t.id === 1)?.name).toBe('projects')
  })

  it('patches hue when a swatch is clicked', async () => {
    vi.mocked(api.patchTag).mockResolvedValue({ ok: true })
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    const swatches = screen.getAllByRole('button', { name: /^Hue /, hidden: false })
    const hue330 = screen.getByRole('group', { name: 'Hue for work' }).querySelector('[aria-label="Hue 330"]')!
    fireEvent.click(hue330)

    await waitFor(() => expect(api.patchTag).toHaveBeenCalledWith(1, { hue: 330 }))
    expect(useOrbital.getState().tags.find((t) => t.id === 1)?.hue).toBe(330)
    expect(swatches.length).toBeGreaterThan(0)
  })

  it('creates a tag then refreshes the tag list from the server', async () => {
    vi.mocked(api.createTag).mockResolvedValue(3)
    const newTagsList: Tag[] = [workTag, defaultTag, { id: 3, name: 'urgent', hue: 10, is_default: 0 }]
    vi.mocked(api.listTags).mockResolvedValue(newTagsList)
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('New tag name'), { target: { value: 'urgent' } })
    fireEvent.click(screen.getByRole('button', { name: '+ new tag' }))

    await waitFor(() => expect(api.createTag).toHaveBeenCalledWith({ name: 'urgent', hue: expect.any(Number) }))
    await waitFor(() => expect(api.listTags).toHaveBeenCalled())
    await waitFor(() => expect(useOrbital.getState().tags).toEqual(newTagsList))
  })

  it('reorders a rule down by swapping positions with the next rule via two PATCHes', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Move rule 1 down' }))

    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { position: 1 }))
    expect(api.patchTagRule).toHaveBeenCalledWith(20, { position: 0 })

    await waitFor(() => {
      const state = useOrbital.getState()
      expect(state.rules.find((r) => r.id === 10)?.position).toBe(1)
      expect(state.rules.find((r) => r.id === 20)?.position).toBe(0)
    })
  })

  it('resyncs rules from the server when a reorder swap partially fails (one PATCH rejects)', async () => {
    // The swap is two independent PATCHes with no DB-level transaction —
    // simulate the first landing and the second rejecting.
    vi.mocked(api.patchTagRule).mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new Error('conflict'))
    // What the server actually ended up with after the partial failure —
    // the client can't know this without asking, hence the refetch.
    const serverRules = [
      { ...rule1, position: 1 },
      rule2,
    ]
    vi.mocked(api.listTagRules).mockResolvedValue(serverRules)
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Move rule 1 down' }))

    await waitFor(() => expect(api.listTagRules).toHaveBeenCalled())
    await waitFor(() => expect(useOrbital.getState().rules).toEqual(serverRules))
    expect(useOrbital.getState().toast).toMatchObject({ kind: 'error' })
  })

  it('resyncs rules from the server when a single-PATCH mutation (enable toggle) fails', async () => {
    vi.mocked(api.patchTagRule).mockRejectedValue(new Error('server down'))
    const serverRules = [rule1, rule2]
    vi.mocked(api.listTagRules).mockResolvedValue(serverRules)
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Enable rule 1'))

    await waitFor(() => expect(api.listTagRules).toHaveBeenCalled())
    await waitFor(() => expect(useOrbital.getState().rules).toEqual(serverRules))
  })

  it('disables the up arrow on the first rule and the down arrow on the last', () => {
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Move rule 1 up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move rule 2 down' })).toBeDisabled()
  })

  it('creates a rule targeting the default tag with a camelCase tagId payload, then refreshes rules', async () => {
    vi.mocked(api.createTagRule).mockResolvedValue(30)
    const refreshedRules = [rule1, rule2, { id: 30, tag_id: 2, position: 2, enabled: 1 as const, condition: 'path_matches' as const, pattern: '' }]
    vi.mocked(api.listTagRules).mockResolvedValue(refreshedRules)
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }))

    // Targets the default tag (id 2), not just the first tag in the list.
    await waitFor(() =>
      expect(api.createTagRule).toHaveBeenCalledWith({ tagId: 2, condition: 'path_matches', pattern: '' })
    )
    await waitFor(() => expect(useOrbital.getState().rules).toEqual(refreshedRules))
  })

  it('patches the target tag with a snake_case tag_id payload', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Target tag for rule 1'), { target: { value: '2' } })

    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { tag_id: 2 }))
    expect(useOrbital.getState().rules.find((r) => r.id === 10)?.tag_id).toBe(2)
  })

  it('toggles a rule enabled/disabled', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Enable rule 1'))

    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { enabled: 0 }))
    expect(useOrbital.getState().rules.find((r) => r.id === 10)?.enabled).toBe(0)
  })

  it('debounces the pattern field before patching', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    const patternField = screen.getByLabelText('Pattern for rule 1')
    fireEvent.change(patternField, { target: { value: '/work/*' } })
    fireEvent.change(patternField, { target: { value: '/work/final' } })

    expect(api.patchTagRule).not.toHaveBeenCalled()
    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { pattern: '/work/final' }), {
      timeout: 1000,
    })
    expect(api.patchTagRule).toHaveBeenCalledTimes(1)
  })

  it('deletes a rule', async () => {
    vi.mocked(api.deleteTagRule).mockResolvedValue({ ok: true })
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete rule 1' }))

    await waitFor(() => expect(api.deleteTagRule).toHaveBeenCalledWith(10))
    expect(useOrbital.getState().rules.map((r) => r.id)).toEqual([20])
  })

  it('previews a sample path against the rules, showing the matched tag and its rule number', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: 2, ruleId: 20 })
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Sample path'), { target: { value: '/anything/bug-123' } })

    await waitFor(() =>
      expect(api.previewRule).toHaveBeenCalledWith({
        cwd: '/anything/bug-123',
        title: '',
        permissionMode: null,
      })
    )
    const previewResult = screen.getByTestId('preview-result')
    await waitFor(() => expect(within(previewResult).getByText('default')).toBeInTheDocument())
    expect(within(previewResult).getByText('rule #2')).toBeInTheDocument()
  })

  it('shows "no match" when the preview finds no matching rule', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: null, ruleId: null })
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Sample path'), { target: { value: '/unmatched' } })

    await waitFor(() => expect(api.previewRule).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('no match')).toBeInTheDocument())
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    resetStore()
    render(<TagsRules open onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('shows the evaluation-order caption and the hue/default-fallback footer note', () => {
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    expect(screen.getByText(/evaluated top → bottom, first match wins/i)).toBeInTheDocument()
    expect(screen.getByText(/planet's atmosphere/i)).toBeInTheDocument()
  })
})
