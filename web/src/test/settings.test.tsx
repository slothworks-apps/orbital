import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { useOrbital, type OrbitalState, type OrbitalUiState } from '../store/store'
import type { OrbitalModel } from '../lib/types'

// Same shape as `web/src/test/modelcards.test.tsx`'s fixture, so the two
// suites' assumptions about `OrbitalModel` never drift apart.
const MODELS: OrbitalModel[] = [
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', shortVersion: 'Sonnet', variant: null, blurb: 'Efficient for routine tasks', contextWindow: 200_000 },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', family: 'Haiku', version: 'Haiku 4.5', shortVersion: 'Haiku', variant: null, blurb: 'Fastest for quick answers', contextWindow: null },
]

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'

/**
 * The idle preset is a custom listbox, not a `<select>` — its options only
 * exist in a portalled popup while it is open, so every assertion about them
 * has to open it first.
 */
function openIdleSelect(): HTMLElement {
  const trigger = screen.getByRole('combobox', { name: /mark session ended after/i })
  fireEvent.click(trigger)
  return trigger
}

function chooseIdle(label: string | RegExp): void {
  openIdleSelect()
  fireEvent.click(screen.getByRole('option', { name: label }))
}

/** Same portalled-listbox dance for the Clusters release delay. */
function chooseReleaseDelay(label: string | RegExp): void {
  fireEvent.click(
    screen.getByRole('combobox', { name: /release ended sessions into history after/i })
  )
  fireEvent.click(screen.getByRole('option', { name: label }))
}

/**
 * Only one section's rows are mounted at a time, and a fresh store has no
 * remembered section, so every visit here opens on the nav's first row —
 * General. A test for a row anywhere else has to walk the nav first (spec
 * 2026-09-21-settings-sections-design § 1). `hidden: true` because the
 * dialog's scrim is `inert` on the way out and jsdom honours it.
 *
 * Note this is a navigation step, not an assertion: no test here should claim
 * which section a row belongs to. Moving a row between sections is a
 * deliberate act, and a test that fails for it is one that has to be edited
 * every time somebody makes that decision on purpose.
 */
function openSection(
  label: 'General' | 'Sessions' | 'Notifications' | 'Appearance' | 'Tags & rules'
): void {
  fireEvent.click(screen.getByRole('button', { name: label, hidden: true }))
  // A nav click persists the section (`settings_last_section`), so without
  // this every assertion after it would have to account for a PATCH the test
  // is not about. Navigation is setup here, never the thing under test.
  vi.mocked(api.patchSettings).mockClear()
}
import { Settings, initialSection } from '../panels/Settings'

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
    tags: [],
    rules: [],
    models: [],
    settings: {
      default_permission_mode: 'acceptEdits',
      default_project_dir: '',
      lineage_depth: '3',
      confirm_before_clear: 'true',
      inherit_tags: 'true',
      inherit_permission_mode: 'true',
      ended_after_idle_minutes: '30',
    },
    transcripts: {},
    historyLoaded: {},
    toast: null,
    ...overrides,
    ui: { ...defaultUi, ...overrides.ui },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.patchSettings).mockResolvedValue({ ok: true })
})

/** `resetStore` + render, for the model-preference tests below where every
 * case supplies its own `settings`/`models` overrides. */
function renderSettings(
  overrides: Partial<Omit<OrbitalState, 'ui'>> & { ui?: Partial<OrbitalUiState> } = {}
) {
  resetStore(overrides)
  return render(<Settings open onClose={vi.fn()} />)
}

