import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ApiSession, Tag, TagRule } from '../lib/types'
import { useOrbital, type OrbitalState, type OrbitalUiState } from '../store/store'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { Settings } from '../panels/Settings'

const workTag: Tag = { id: 1, name: 'work', hue: 210, is_default: 0 }
const defaultTag: Tag = { id: 2, name: 'default', hue: 60, is_default: 1 }

const rule1: TagRule = { id: 10, tag_id: 1, position: 0, enabled: 1, condition: 'path_matches', pattern: '/work/**' }
const rule2: TagRule = { id: 20, tag_id: 2, position: 1, enabled: 1, condition: 'title_contains', pattern: 'bug' }
/** Second rule in the SAME (work) tag — for cases that need two rows under one tag. */
const workRule2: TagRule = { id: 20, tag_id: 1, position: 1, enabled: 1, condition: 'title_contains', pattern: 'bug' }

/** The row element for a rule id, whichever mode it is currently in. */
function row(id: number): HTMLElement {
  return document.querySelector(`[data-rule-row="${id}"]`) as HTMLElement
}

/** Canvas 1e's resting row is a table cell, not a form — click it to get controls. */
function openRow(n: number): void {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Edit rule ${n}:`) }))
}

function editingRows(): NodeListOf<Element> {
  return document.querySelectorAll('[data-rule-mode="editing"]')
}

/**
 * The condition and target-tag controls are custom listboxes, not
 * `<select>`s: open the trigger, then click the option out of the portalled
 * popup.
 */
function chooseOption(triggerName: string, option: string): void {
  fireEvent.click(screen.getByRole('combobox', { name: triggerName }))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

/** The `⋮⋮` grip of the row currently at position `n` — the one and only reorder control. */
function grip(n: number): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^Reorder rule ${n} of `) })
}

/**
 * jsdom implements neither `DataTransfer` nor real drag-and-drop, so the
 * drag tests below drive React's handlers with a stub. `setDragImage` is
 * deliberately absent — the component feature-detects it.
 */
/**
 * jsdom lays nothing out, so `offsetHeight` is always 0 and the gap-preview
 * maths would be trivially satisfied. Give every row a real height first, so
 * the assertions below are about actual measured distances.
 */
function stubRowHeights(height: number): void {
  document.querySelectorAll<HTMLElement>('[data-rule-row]').forEach((el) => {
    Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  })
}

/** Four rules under one tag — enough that a drag leaves rows on both sides of the moved range. */
const fourRules: TagRule[] = [
  rule1,
  workRule2,
  { id: 30, tag_id: 1, position: 2, enabled: 1, condition: 'path_matches', pattern: '/third' },
  { id: 40, tag_id: 1, position: 3, enabled: 1, condition: 'path_matches', pattern: '/fourth' },
]

function makeDataTransfer() {
  const store: Record<string, string> = {}
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (key: string, value: string) => {
      store[key] = value
    },
    getData: (key: string) => store[key] ?? '',
  }
}

function makeSession(overrides: Partial<ApiSession> & { id: string }): ApiSession {
  return {
    cwd: '/x',
    title: 'x',
    firstAt: 1,
    lastAt: 1,
    messageCount: 0,
    source: 'web',
    permissionMode: 'acceptEdits',
    model: null,
    resolvedModel: null,
    parentId: null,
    mapDismissedAt: null,
    tagIds: [],
    status: 'idle',
    subagents: [],
    ...overrides,
  }
}

const defaultUi: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  wsStatus: 'connected',
  dialog: 'settings',
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
    rules: [rule1, rule2],
    settings: {},
    transcripts: {},
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

/**
 * Tags & rules is a section of the Settings dialog (canvas 1e), not a dialog
 * of its own, so every case here mounts it the way a user reaches it: open
 * Settings, pick the nav row. That keeps the cases that span both components
 * — Escape peeling a row before the dialog, the header's save stamp — honest
 * about what they exercise.
 */
function renderTags() {
  const onClose = vi.fn()
  const view = render(<Settings open onClose={onClose} />)
  fireEvent.click(screen.getByRole('button', { name: 'Tags & rules' }))
  return { ...view, onClose }
}

