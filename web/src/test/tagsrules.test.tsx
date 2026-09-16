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
/** Second rule in the SAME (work) tag — reorder swaps happen within one tag's list. */
const workRule2: TagRule = { id: 20, tag_id: 1, position: 1, enabled: 1, condition: 'title_contains', pattern: 'bug' }

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

    // Canvas 1e pluralises and drops the rule count when a tag has none.
    expect(screen.getByText('2 sessions · 1 rule')).toBeInTheDocument()
    expect(screen.getByText('0 sessions · 1 rule · default')).toBeInTheDocument()
  })

  it('omits the rule count for a tag with no rules, keeping the default marker', () => {
    resetStore({ rules: [rule1] })
    render(<TagsRules open onClose={vi.fn()} />)

    expect(screen.getByText('0 sessions · default')).toBeInTheDocument()
  })

  it('disables delete for the default tag but not others (delete lives on the selected card)', () => {
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    // First tag (work) is selected by default and owns the visible delete.
    expect(screen.getByRole('button', { name: 'Delete work' })).not.toBeDisabled()
    // Selecting the default tag's card swaps the delete over — disabled there.
    fireEvent.click(screen.getByText('hue 60'))
    expect(screen.getByRole('button', { name: 'Delete default' })).toBeDisabled()
  })

  it('falls back to the first remaining tag after deleting the selected one', async () => {
    vi.mocked(api.deleteTag).mockResolvedValue({ ok: true })
    vi.mocked(api.listSessions).mockResolvedValue([])
    resetStore({ rules: [rule1, rule2] })
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Delete work' }))

    await waitFor(() => expect(api.deleteTag).toHaveBeenCalledWith(1))
    // The default tag is now the head of the list — its rule is what shows.
    await waitFor(() => expect(screen.getByLabelText('Pattern for rule 1')).toHaveValue('bug'))
    expect(screen.getByRole('group', { name: 'Hue for default' })).toBeInTheDocument()
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
    resetStore({ rules: [rule1, workRule2] })
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
      workRule2,
    ]
    vi.mocked(api.listTagRules).mockResolvedValue(serverRules)
    resetStore({ rules: [rule1, workRule2] })
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
    resetStore({ rules: [rule1, workRule2] })
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

    // Rules are managed per tag — select the default tag's card first; the
    // new rule targets the selected tag.
    fireEvent.click(screen.getByText('hue 60'))
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }))

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

  it('resyncs sessions from the server after a successful rule patch (F2)', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    const staleSession = makeSession({ id: 'sess1', tagIds: [1] })
    const refreshedSession = makeSession({ id: 'sess1', tagIds: [2] })
    vi.mocked(api.listSessions).mockResolvedValue([refreshedSession])
    resetStore({ sessions: { sess1: staleSession } })
    render(<TagsRules open onClose={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Enable rule 1'))

    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { enabled: 0 }))
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledWith({ limit: 200 }))
    await waitFor(() => expect(useOrbital.getState().sessions.sess1.tagIds).toEqual([2]))
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
    expect(within(previewResult).getByText('matched rule 2')).toBeInTheDocument()
    // Canvas 1e's preview row is "PREVIEW · path · → · chip · matched rule N".
    expect(within(previewResult).getByTestId('preview-arrow')).toBeInTheDocument()
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

  it('shows the evaluation-order caption and the hue/default-fallback footer note naming the default tag', () => {
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    expect(screen.getByText(/evaluated top → bottom, first match wins/i)).toBeInTheDocument()
    const note = screen.getByText(/planet's atmosphere/i)
    expect(note).toBeInTheDocument()
    // Canvas 1e names the actual fallback tag, it isn't a generic sentence.
    expect(note.textContent).toContain('fall back to default')
  })

  it('closes from the header back chevron', () => {
    const onClose = vi.fn()
    resetStore()
    render(<TagsRules open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders the 1e panel header: SETTINGS kicker, title and the counted column headings', () => {
    resetStore({ rules: [rule1, workRule2] })
    render(<TagsRules open onClose={vi.fn()} />)

    expect(screen.getByText('SETTINGS')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tags & rules' })).toBeInTheDocument()
    expect(screen.getByText('TAGS · 2')).toBeInTheDocument()
    // Only the selected tag's rules are counted (rules are managed per tag).
    expect(screen.getByText('AUTO-TAG RULES · 2')).toBeInTheDocument()
    ;['CONDITION', 'PATTERN', '→ TAG', 'ON'].forEach((caption) => {
      expect(screen.getByText(caption)).toBeInTheDocument()
    })
  })

  it('shows "saved · just now" in the header only after a mutation lands', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    expect(screen.queryByTestId('save-status')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Enable rule 1'))

    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('saved · just now'))
  })

  it('gives every rule row a decorative drag grip that is not itself interactive', () => {
    resetStore({ rules: [rule1, workRule2] })
    const { container } = render(<TagsRules open onClose={vi.fn()} />)

    const grips = container.querySelectorAll('[data-rule-grip]')
    expect(grips).toHaveLength(2)
    grips.forEach((grip) => {
      // Drag-and-drop is deferred: the grip must read as decoration, with the
      // arrow buttons doing the real reordering.
      expect(grip.getAttribute('aria-hidden')).toBe('true')
      expect(grip.tagName).toBe('SPAN')
      expect(grip).not.toHaveAttribute('tabindex')
      expect(grip.textContent).toBe('⋮⋮')
    })
  })

  it('renders "+ Add rule" as a dashed full-width row at the end of the rules list', () => {
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    const addRow = screen.getByTestId('add-rule-row')
    expect(addRow).toBe(screen.getByRole('button', { name: '+ Add rule' }))
    expect(addRow.className).toContain('border-dashed')
    expect(addRow.className).toContain('w-full')
    // It lives inside the rules list, after the last rule row (canvas 1e).
    const list = addRow.parentElement!
    expect(list.querySelectorAll('[data-rule-row]').length).toBe(1)
    expect(list.lastElementChild).toBe(addRow)
  })

  it('tints the selected tag card in its own hue and keeps swatches + delete off the others', () => {
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    const workCard = document.querySelector('[data-tag-card="1"]') as HTMLElement
    const defaultCard = document.querySelector('[data-tag-card="2"]') as HTMLElement
    expect(workCard.dataset.selected).toBe('true')
    expect(defaultCard.dataset.selected).toBe('false')
    // Canvas 1e: the selected card is tinted with the TAG's hue, not the accent.
    expect(workCard.style.borderColor).toContain('210')
    expect(within(workCard).getByRole('group', { name: 'Hue for work' })).toBeInTheDocument()
    expect(within(defaultCard).queryByRole('group', { name: 'Hue for default' })).not.toBeInTheDocument()
    expect(within(defaultCard).queryByRole('button', { name: 'Delete default' })).not.toBeInTheDocument()
  })

  it('offers the 8 hue swatches of canvas 1e', () => {
    resetStore()
    render(<TagsRules open onClose={vi.fn()} />)

    const swatches = within(screen.getByRole('group', { name: 'Hue for work' })).getAllByRole('button')
    expect(swatches.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Hue 210',
      'Hue 250',
      'Hue 290',
      'Hue 330',
      'Hue 20',
      'Hue 60',
      'Hue 110',
      'Hue 150',
    ])
  })

  it('selects a tag card when one of its controls takes focus (keyboard reachability)', () => {
    resetStore({ rules: [rule1, rule2] })
    render(<TagsRules open onClose={vi.fn()} />)

    // work is selected by default, so rule1 (tag 1) is the only row shown.
    expect(document.querySelectorAll('[data-rule-row]')).toHaveLength(1)
    expect(screen.getByLabelText('Pattern for rule 1')).toHaveValue('/work/**')

    // focusin (not the non-bubbling `focus`) is what React maps onFocus* to.
    fireEvent.focusIn(screen.getByLabelText('Tag name for default'))

    expect(screen.getByLabelText('Pattern for rule 1')).toHaveValue('bug')
  })
})