describe('Settings', () => {
  it('renders nothing when closed', () => {
    resetStore()
    const { container } = render(<Settings open={false} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('patches the default permission mode when a mode card is clicked', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    fireEvent.click(screen.getByRole('radio', { name: 'plan' }))

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ default_permission_mode: 'plan' })
    )
    expect(useOrbital.getState().settings.default_permission_mode).toBe('plan')
  })

  it('debounces the default project directory field before patching', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    const field = screen.getByLabelText(/default project directory/i)
    fireEvent.change(field, { target: { value: '/home/tomin/w' } })
    fireEvent.change(field, { target: { value: '/home/tomin/work' } })

    expect(api.patchSettings).not.toHaveBeenCalled()
    await waitFor(
      () => expect(api.patchSettings).toHaveBeenCalledWith({ default_project_dir: '/home/tomin/work' }),
      { timeout: 1000 }
    )
    expect(api.patchSettings).toHaveBeenCalledTimes(1)
    expect(useOrbital.getState().settings.default_project_dir).toBe('/home/tomin/work')
  })

  // Spec 2026-09-16-electron-wrapper-design § 3: empty means autodetect, so an
  // emptied field has to reach the server as '' rather than be skipped.
  it('debounces the Claude Code executable field before patching', async () => {
    resetStore({ settings: { claude_executable_path: '/opt/homebrew/bin/claude' } })
    render(<Settings open onClose={vi.fn()} />)
    openSection('General')

    const field = screen.getByLabelText(/claude code executable/i)
    expect(field).toHaveValue('/opt/homebrew/bin/claude')
    fireEvent.change(field, { target: { value: '/usr/local/bin/cla' } })
    fireEvent.change(field, { target: { value: '' } })

    expect(api.patchSettings).not.toHaveBeenCalled()
    await waitFor(
      () => expect(api.patchSettings).toHaveBeenCalledWith({ claude_executable_path: '' }),
      { timeout: 1000 }
    )
    expect(api.patchSettings).toHaveBeenCalledTimes(1)
    expect(useOrbital.getState().settings.claude_executable_path).toBe('')
  })

  // canvas `Feature - Header gauges` 11c. The setting is per install, so it
  // is stored and read like every other appearance preference.
  it('patches the header stats mode, with the bar pressed by default', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Appearance')

    const group = screen.getByRole('group', { name: 'Session stats in the header' })
    const [bar, button] = within(group).getAllByRole('button')
    expect(bar).toHaveAttribute('aria-pressed', 'true')
    expect(button).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(button)

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ header_session_stats: 'button' })
    )
    expect(useOrbital.getState().settings.header_session_stats).toBe('button')
    expect(within(group).getAllByRole('button')[1]).toHaveAttribute('aria-pressed', 'true')
  })

  it('maps the lineage-depth steps 1-5 to their string values', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Appearance')

    fireEvent.click(screen.getByRole('button', { name: '4', hidden: true }))

    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ lineage_depth: '4' }))
    expect(useOrbital.getState().settings.lineage_depth).toBe('4')
  })

  it('maps the ∞ lineage-depth step to the string "Infinity"', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Appearance')

    fireEvent.click(screen.getByRole('group', { name: /lineage depth/i }).querySelector('button:last-child')!)

    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ lineage_depth: 'Infinity' }))
    expect(useOrbital.getState().settings.lineage_depth).toBe('Infinity')
  })

  it('patches confirm-before-clear when the toggle is clicked', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    fireEvent.click(screen.getByRole('switch', { name: /confirm before clear/i }))

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ confirm_before_clear: 'false' })
    )
    expect(useOrbital.getState().settings.confirm_before_clear).toBe('false')
  })

  it('patches auto-titling when the toggle is clicked, and starts off', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    const toggle = screen.getByRole('switch', { name: /generate session titles from content/i })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ auto_title_sessions: 'true' })
    )
    expect(useOrbital.getState().settings.auto_title_sessions).toBe('true')
  })

  it('patches the inherit-tags and inherit-permission-mode checkboxes independently', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    fireEvent.click(screen.getByRole('checkbox', { name: /^tags$/i }))
    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ inherit_tags: 'false' }))

    fireEvent.click(screen.getByRole('checkbox', { name: /^permission mode$/i }))
    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ inherit_permission_mode: 'false' })
    )
  })

  it('patches the ended-after-idle select', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    chooseIdle('60 min idle')

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ ended_after_idle_minutes: '60' })
    )
    expect(useOrbital.getState().settings.ended_after_idle_minutes).toBe('60')
  })

  // Clusters (spec 2026-09-18-tag-clusters-design § 6): the release delay is
  // the one control over the hole's timed absorption, stored in minutes.
  it('patches the Clusters release delay', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    chooseReleaseDelay('8 hours')

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ map_release_ended_after_minutes: '480' })
    )
    expect(useOrbital.getState().settings.map_release_ended_after_minutes).toBe('480')
  })

  it('offers "Never" for the release delay, which keeps ended sessions bonded', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    chooseReleaseDelay(/never/i)

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ map_release_ended_after_minutes: 'never' })
    )
  })

  it('does not update the store when patchSettings rejects', async () => {
    vi.mocked(api.patchSettings).mockRejectedValue(new Error('settings unreachable'))
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    fireEvent.click(screen.getByRole('radio', { name: 'plan' }))

    await waitFor(() =>
      expect(useOrbital.getState().toast).toMatchObject({ kind: 'error', message: 'settings unreachable' })
    )
    expect(useOrbital.getState().settings.default_permission_mode).toBe('acceptEdits')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    resetStore()
    render(<Settings open onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('lets an open idle listbox own Escape before the panel does', () => {
    const onClose = vi.fn()
    resetStore()
    render(<Settings open onClose={onClose} />)
    openSection('Sessions')

    const trigger = openIdleSelect()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Canvas 1h structure
// ---------------------------------------------------------------------------

function makeSession(id: string, cwd: string) {
  return {
    id,
    cwd,
    title: id,
    firstAt: 0,
    lastAt: 0,
    messageCount: 1,
    source: 'web' as const,
    permissionMode: 'acceptEdits' as const,
    model: null,
    resolvedModel: null,
    parentId: null,
    mapDismissedAt: null,
    tagIds: [],
    status: 'idle' as const,
    subagents: [],
  }
}

describe('Settings — canvas 1h structure', () => {
  it('offers the 2 h idle preset from 1h and patches it as plain minutes', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    chooseIdle('2 h idle')

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ ended_after_idle_minutes: '120' })
    )
  })

  it('offers 1h\'s "Never — only on Clear" preset and patches the sentinel verbatim', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    // The sentinel must reach the server as the literal string: a numeric
    // stand-in would be read back as a minute count, and `Number('never')`
    // is NaN, which `setTimeout` treats as "fire now".
    chooseIdle(/never — only on clear/i)

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ ended_after_idle_minutes: 'never' })
    )
    expect(useOrbital.getState().settings.ended_after_idle_minutes).toBe('never')
  })

  it('keeps "Never" selected when the server already stores the sentinel', () => {
    resetStore({ settings: { ended_after_idle_minutes: 'never' } })
    render(<Settings open onClose={vi.fn()} />)
    openSection('Sessions')

    const trigger = openIdleSelect()
    expect(trigger).toHaveAttribute('data-value', 'never')
    expect(trigger).toHaveTextContent('Never — only on Clear')
    expect(screen.getByRole('option', { name: /never — only on clear/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  it('renders the claude-code version line only once the server reports one', () => {
    resetStore()
    const { rerender } = render(<Settings open onClose={vi.fn()} />)
    expect(screen.queryByText(/claude-code/)).not.toBeInTheDocument()

    act(() =>
      resetStore({
        settings: {
          lineage_depth: '3',
          ended_after_idle_minutes: '30',
          claude_code_version: '1.9.0',
        },
      })
    )
    rerender(<Settings open onClose={vi.fn()} />)
    expect(screen.getByText('claude-code 1.9.0')).toBeInTheDocument()
  })

  // 1h draws the depth's ancestors PLUS the live session at the head of the
  // chain — four orbs at depth 3, which is also the cap it illustrates.
  it("draws one orb per kept ancestor plus the live session (capped at 1h's four)", () => {
    resetStore({ settings: { lineage_depth: '1' } })
    const { rerender } = render(<Settings open onClose={vi.fn()} />)
    // Once is enough: `section` is component state and the effect that resets
    // it is keyed on `open`, so the rerenders below stay on Appearance.
    openSection('Appearance')
    expect(document.querySelectorAll('[data-testid="lineage-chain"] [data-orb]')).toHaveLength(2)

    act(() => resetStore({ settings: { lineage_depth: '3' } }))
    rerender(<Settings open onClose={vi.fn()} />)
    expect(document.querySelectorAll('[data-testid="lineage-chain"] [data-orb]')).toHaveLength(4)

    act(() => resetStore({ settings: { lineage_depth: 'Infinity' } }))
    rerender(<Settings open onClose={vi.fn()} />)
    expect(document.querySelectorAll('[data-testid="lineage-chain"] [data-orb]')).toHaveLength(4)
  })

  it('captions the chain with the real number of sessions the depth pushes into history', () => {
    resetStore({
      settings: { lineage_depth: '2' },
      sessions: {
        a: makeSession('a', '/p1'),
        b: makeSession('b', '/p1'),
        c: makeSession('c', '/p1'),
        d: makeSession('d', '/p1'),
        e: makeSession('e', '/p2'),
      },
    })
    render(<Settings open onClose={vi.fn()} />)
    openSection('Appearance')

    // /p1 has 4 sessions with depth 2 -> 2 drop off; /p2 has 1 -> none.
    expect(screen.getByText('+2 in history')).toBeInTheDocument()
  })

  it('hides the "+N in history" caption when nothing drops off the map', () => {
    resetStore({ settings: { lineage_depth: '5' }, sessions: { a: makeSession('a', '/p1') } })
    render(<Settings open onClose={vi.fn()} />)
    // Without this the assertion would hold for the wrong reason — the whole
    // lineage row is unmounted on any section but Appearance.
    openSection('Appearance')
    expect(screen.getByTestId('lineage-chain')).toBeInTheDocument()
    expect(screen.queryByText(/in history/)).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Model preferences (canvas 4c)
// ---------------------------------------------------------------------------

describe('Settings — model preferences (canvas 4c)', () => {
  it('shows the default model and saves a change', async () => {
    renderSettings({ settings: { default_model: 'sonnet' }, models: MODELS })
    openSection('Sessions')
    expect(screen.getByRole('radio', { name: 'Sonnet' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Haiku' }))
    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ default_model: 'haiku' }))
  })

  it('toggles remembering the model per project', async () => {
    renderSettings({ settings: { remember_model_per_project: 'true' }, models: MODELS })
    openSection('Sessions')
    fireEvent.click(screen.getByLabelText('Remember last model per project'))
    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ remember_model_per_project: 'false' })
    )
  })

  it('toggles the model name under the planet label', async () => {
    renderSettings({ settings: { map_show_model: 'true' }, models: MODELS })
    openSection('Appearance')
    fireEvent.click(screen.getByRole('switch', { name: /Model name under planet label/ }))
    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ map_show_model: 'false' }))
  })

  it('says so when the catalog is empty', () => {
    renderSettings({ settings: {}, models: [] })
    openSection('Sessions')
    expect(screen.getByText(/could not be read/i)).toBeInTheDocument()
  })

  it('names the selected default model, upper-cased, in the sample chip beside the map toggle', () => {
    renderSettings({ settings: { default_model: 'sonnet' }, models: MODELS })
    openSection('Appearance')
    expect(screen.getByTestId('map-model-sample')).toHaveTextContent('SONNET')
  })

  // The two negatives below anchor on the toggle first. Without it they would
  // also pass with the whole row unmounted, which is exactly what happens on
  // any section but Appearance — an assertion that cannot fail is not a test.
  it('hides the sample chip when the catalog is empty', () => {
    renderSettings({ settings: { default_model: 'sonnet' }, models: [] })
    openSection('Appearance')
    expect(screen.getByRole('switch', { name: /Model name under planet label/ })).toBeInTheDocument()
    expect(screen.queryByTestId('map-model-sample')).not.toBeInTheDocument()
  })

  it('hides the sample chip when the default matches no catalog row', () => {
    renderSettings({ settings: { default_model: 'gpt-5' }, models: MODELS })
    openSection('Appearance')
    expect(screen.getByRole('switch', { name: /Model name under planet label/ })).toBeInTheDocument()
    expect(screen.queryByTestId('map-model-sample')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Which section a visit opens on (spec 2026-09-21-settings-sections-design § 1)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// General's read-only rows (spec 2026-09-21-settings-sections-design § 4)
// ---------------------------------------------------------------------------

describe('Settings — General', () => {
  const HEALTH = {
    app: 'orbital',
    billing: 'subscription' as const,
    paths: { claudeDir: '/Users/x/.claude', dataDir: '/data', dbPath: '/data/index.db' },
  }

  it('reports the paths and billing the server actually started with', async () => {
    vi.mocked(api.getHealth).mockResolvedValue(HEALTH)
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    expect(await screen.findByTestId('billing-mode')).toHaveTextContent('Claude subscription')
    expect(screen.getByTestId('claude-dir-effective')).toHaveTextContent('/Users/x/.claude')
    expect(screen.getByText('/data/index.db')).toBeInTheDocument()
  })

  it('names the API key when that is what is paying', async () => {
    vi.mocked(api.getHealth).mockResolvedValue({ ...HEALTH, billing: 'api-key' })
    resetStore()
    render(<Settings open onClose={vi.fn()} />)
    expect(await screen.findByTestId('billing-mode')).toHaveTextContent('API key')
  })

  /**
   * The branch that matters. These rows state where your data lives and who
   * is being charged; a placeholder shown while the fetch is in flight or
   * after it failed could be read as a real path or a real billing mode, so
   * the rows do not draw at all. The editable row above them still must.
   */
  it('draws no path or billing row when the server did not answer', async () => {
    vi.mocked(api.getHealth).mockRejectedValue(new Error('server down'))
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    // The section itself is there and still usable...
    expect(screen.getByLabelText(/claude directory/i)).toBeInTheDocument()
    // ...but nothing claims to know a path or a billing mode.
    await waitFor(() => expect(api.getHealth).toHaveBeenCalled())
    expect(screen.queryByTestId('billing-mode')).not.toBeInTheDocument()
    expect(screen.queryByTestId('claude-dir-effective')).not.toBeInTheDocument()
    expect(screen.queryByText(/index\.db/)).not.toBeInTheDocument()
  })
})

describe('Settings — retention', () => {
  function chooseRetention(label: string | RegExp) {
    fireEvent.click(screen.getByRole('combobox', { name: /delete sessions older than/i }))
    fireEvent.click(screen.getByRole('option', { name: label }))
  }

  /**
   * The row deletes, so nothing is saved until the count has been shown and
   * accepted. Saving first and warning after would be the wrong order for
   * the one destructive control in the dialog.
   */
  it('asks before saving, naming the number it would take', async () => {
    vi.mocked(api.previewRetention).mockResolvedValue({ count: 12 })
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    chooseRetention('30 days')

    const confirm = await screen.findByTestId('retention-confirm')
    expect(confirm).toHaveTextContent('12 sessions')
    expect(api.patchSettings).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'DELETE' }))
    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ delete_sessions_older_than_days: '30' }),
    )
  })

  it('saves nothing when the confirmation is declined', async () => {
    vi.mocked(api.previewRetention).mockResolvedValue({ count: 12 })
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    chooseRetention('30 days')
    fireEvent.click(await screen.findByRole('button', { name: 'CANCEL' }))

    expect(screen.queryByTestId('retention-confirm')).not.toBeInTheDocument()
    expect(api.patchSettings).not.toHaveBeenCalled()
  })

  // Turning it off destroys nothing, and neither does a policy that would
  // take nothing — asking in either case is a dialog for its own sake.
  it('saves straight away when there is nothing to warn about', async () => {
    vi.mocked(api.previewRetention).mockResolvedValue({ count: 0 })
    resetStore({ settings: { delete_sessions_older_than_days: '30' } })
    render(<Settings open onClose={vi.fn()} />)

    chooseRetention(/never/i)
    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ delete_sessions_older_than_days: 'never' }),
    )
    expect(screen.queryByTestId('retention-confirm')).not.toBeInTheDocument()
    expect(api.previewRetention).not.toHaveBeenCalled() // 'never' needs no count

    vi.mocked(api.patchSettings).mockClear()
    chooseRetention('90 days')
    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ delete_sessions_older_than_days: '90' }),
    )
    expect(screen.queryByTestId('retention-confirm')).not.toBeInTheDocument()
  })

  /**
   * Failing open — saving without asking — would be the wrong way round for
   * a destructive setting, and failing closed would make the row unusable
   * whenever the server is busy. So it still asks, and says it cannot count.
   */
  it('still asks, without a number, when the count cannot be fetched', async () => {
    vi.mocked(api.previewRetention).mockRejectedValue(new Error('server down'))
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    chooseRetention('30 days')

    expect(await screen.findByTestId('retention-confirm')).toHaveTextContent(/could not count/i)
    expect(api.patchSettings).not.toHaveBeenCalled()
  })

  it('shows Never for a stored value it does not offer', () => {
    resetStore({ settings: { delete_sessions_older_than_days: '7' } })
    render(<Settings open onClose={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: /delete sessions older than/i })).toHaveTextContent(
      /never/i,
    )
  })
})

