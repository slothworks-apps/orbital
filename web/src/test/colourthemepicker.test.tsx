import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { useOrbital } from '../store/store'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { Settings } from '../panels/Settings'
import { COLOUR_THEMES } from '../lib/colourTheme'

function renderAppearance(settings: Record<string, string>) {
  useOrbital.setState({
    sessions: {},
    order: [],
    tags: [],
    rules: [],
    models: [],
    settings,
    ui: {
      selectedId: null,
      filterTagIds: [],
      search: '',
      sourceFilter: 'all',
      wsStatus: 'connected',
      dialog: 'settings',
      sidebarCollapsed: false,
      fileViewer: null,
    },
  })
  render(<Settings open onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Appearance', hidden: true }))
  vi.mocked(api.patchSettings).mockClear()
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.patchSettings).mockResolvedValue({ ok: true })
})

describe('Settings → Appearance → COLOURS (1f)', () => {
  it('is not offered until Labs → Colour themes is on', () => {
    renderAppearance({ colour_theme: 'albedo' })
    expect(screen.queryByRole('combobox', { name: 'Colours', hidden: true })).toBeNull()
  })

  it('lists the themes under their kind and saves the one picked across the group boundary', () => {
    renderAppearance({ colour_themes_enabled: 'true' })
    const trigger = screen.getByRole('combobox', { name: 'Colours', hidden: true })
    expect(trigger.getAttribute('data-value')).toBe('deep-field')

    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const dark = screen.getByRole('group', { name: 'DARK', hidden: true })
    const light = screen.getByRole('group', { name: 'LIGHT', hidden: true })
    const darkCount = COLOUR_THEMES.filter((t) => t.kind === 'dark').length
    expect(within(dark).getAllByRole('option', { hidden: true })).toHaveLength(darkCount)
    expect(within(light).getAllByRole('option', { hidden: true })[0].getAttribute('data-label')).toBe('Albedo')

    // From Deep Field (first), down past every dark theme lands on the first light one.
    for (let i = 0; i < darkCount; i++) fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(api.patchSettings).toHaveBeenCalledWith({ colour_theme: 'albedo' })
  })

  it('splits into a light and a dark row while following the system, each listing its kind only', () => {
    renderAppearance({ colour_themes_enabled: 'true', colour_theme: 'velvet', colour_theme_follow_system: 'true' })
    expect(screen.queryByRole('combobox', { name: 'Colours', hidden: true })).toBeNull()
    const light = screen.getByRole('combobox', { name: 'In light mode', hidden: true })
    const dark = screen.getByRole('combobox', { name: 'In dark mode', hidden: true })
    expect(light.getAttribute('data-value')).toBe('albedo')
    expect(dark.getAttribute('data-value')).toBe('velvet')

    fireEvent.keyDown(light, { key: 'ArrowDown' })
    const options = screen.getAllByRole('option', { hidden: true })
    expect(options).toHaveLength(COLOUR_THEMES.filter((t) => t.kind === 'light').length)
    fireEvent.keyDown(light, { key: 'ArrowDown' })
    fireEvent.keyDown(light, { key: 'Enter' })
    expect(api.patchSettings).toHaveBeenCalledWith({ colour_theme_light: 'solar-light' })
  })
})
