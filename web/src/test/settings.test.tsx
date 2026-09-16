import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useOrbital, type OrbitalState, type OrbitalUiState } from '../store/store'
import pkg from '../../package.json'

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

/** Same portalled-listbox dance for the map's ended-age cutoff. */
function chooseEndedAge(label: string | RegExp): void {
  fireEvent.click(screen.getByRole('combobox', { name: /stop drawing ended sessions after/i }))
  fireEvent.click(screen.getByRole('option', { name: label }))
}
import { Settings } from '../panels/Settings'

const defaultUi: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  hideEnded: false,
  wsStatus: 'connected',
  dialog: 'settings',
  sidebarCollapsed: false,
}

function resetStore(
  overrides: Partial<Omit<OrbitalState, 'ui'>> & { ui?: Partial<OrbitalUiState> } = {}
) {
  useOrbital.setState({
    sessions: {},
    order: [],
    tags: [],
    rules: [],
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
  vi.mocked(api.patchSettings).mockResolvedValue({ ok: true })
})

describe('Settings', () => {
  it('renders nothing when closed', () => {
    resetStore()
    const { container } = render(<Settings open={false} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('patches the default permission mode when a mode card is clicked', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('radio', { name: 'plan' }))

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ default_permission_mode: 'plan' })
    )
    expect(useOrbital.getState().settings.default_permission_mode).toBe('plan')
  })

  it('debounces the default project directory field before patching', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

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

  it('maps the lineage-depth steps 1-5 to their string values', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '4', hidden: true }))

    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ lineage_depth: '4' }))
    expect(useOrbital.getState().settings.lineage_depth).toBe('4')
  })

  it('maps the ∞ lineage-depth step to the string "Infinity"', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('group', { name: /lineage depth/i }).querySelector('button:last-child')!)

    await waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ lineage_depth: 'Infinity' }))
    expect(useOrbital.getState().settings.lineage_depth).toBe('Infinity')
  })

  it('patches confirm-before-clear when the toggle is clicked', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('checkbox', { name: /confirm before clear/i }))

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ confirm_before_clear: 'false' })
    )
    expect(useOrbital.getState().settings.confirm_before_clear).toBe('false')
  })

  it('patches the inherit-tags and inherit-permission-mode checkboxes independently', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

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

    chooseIdle('60 min idle')

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ ended_after_idle_minutes: '60' })
    )
    expect(useOrbital.getState().settings.ended_after_idle_minutes).toBe('60')
  })

  it('patches the map ended-age cutoff', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    chooseEndedAge('7 days')

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ map_ended_max_age_days: '7' })
    )
    expect(useOrbital.getState().settings.map_ended_max_age_days).toBe('7')
  })

  it('offers "Never" for the ended-age cutoff, which turns the age filter off', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    chooseEndedAge(/never/i)

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ map_ended_max_age_days: 'never' })
    )
  })

  it('does not update the store when patchSettings rejects', async () => {
    vi.mocked(api.patchSettings).mockRejectedValue(new Error('settings unreachable'))
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('radio', { name: 'plan' }))

    await waitFor(() =>
      expect(useOrbital.getState().toast).toMatchObject({ kind: 'error', message: 'settings unreachable' })
    )
    expect(useOrbital.getState().settings.default_permission_mode).toBe('acceptEdits')
  })

  it('lists General/Permissions/Appearance/Shortcuts as disabled nav items', () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    for (const label of ['General', 'Permissions', 'Appearance', 'Shortcuts']) {
      const button = screen.getByRole('button', { name: new RegExp(`^${label}`) })
      expect(button).toBeDisabled()
    }
    expect(screen.getByRole('button', { name: /^Sessions$/ })).not.toBeDisabled()
  })

  it('shows the orbital version in the nav footer', () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    expect(screen.getByText(`orbital ${pkg.version}`)).toBeInTheDocument()
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
    parentId: null,
    tagIds: [],
    status: 'idle' as const,
  }
}

describe('Settings — canvas 1h structure', () => {
  it('orders the nav with "Tags & rules" between Permissions and Appearance', () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    const labels = Array.from(
      screen.getByRole('navigation', { name: /settings sections/i }).querySelectorAll('button')
    ).map((b) => b.textContent?.replace(/›$/, '').trim())

    expect(labels).toEqual([
      'General',
      'Sessions',
      'Permissions',
      'Tags & rules',
      'Appearance',
      'Shortcuts',
    ])
  })

  it('offers the 2 h idle preset from 1h and patches it as plain minutes', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    chooseIdle('2 h idle')

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ ended_after_idle_minutes: '120' })
    )
  })

  it('offers 1h\'s "Never — only on Clear" preset and patches the sentinel verbatim', async () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    // The sentinel must reach the server as the literal string: a numeric
    // stand-in would be read back as a minute count, and `Number('never')`
    // is NaN, which `setTimeout` treats as "fire now".
    chooseIdle(/never — only on clear/i)

    await waitFor(() =>
      expect(api.patchSettings).toHaveBeenCalledWith({ ended_after_idle_minutes: 'never' })
    )
    expect(useOrbital.getState().settings.ended_after_idle_minutes).toBe('never')
  })

  it('lists every 1h idle preset in order', () => {
    resetStore()
    render(<Settings open onClose={vi.fn()} />)

    openIdleSelect()
    const options = screen.getAllByRole('option').map((o) => o.getAttribute('data-label'))
    expect(options).toEqual([
      '15 min idle',
      '30 min idle',
      '60 min idle',
      '2 h idle',
      'Never — only on Clear',
    ])
  })

  it('keeps "Never" selected when the server already stores the sentinel', () => {
    resetStore({ settings: { ended_after_idle_minutes: 'never' } })
    render(<Settings open onClose={vi.fn()} />)

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

    // /p1 has 4 sessions with depth 2 -> 2 drop off; /p2 has 1 -> none.
    expect(screen.getByText('+2 in history')).toBeInTheDocument()
  })

  it('hides the "+N in history" caption when nothing drops off the map', () => {
    resetStore({ settings: { lineage_depth: '5' }, sessions: { a: makeSession('a', '/p1') } })
    render(<Settings open onClose={vi.fn()} />)
    expect(screen.queryByText(/in history/)).not.toBeInTheDocument()
  })
})