describe('Settings — remembered section', () => {
  it('opens on the nav\'s first row when nothing is stored', () => {
    expect(initialSection({})).toBe('general')
  })

  it('resumes the stored section', () => {
    expect(initialSection({ settings_last_section: 'appearance' })).toBe('appearance')
  })

  // The three cases that must not strand the user on a blank or inert page:
  // a key from a future build, junk, and a section that was live when it was
  // stored and has since been disabled.
  it('falls back for an unknown, empty or disabled stored section', () => {
    expect(initialSection({ settings_last_section: 'telemetry' })).toBe('general')
    expect(initialSection({ settings_last_section: '' })).toBe('general')
    expect(initialSection({ settings_last_section: 'shortcuts' })).toBe('general')
  })

  it('remembers a section across a close and reopen, without claiming a save', async () => {
    resetStore()
    const { rerender } = render(<Settings open onClose={vi.fn()} />)
    openSection('Appearance')
    expect(screen.getByLabelText(/default planet size/i)).toBeInTheDocument()
    // Navigation is not a preference change, so the header must stay quiet.
    expect(screen.queryByTestId('save-status')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(useOrbital.getState().settings.settings_last_section).toBe('appearance')
    )

    rerender(<Settings open={false} onClose={vi.fn()} />)
    rerender(<Settings open onClose={vi.fn()} />)
    expect(screen.getByLabelText(/default planet size/i)).toBeInTheDocument()
  })
})