describe('Settings › Tags & rules', () => {
  it('shows the tag and rule columns only once the nav row is picked', () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    // Sessions is the landing section.
    expect(screen.queryByText('TAGS · 2')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sessions' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Tags & rules' }))

    expect(screen.getByText('TAGS · 2')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tags & rules' })).toBeInTheDocument()
    // And the Sessions rows are gone rather than stacked underneath.
    expect(screen.queryByText('NEW SESSIONS')).not.toBeInTheDocument()
  })

  it('shows session and rule counts per tag', () => {
    resetStore({
      sessions: {
        a: makeSession({ id: 'a', tagIds: [1] }),
        b: makeSession({ id: 'b', tagIds: [1] }),
      },
    })
    renderTags()

    // Canvas 1e pluralises and drops the rule count when a tag has none.
    expect(screen.getByText('2 sessions · 1 rule')).toBeInTheDocument()
    expect(screen.getByText('0 sessions · 1 rule · default')).toBeInTheDocument()
  })

  it('omits the rule count for a tag with no rules, keeping the default marker', () => {
    resetStore({ rules: [rule1] })
    renderTags()

    expect(screen.getByText('0 sessions · default')).toBeInTheDocument()
  })

  it('disables delete for the default tag but not others (delete lives on the selected card)', () => {
    resetStore()
    renderTags()

    // First tag (work) is selected by default and owns the visible delete.
    expect(screen.getByRole('button', { name: 'Delete work' })).not.toBeDisabled()
    // Selecting the default tag's card swaps the delete over — disabled there.
    fireEvent.click(screen.getByText('hue 60'))
    expect(screen.getByRole('button', { name: 'Delete default' })).toBeDisabled()
  })

  it('falls back to the first remaining tag after deleting the selected one, and resyncs its now-orphaned rules', async () => {
    vi.mocked(api.deleteTag).mockResolvedValue({ ok: true })
    vi.mocked(api.listSessions).mockResolvedValue([])
    // The server cascades the delete; the rules column lists EVERY rule, so
    // the client has to ask what survived rather than leave orphan rows.
    vi.mocked(api.listTagRules).mockResolvedValue([rule2])
    resetStore({ rules: [rule1, rule2] })
    renderTags()

    fireEvent.click(screen.getByRole('button', { name: 'Delete work' }))

    await waitFor(() => expect(api.deleteTag).toHaveBeenCalledWith(1))
    await waitFor(() => expect(useOrbital.getState().rules).toEqual([rule2]))
    // The default tag is now the head of the list and owns the swatches.
    expect(screen.getByRole('group', { name: 'Hue for default' })).toBeInTheDocument()
    expect(document.querySelectorAll('[data-rule-row]')).toHaveLength(1)
  })

  it('renames a tag on blur', async () => {
    vi.mocked(api.patchTag).mockResolvedValue({ ok: true })
    resetStore()
    renderTags()

    const nameField = screen.getByLabelText('Tag name for work')
    fireEvent.change(nameField, { target: { value: 'projects' } })
    fireEvent.blur(nameField)

    await waitFor(() => expect(api.patchTag).toHaveBeenCalledWith(1, { name: 'projects' }))
    expect(useOrbital.getState().tags.find((t) => t.id === 1)?.name).toBe('projects')
  })

  it('patches hue when a swatch is clicked', async () => {
    vi.mocked(api.patchTag).mockResolvedValue({ ok: true })
    resetStore()
    renderTags()

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
    renderTags()

    fireEvent.change(screen.getByLabelText('New tag name'), { target: { value: 'urgent' } })
    fireEvent.click(screen.getByRole('button', { name: '+ new tag' }))

    await waitFor(() => expect(api.createTag).toHaveBeenCalledWith({ name: 'urgent', hue: expect.any(Number) }))
    await waitFor(() => expect(api.listTags).toHaveBeenCalled())
    await waitFor(() => expect(useOrbital.getState().tags).toEqual(newTagsList))
  })

  it('reorders across tag boundaries — the evaluation order is one global list', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    // rule1 targets `work`, rule2 targets `default`: moving rule 1 down has to
    // swap it past a rule belonging to a DIFFERENT tag, because the server
    // evaluates one shared top-to-bottom order.
    resetStore({ rules: [rule1, rule2] })
    renderTags()

    fireEvent.keyDown(grip(1), { key: 'ArrowDown' })

    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { position: 1 }))
    expect(api.patchTagRule).toHaveBeenCalledWith(20, { position: 0 })
    await waitFor(() => {
      const state = useOrbital.getState()
      expect(state.rules.find((r) => r.id === 10)?.position).toBe(1)
      expect(state.rules.find((r) => r.id === 20)?.position).toBe(0)
    })
  })

  it('reorders from the keyboard: ArrowDown on the grip moves the rule and keeps focus on it', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore({ rules: [rule1, workRule2] })
    renderTags()

    const handle = grip(1)
    handle.focus()
    fireEvent.keyDown(handle, { key: 'ArrowDown' })

    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { position: 1 }))
    expect(api.patchTagRule).toHaveBeenCalledWith(20, { position: 0 })
    await waitFor(() => {
      const state = useOrbital.getState()
      expect(state.rules.find((r) => r.id === 10)?.position).toBe(1)
      expect(state.rules.find((r) => r.id === 20)?.position).toBe(0)
    })

    // The moved rule is now second — and focus travelled with it, so a second
    // Arrow press acts on the same rule rather than on whatever took its slot.
    expect(grip(2)).toBe(document.querySelector('[data-rule-grip="10"]'))
    expect(grip(2)).toHaveFocus()
  })

  it('announces every keyboard move, and says so when a rule is already at the end', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore({ rules: [rule1, workRule2] })
    renderTags()

    const status = screen.getByTestId('reorder-status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toBeEmptyDOMElement()

    // Refused move at the top of the list: no PATCH, but never silent.
    fireEvent.keyDown(grip(1), { key: 'ArrowUp' })
    expect(api.patchTagRule).not.toHaveBeenCalled()
    expect(status).toHaveTextContent('is already at position 1 of 2')

    fireEvent.keyDown(grip(1), { key: 'ArrowDown' })
    expect(status).toHaveTextContent('moved to position 2 of 2')
    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalled())
  })

  it('reorders by dragging a row onto another by its grip', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore({ rules: [rule1, workRule2] })
    renderTags()

    const dt = makeDataTransfer()
    fireEvent.dragStart(grip(1), { dataTransfer: dt })
    // The travelling row fades and the hovered row takes the landing ring.
    expect(row(10).className).toContain('opacity-40')
    fireEvent.dragOver(row(20), { dataTransfer: dt })
    expect(row(20)).toHaveAttribute('data-drop-target', 'true')

    fireEvent.drop(row(20), { dataTransfer: dt })

    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { position: 1 }))
    expect(api.patchTagRule).toHaveBeenCalledWith(20, { position: 0 })
    expect(screen.getByTestId('reorder-status')).toHaveTextContent('moved to position 2 of 2')
    // Drag chrome is cleared once the drop lands.
    expect(row(10).className).not.toContain('opacity-40')
    expect(row(20)).not.toHaveAttribute('data-drop-target')
  })

  it('treats a drop on the dragged row itself as a no-op', () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore({ rules: [rule1, workRule2] })
    renderTags()

    const dt = makeDataTransfer()
    fireEvent.dragStart(grip(1), { dataTransfer: dt })
    fireEvent.dragOver(row(10), { dataTransfer: dt })
    // A row never rings itself as a landing slot.
    expect(row(10)).not.toHaveAttribute('data-drop-target')
    fireEvent.drop(row(10), { dataTransfer: dt })

    expect(api.patchTagRule).not.toHaveBeenCalled()
    expect(screen.getByTestId('reorder-status')).toHaveTextContent('is already at position 1 of 2')
    expect(useOrbital.getState().rules.find((r) => r.id === 10)?.position).toBe(0)
  })

  it('leaves the order alone when the drag is released outside the list', () => {
    resetStore({ rules: [rule1, workRule2] })
    renderTags()

    const dt = makeDataTransfer()
    fireEvent.dragStart(grip(1), { dataTransfer: dt })
    // Released over nothing that accepts a drop: only `dragend` fires.
    fireEvent.dragEnd(grip(1), { dataTransfer: dt })

    expect(api.patchTagRule).not.toHaveBeenCalled()
    expect(row(10).className).not.toContain('opacity-40')
    expect(useOrbital.getState().rules.find((r) => r.id === 10)?.position).toBe(0)
  })

  it('opens a gap while dragging DOWN: the rows passed shift up, the placeholder rides into the slot', () => {
    resetStore({ rules: fourRules })
    renderTags()
    // 48px rows + the 4px list gap = a 52px slot each.
    stubRowHeights(48)

    const dt = makeDataTransfer()
    fireEvent.dragStart(grip(1), { dataTransfer: dt })
    fireEvent.dragOver(row(30), { dataTransfer: dt })

    // The two rows it passes close over the slot it vacated — one slot each,
    // which is the DRAGGED row's height, not their own.
    expect(row(20).dataset.ruleShift).toBe('up')
    expect(row(20).style.transform).toBe('translateY(-52px)')
    expect(row(30).dataset.ruleShift).toBe('up')
    expect(row(30).style.transform).toBe('translateY(-52px)')
    // The dragged row travels the summed slots of everything it passed, so it
    // lands exactly in the gap that opened.
    expect(row(10).dataset.ruleShift).toBe('down')
    expect(row(10).style.transform).toBe('translateY(104px)')
    // A row beyond the drop index is untouched.
    expect(row(40)).not.toHaveAttribute('data-rule-shift')
    expect(row(40).style.transform).toBe('')

    // DOM order is NOT touched until the drop commits.
    expect([...document.querySelectorAll('[data-rule-row]')].map((el) => el.getAttribute('data-rule-row'))).toEqual(
      ['10', '20', '30', '40']
    )
  })

  it('opens a gap while dragging UP: the rows passed shift down', () => {
    resetStore({ rules: fourRules })
    renderTags()
    stubRowHeights(48)

    const dt = makeDataTransfer()
    fireEvent.dragStart(grip(4), { dataTransfer: dt })
    fireEvent.dragOver(row(20), { dataTransfer: dt })

    expect(row(20).dataset.ruleShift).toBe('down')
    expect(row(20).style.transform).toBe('translateY(52px)')
    expect(row(30).dataset.ruleShift).toBe('down')
    expect(row(30).style.transform).toBe('translateY(52px)')
    expect(row(40).dataset.ruleShift).toBe('up')
    expect(row(40).style.transform).toBe('translateY(-104px)')
    // A row above the drop index is untouched.
    expect(row(10)).not.toHaveAttribute('data-rule-shift')
    expect(row(10).style.transform).toBe('')
  })

  it('measures rows rather than assuming a constant height', () => {
    resetStore({ rules: fourRules })
    renderTags()
    // A taller dragged row (e.g. one open for editing, or a wrapped pattern)
    // must open a correspondingly taller gap.
    stubRowHeights(48)
    Object.defineProperty(row(10), 'offsetHeight', { value: 90, configurable: true })

    const dt = makeDataTransfer()
    fireEvent.dragStart(grip(1), { dataTransfer: dt })
    fireEvent.dragOver(row(20), { dataTransfer: dt })

    // Neighbours close over the DRAGGED row's slot: 90 + 4.
    expect(row(20).style.transform).toBe('translateY(-94px)')
    // …while the placeholder travels over the neighbour's own 48 + 4.
    expect(row(10).style.transform).toBe('translateY(52px)')
  })

  it('clears every transform when the drop lands', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore({ rules: fourRules })
    renderTags()
    stubRowHeights(48)

    const dt = makeDataTransfer()
    fireEvent.dragStart(grip(1), { dataTransfer: dt })
    fireEvent.dragOver(row(30), { dataTransfer: dt })
    expect(document.querySelectorAll('[data-rule-shift]').length).toBeGreaterThan(0)

    fireEvent.drop(row(30), { dataTransfer: dt })

    // A leftover transform would leave the list visually scrambled while the
    // data is fine — the worst possible failure here.
    expect(document.querySelectorAll('[data-rule-shift]')).toHaveLength(0)
    ;[10, 20, 30, 40].forEach((id) => expect(row(id).style.transform).toBe(''))
    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalled())
    ;[10, 20, 30, 40].forEach((id) => expect(row(id).style.transform).toBe(''))
  })

  it('clears every transform on dragend when the row is released outside the list', () => {
    resetStore({ rules: fourRules })
    renderTags()
    stubRowHeights(48)

    const dt = makeDataTransfer()
    fireEvent.dragStart(grip(1), { dataTransfer: dt })
    fireEvent.dragOver(row(30), { dataTransfer: dt })
    expect(row(20).dataset.ruleShift).toBe('up')

    // No drop — the pointer was released over something that accepts nothing.
    fireEvent.dragEnd(grip(1), { dataTransfer: dt })

    expect(document.querySelectorAll('[data-rule-shift]')).toHaveLength(0)
    ;[10, 20, 30, 40].forEach((id) => expect(row(id).style.transform).toBe(''))
    expect(api.patchTagRule).not.toHaveBeenCalled()
  })

  it('opens no gap when hovering the dragged row itself', () => {
    resetStore({ rules: fourRules })
    renderTags()
    stubRowHeights(48)

    const dt = makeDataTransfer()
    fireEvent.dragStart(grip(1), { dataTransfer: dt })
    fireEvent.dragOver(row(10), { dataTransfer: dt })

    expect(document.querySelectorAll('[data-rule-shift]')).toHaveLength(0)
    ;[10, 20, 30, 40].forEach((id) => expect(row(id).style.transform).toBe(''))
  })

  it('flags a pattern that is not a valid regex, and clears once it compiles', () => {
    resetStore()
    renderTags()

    openRow(1)
    const field = screen.getByLabelText('Pattern for rule 1')
    // rule1's stored pattern is the pre-regex glob `/work/**` — flagged now.
    expect(field).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(field, { target: { value: '/work/.*' } })
    expect(field).not.toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(field, { target: { value: '[' } })
    expect(field).toHaveAttribute('aria-invalid', 'true')
  })

  it('flushes a pending pattern PATCH before a drag reorder lands', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore({ rules: [rule1, workRule2] })
    renderTags()

    openRow(1)
    fireEvent.change(screen.getByLabelText('Pattern for rule 1'), { target: { value: '/work/final' } })
    expect(api.patchTagRule).not.toHaveBeenCalled()

    const dt = makeDataTransfer()
    fireEvent.dragStart(grip(1), { dataTransfer: dt })

    // The debounced keystrokes are committed by the drag, not dropped by it
    // and not left to land after the reorder.
    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { pattern: '/work/final' }))
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
    renderTags()

    fireEvent.keyDown(grip(1), { key: 'ArrowDown' })

    await waitFor(() => expect(api.listTagRules).toHaveBeenCalled())
    await waitFor(() => expect(useOrbital.getState().rules).toEqual(serverRules))
    expect(useOrbital.getState().toast).toMatchObject({ kind: 'error' })
  })

  it('resyncs rules from the server when a single-PATCH mutation (enable toggle) fails', async () => {
    vi.mocked(api.patchTagRule).mockRejectedValue(new Error('server down'))
    const serverRules = [rule1, rule2]
    vi.mocked(api.listTagRules).mockResolvedValue(serverRules)
    resetStore()
    renderTags()

    fireEvent.click(screen.getByLabelText('Enable rule 1'))

    await waitFor(() => expect(api.listTagRules).toHaveBeenCalled())
    await waitFor(() => expect(useOrbital.getState().rules).toEqual(serverRules))
  })

  it('has no reorder arrows — the grip is the only reorder control (artboard 1e)', () => {
    resetStore({ rules: [rule1, workRule2] })
    renderTags()

    expect(screen.queryByRole('button', { name: /^Move rule/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Reorder rule/ })).toHaveLength(2)
  })

  it('refuses to move the last rule down, and says so', () => {
    resetStore({ rules: [rule1, workRule2] })
    renderTags()

    fireEvent.keyDown(grip(2), { key: 'ArrowDown' })

    expect(api.patchTagRule).not.toHaveBeenCalled()
    expect(screen.getByTestId('reorder-status')).toHaveTextContent('is already at position 2 of 2')
  })

  it('creates a rule targeting the default tag with a camelCase tagId payload, then refreshes rules', async () => {
    vi.mocked(api.createTagRule).mockResolvedValue(30)
    const refreshedRules = [rule1, rule2, { id: 30, tag_id: 2, position: 2, enabled: 1 as const, condition: 'path_matches' as const, pattern: '' }]
    vi.mocked(api.listTagRules).mockResolvedValue(refreshedRules)
    resetStore()
    renderTags()

    // The selected card is a DEFAULT for the new rule's target tag (not a
    // filter) — select the default tag's card first.
    fireEvent.click(screen.getByText('hue 60'))
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }))

    await waitFor(() =>
      expect(api.createTagRule).toHaveBeenCalledWith({ tagId: 2, condition: 'path_matches', pattern: '' })
    )
    await waitFor(() => expect(useOrbital.getState().rules).toEqual(refreshedRules))
  })

  it('opens a newly added rule straight into edit mode with the pattern field focused', async () => {
    vi.mocked(api.createTagRule).mockResolvedValue(30)
    const newRule: TagRule = { id: 30, tag_id: 1, position: 2, enabled: 1, condition: 'path_matches', pattern: '' }
    vi.mocked(api.listTagRules).mockResolvedValue([rule1, rule2, newRule])
    vi.mocked(api.listSessions).mockResolvedValue([])
    resetStore()
    renderTags()

    // Nothing is in edit mode until a row is opened.
    expect(editingRows()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }))

    // A brand-new rule has nothing to read, so it skips the resting state.
    await waitFor(() => expect(row(30)?.dataset.ruleMode).toBe('editing'))
    expect(editingRows()).toHaveLength(1)
    expect(screen.getByLabelText('Pattern for rule 3')).toHaveFocus()
  })

  it('patches the target tag with a snake_case tag_id payload (edit mode only)', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore()
    renderTags()

    // The target-tag control only exists once the row is open — at rest 1e
    // draws a plain hue-bordered pill.
    expect(screen.queryByRole('combobox', { name: 'Target tag for rule 1' })).not.toBeInTheDocument()
    openRow(1)
    chooseOption('Target tag for rule 1', 'default')

    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { tag_id: 2 }))
    expect(useOrbital.getState().rules.find((r) => r.id === 10)?.tag_id).toBe(2)
  })

  it('patches the condition from the row’s listbox', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore()
    renderTags()

    openRow(1)
    chooseOption('Condition for rule 1', 'title contains')

    await waitFor(() =>
      expect(api.patchTagRule).toHaveBeenCalledWith(10, { condition: 'title_contains' })
    )
    expect(useOrbital.getState().rules.find((r) => r.id === 10)?.condition).toBe('title_contains')
  })

  it('keeps the row open while a listbox is open — Escape peels the popup first', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore()
    const { onClose } = renderTags()

    openRow(1)
    const combo = screen.getByRole('combobox', { name: 'Condition for rule 1' })

    // Picking an option must not pull focus out of the row: the row closes on
    // focusout, and the popup lives in a portal on <body>.
    fireEvent.click(combo)
    fireEvent.click(screen.getByRole('option', { name: 'permission is' }))
    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { condition: 'permission_is' }))
    expect(row(10).dataset.ruleMode).toBe('editing')

    // Escape belongs to the popup while it is open — the row and the panel
    // each keep their own turn.
    fireEvent.click(combo)
    fireEvent.keyDown(combo, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(row(10).dataset.ruleMode).toBe('editing')
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(row(10).dataset.ruleMode).toBe('resting')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('toggles a rule enabled/disabled', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore()
    renderTags()

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
    renderTags()

    fireEvent.click(screen.getByLabelText('Enable rule 1'))

    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { enabled: 0 }))
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledWith({ limit: 200 }))
    await waitFor(() => expect(useOrbital.getState().sessions.sess1.tagIds).toEqual([2]))
  })

  it('debounces the pattern field before patching', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore()
    renderTags()

    openRow(1)
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
    renderTags()

    fireEvent.click(screen.getByRole('button', { name: 'Delete rule 1' }))

    await waitFor(() => expect(api.deleteTagRule).toHaveBeenCalledWith(10))
    expect(useOrbital.getState().rules.map((r) => r.id)).toEqual([20])
  })

  it('previews a sample path against the rules, showing the matched tag and its rule number', async () => {
    vi.mocked(api.previewRule).mockResolvedValue({ tagId: 2, ruleId: 20 })
    resetStore()
    renderTags()

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
    renderTags()

    fireEvent.change(screen.getByLabelText('Sample path'), { target: { value: '/unmatched' } })

    await waitFor(() => expect(api.previewRule).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('no match')).toBeInTheDocument())
  })

  it('closes on Escape', () => {
    resetStore()
    const { onClose } = renderTags()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('closes from the header back chevron', () => {
    resetStore()
    const { onClose } = renderTags()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('shows "saved · just now" in the header only after a mutation lands', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore()
    renderTags()

    expect(screen.queryByTestId('save-status')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Enable rule 1'))

    await waitFor(() => expect(screen.getByTestId('save-status')).toHaveTextContent('saved · just now'))
  })

  it('gives every rule row a real drag grip: draggable, focusable and named', () => {
    resetStore({ rules: [rule1, workRule2] })
    const { container } = renderTags()

    const grips = container.querySelectorAll('[data-rule-grip]')
    expect(grips).toHaveLength(2)
    grips.forEach((handle) => {
      // Still 1e's `⋮⋮` glyph, but no longer decoration: it is the reorder
      // control, so it must be a real button a keyboard can reach.
      expect(handle.tagName).toBe('BUTTON')
      expect(handle).not.toHaveAttribute('aria-hidden')
      expect(handle).toHaveAttribute('draggable', 'true')
      expect(handle.textContent).toBe('⋮⋮')
    })
    // The name carries the rule AND its position, so arrowing is not blind.
    expect(grip(1)).toHaveAccessibleName('Reorder rule 1 of 2: path matches /work/** → work')
  })

  it('tints the selected tag card in its own hue and keeps swatches + delete off the others', () => {
    resetStore()
    renderTags()

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

  it('deselects a tag by clicking the already-selected card again', () => {
    resetStore({ rules: [rule1, rule2] })
    renderTags()

    // `work` is selected by default (canvas 1e opens that way).
    expect(document.querySelector('[data-tag-card="1"]')?.getAttribute('data-selected')).toBe('true')
    expect(row(10).dataset.tagMatch).toBe('true')

    fireEvent.click(screen.getByText('hue 210'))

    // Nothing is selected now: no card tinted, no row marked, and the
    // swatches/delete that hang off the selected card are simply gone.
    expect(document.querySelector('[data-tag-card="1"]')?.getAttribute('data-selected')).toBe('false')
    expect(row(10).dataset.tagMatch).toBe('false')
    expect(row(20).dataset.tagMatch).toBe('false')
    expect(screen.queryByRole('group', { name: /^Hue for / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Delete (work|default)$/ })).not.toBeInTheDocument()
    // …and every rule is still listed.
    expect(document.querySelectorAll('[data-rule-row]')).toHaveLength(2)
  })

  it('selects and deselects a tag from the keyboard via the planet toggle', async () => {
    const user = userEvent.setup()
    resetStore({ rules: [rule1, rule2] })
    renderTags()

    const toggle = screen.getByRole('button', { name: 'Mark rules for work' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    toggle.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Mark rules for work' })).toHaveAttribute('aria-pressed', 'false')
    expect(row(10).dataset.tagMatch).toBe('false')

    // Selection must NOT follow focus, or the card would re-select itself the
    // instant focus settled back into it after a deselect.
    fireEvent.focusIn(screen.getByLabelText('Tag name for work'))
    expect(screen.getByRole('button', { name: 'Mark rules for work' })).toHaveAttribute('aria-pressed', 'false')
    expect(row(10).dataset.tagMatch).toBe('false')

    screen.getByRole('button', { name: 'Mark rules for work' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('button', { name: 'Mark rules for work' })).toHaveAttribute('aria-pressed', 'true')
    expect(row(10).dataset.tagMatch).toBe('true')
  })

  // Regression: the planet is a <span>, so it needs its own `block` to honour
  // its 22px box. It only looked right while it happened to be a flex item —
  // wrapping it in the toggle button collapsed it to a 2px sliver, which no
  // layout-blind assertion would have caught.
  it('keeps the tag planet a sized box rather than an inline sliver', () => {
    resetStore({ rules: [rule1, rule2] })
    renderTags()

    for (const planet of document.querySelectorAll('[data-tag-planet]')) {
      expect(planet.className).toMatch(/(^|\s)(block|inline-block|flex|grid)(\s|$)/)
      expect(planet.className).toMatch(/h-\[22px\]/)
      expect(planet.className).toMatch(/w-\[22px\]/)
    }
  })

  it('does not deselect the card when renaming or recolouring it', async () => {
    vi.mocked(api.patchTag).mockResolvedValue({ ok: true })
    resetStore()
    renderTags()

    fireEvent.click(screen.getByLabelText('Tag name for work'))
    expect(document.querySelector('[data-tag-card="1"]')?.getAttribute('data-selected')).toBe('true')

    fireEvent.click(screen.getByRole('group', { name: 'Hue for work' }).querySelector('[aria-label="Hue 330"]')!)
    await waitFor(() => expect(api.patchTag).toHaveBeenCalledWith(1, { hue: 330 }))
    expect(document.querySelector('[data-tag-card="1"]')?.getAttribute('data-selected')).toBe('true')
  })

  it('falls back to the default tag for "+ Add rule" when no tag is selected', async () => {
    vi.mocked(api.createTagRule).mockResolvedValue(30)
    vi.mocked(api.listTagRules).mockResolvedValue([rule1, rule2])
    vi.mocked(api.listSessions).mockResolvedValue([])
    resetStore()
    renderTags()

    fireEvent.click(screen.getByRole('button', { name: 'Mark rules for work' }))
    expect(screen.getByRole('button', { name: 'Mark rules for work' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: '+ Add rule' }))

    // No selection to inherit, so the rule targets the DEFAULT tag (id 2)
    // rather than being created with no target at all.
    await waitFor(() =>
      expect(api.createTagRule).toHaveBeenCalledWith({ tagId: 2, condition: 'path_matches', pattern: '' })
    )
  })

  it('lists every rule regardless of which tag card is selected', () => {
    resetStore({ rules: [rule1, rule2] })
    renderTags()

    // The server evaluates one global order, so hiding the rules of other
    // tags would misrepresent which rule actually wins.
    expect(document.querySelectorAll('[data-rule-row]')).toHaveLength(2)
    expect(screen.getByText('/work/**')).toBeInTheDocument()
    expect(screen.getByText('bug')).toBeInTheDocument()

    // Selecting the other tag card still shows both rules.
    fireEvent.click(screen.getByRole('button', { name: 'Mark rules for default' }))

    expect(document.querySelectorAll('[data-rule-row]')).toHaveLength(2)
    expect(screen.getByText('/work/**')).toBeInTheDocument()
    expect(screen.getByText('bug')).toBeInTheDocument()
  })

  it('marks the selected tag’s rules without hiding or dimming the rest', () => {
    resetStore({ rules: [rule1, rule2] })
    renderTags()

    // `work` is the head of the tag list and therefore selected by default.
    expect(row(10).dataset.tagMatch).toBe('true')
    expect(row(10)).toHaveAttribute('aria-current', 'true')
    // The mark is not colour-only: the row carries a text marker for AT.
    expect(within(row(10)).getByText('Targets the selected tag')).toBeInTheDocument()
    // The other tag's rule stays listed, unmarked and undimmed.
    expect(row(20).dataset.tagMatch).toBe('false')
    expect(row(20)).not.toHaveAttribute('aria-current')
    expect(row(20).className).not.toContain('opacity-60')
    expect(within(row(20)).queryByText('Targets the selected tag')).not.toBeInTheDocument()

    // Selecting the other card moves the mark; nothing disappears.
    fireEvent.click(screen.getByText('hue 60'))
    expect(row(10).dataset.tagMatch).toBe('false')
    expect(row(20).dataset.tagMatch).toBe('true')
    expect(document.querySelectorAll('[data-rule-row]')).toHaveLength(2)
  })

  it('renders resting rows as readable text with no form controls (canvas 1e)', () => {
    resetStore({ rules: [rule1, rule2] })
    renderTags()

    const resting = row(10)
    expect(resting.dataset.ruleMode).toBe('resting')
    // Condition, pattern and target tag are all readable as text.
    expect(within(resting).getByText('path matches')).toBeInTheDocument()
    expect(within(resting).getByText('/work/**')).toBeInTheDocument()
    expect(within(resting).getByText('work')).toBeInTheDocument()
    // …and none of them is a form control.
    expect(within(resting).queryByRole('combobox')).toBeNull()
    expect(resting.querySelector('input:not([type="checkbox"])')).toBeNull()
    // The row is one openable button, so the whole table is keyboard-reachable.
    expect(within(resting).getByRole('button', { name: /^Edit rule 1: path matches \/work\/\*\* → work$/ })).toBeInTheDocument()
  })

  it('opens exactly one row on click, and opening another closes the first', () => {
    resetStore({ rules: [rule1, workRule2] })
    renderTags()

    // Clicking anywhere in the resting row's readable area opens it.
    fireEvent.click(screen.getByText('/work/**'))
    expect(editingRows()).toHaveLength(1)
    expect(row(10).dataset.ruleMode).toBe('editing')
    expect(screen.getByLabelText('Condition for rule 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Pattern for rule 1')).toHaveFocus()

    openRow(2)
    expect(editingRows()).toHaveLength(1)
    expect(row(20).dataset.ruleMode).toBe('editing')
    expect(row(10).dataset.ruleMode).toBe('resting')
    expect(screen.queryByLabelText('Condition for rule 1')).not.toBeInTheDocument()
  })

  it('commits a pending pattern edit when the row is closed by opening another', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    resetStore({ rules: [rule1, workRule2] })
    renderTags()

    openRow(1)
    fireEvent.change(screen.getByLabelText('Pattern for rule 1'), { target: { value: '/work/final' } })
    expect(api.patchTagRule).not.toHaveBeenCalled()

    // Leaving the row flushes the debounce rather than dropping the keystrokes.
    openRow(2)
    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { pattern: '/work/final' }))
  })

  it('keeps the toggle, the grip and delete live while the row is at rest', async () => {
    vi.mocked(api.patchTagRule).mockResolvedValue({ ok: true })
    vi.mocked(api.deleteTagRule).mockResolvedValue({ ok: true })
    resetStore({ rules: [rule1, workRule2] })
    renderTags()

    fireEvent.click(screen.getByLabelText('Enable rule 1'))
    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { enabled: 0 }))
    // None of these may open the row — deleting must not be gated behind editing.
    expect(editingRows()).toHaveLength(0)

    fireEvent.keyDown(grip(1), { key: 'ArrowDown' })
    await waitFor(() => expect(api.patchTagRule).toHaveBeenCalledWith(10, { position: 1 }))
    expect(editingRows()).toHaveLength(0)

    // rule 10 is now second, so "rule 1" is the rule that took its place.
    fireEvent.click(screen.getByRole('button', { name: 'Delete rule 1' }))
    await waitFor(() => expect(api.deleteTagRule).toHaveBeenCalledWith(20))
    expect(editingRows()).toHaveLength(0)
  })

  it('opens a row from the keyboard and Escape closes the row before the panel', async () => {
    const user = userEvent.setup()
    resetStore({ rules: [rule1] })
    const { onClose } = renderTags()

    const rowButton = screen.getByRole('button', { name: /^Edit rule 1:/ })
    rowButton.focus()
    await user.keyboard('{Enter}')

    expect(row(10).dataset.ruleMode).toBe('editing')
    expect(screen.getByLabelText('Pattern for rule 1')).toHaveFocus()

    // Escape peels the row first…
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(row(10).dataset.ruleMode).toBe('resting')
    expect(onClose).not.toHaveBeenCalled()
    // …focus lands back on the row it came from…
    expect(screen.getByRole('button', { name: /^Edit rule 1:/ })).toHaveFocus()
    // …and only then the panel.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
