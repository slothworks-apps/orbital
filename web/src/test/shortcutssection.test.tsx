import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { bindingCount } from '../lib/keymap'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { ShortcutsSection } from '../panels/ShortcutsSection'

/** The group headers, read back in document order. */
function groupTitles(): string[] {
  return screen.getAllByTestId('shortcut-group-title').map((el) => el.textContent ?? '')
}

describe('Settings → Shortcuts', () => {
  it('filters down to the one matching group and row', () => {
    render(<ShortcutsSection />)
    fireEvent.change(screen.getByLabelText('Filter shortcuts'), { target: { value: 'fit' } })
    expect(groupTitles()).toEqual(['MAP'])
    expect(screen.getAllByTestId('shortcut-row')).toHaveLength(1)
    expect(screen.getByText(`1/${bindingCount()}`)).toBeInTheDocument()
  })

  it('shows the empty state when nothing matches', () => {
    render(<ShortcutsSection />)
    fireEvent.change(screen.getByLabelText('Filter shortcuts'), { target: { value: 'zzzz' } })
    expect(screen.queryAllByTestId('shortcut-group-title')).toHaveLength(0)
    expect(screen.getByText('NO MATCH')).toBeInTheDocument()
  })
})