describe('Settings — Appearance (canvas 5a)', () => {
  function openAppearance() {
    openSection('Appearance')
  }

  it('is reachable from the nav and shows the planet-size slider with its readout', () => {
    renderSettings()
    openAppearance()

    expect(screen.getByLabelText(/default planet size/i)).toBeInTheDocument()
    // '1.00×' is both the readout and the middle tick label under the track.
    expect(screen.getAllByText('1.00×').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('default')).toBeInTheDocument()
  })

  it('slider change updates the store immediately (live map) and PATCHes debounced', async () => {
    renderSettings({ settings: { planet_scale: '1' } })
    openAppearance()

    const slider = screen.getByLabelText(/default planet size/i)
    fireEvent.change(slider, { target: { value: '110' } })
    fireEvent.change(slider, { target: { value: '115' } })

    // Immediate: the map behind the dialog rescales live, no Apply.
    expect(useOrbital.getState().settings.planet_scale).toBe('1.15')
    expect(screen.getByText('1.15×')).toBeInTheDocument()
    expect(screen.getByText('larger bodies · fewer per screen')).toBeInTheDocument()
    // Persisted once, debounced — not per drag step.
    expect(api.patchSettings).not.toHaveBeenCalled()
    await waitFor(
      () => expect(api.patchSettings).toHaveBeenCalledWith({ planet_scale: '1.15' }),
      { timeout: 1000 }
    )
    expect(api.patchSettings).toHaveBeenCalledTimes(1)
  })

  it('shows the denser-map note below 1.00×', () => {
    renderSettings({ settings: { planet_scale: '0.85' } })
    openAppearance()
    expect(screen.getByText('0.85×')).toBeInTheDocument()
    expect(screen.getByText('denser map')).toBeInTheDocument()
  })

  it('RESET returns to 1.00×', async () => {
    renderSettings({ settings: { planet_scale: '1.3' } })
    openAppearance()

    fireEvent.click(screen.getByRole('button', { name: 'RESET', hidden: true }))

    expect(useOrbital.getState().settings.planet_scale).toBe('1')
    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ planet_scale: '1' }))
  })

  it('Home resets to 1.00× and Shift+Arrow moves five steps (canvas 5b keyboard spec)', () => {
    renderSettings({ settings: { planet_scale: '0.7' } })
    openAppearance()

    const slider = screen.getByLabelText(/default planet size/i)
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(useOrbital.getState().settings.planet_scale).toBe('1')

    fireEvent.keyDown(slider, { key: 'ArrowRight', shiftKey: true })
    expect(useOrbital.getState().settings.planet_scale).toBe('1.25')

    // Clamped at the top end.
    fireEvent.keyDown(slider, { key: 'ArrowRight', shiftKey: true })
    fireEvent.keyDown(slider, { key: 'ArrowRight', shiftKey: true })
    expect(useOrbital.getState().settings.planet_scale).toBe('1.6')
  })

  it('the labels toggle PATCHes map_scale_labels', async () => {
    renderSettings({ settings: { map_scale_labels: 'false' } })
    openAppearance()

    fireEvent.click(screen.getByRole('switch', { name: /scale labels with bodies/i, hidden: true }))

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ map_scale_labels: 'true' })
    )
    expect(useOrbital.getState().settings.map_scale_labels).toBe('true')
  })

  it('the preview row shows the three tier diameters at the current scale and collapses', () => {
    renderSettings({ settings: { planet_scale: '1.5' } })
    openAppearance()

    // 34/60/92 px tiers × 1.5, rounded to whole pixels (canvas 5b).
    expect(screen.getByText('51px')).toBeInTheDocument()
    expect(screen.getByText('90px')).toBeInTheDocument()
    expect(screen.getByText('138px')).toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: /preview/i, hidden: true })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})
