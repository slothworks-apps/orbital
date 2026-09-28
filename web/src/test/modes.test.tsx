import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ModeCards } from '../ui/ModeCards'
import { ModeDot, ModeReadout } from '../ui/ModeDot'
import { escapeLayerDepth } from '../ui/escapeLayer'
import { PERMISSION_MODES } from '../lib/permissionModes'
import type { PermissionMode } from '../lib/types'

/** The picker is uncontrolled in these tests so a click can be observed landing. */
function Picker({ initial = 'acceptEdits', compact = false }: { initial?: PermissionMode; compact?: boolean }) {
  const [value, setValue] = useState<PermissionMode>(initial)
  return <ModeCards value={value} onChange={setValue} compact={compact} />
}

describe('PERMISSION_MODES', () => {
  it('lists the four modes Orbital offers, ordered by escalating autonomy', () => {
    expect(PERMISSION_MODES.map((m) => m.value)).toEqual([
      'plan',
      'acceptEdits',
      'auto',
      'bypassPermissions',
    ])
  })

})

describe('ModeCards', () => {
  it('selects auto — the mode that had no way to be picked before', async () => {
    render(<Picker />)

    await userEvent.click(screen.getByRole('radio', { name: 'auto' }))

    expect(screen.getByRole('radio', { name: 'auto' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'acceptEdits' })).toHaveAttribute('aria-checked', 'false')
  })

  it('uses the short label and short copy in the compact (settings) variant', () => {
    render(<Picker compact />)

    expect(screen.getByRole('radio', { name: 'bypass' })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'bypassPermissions' })).toBeNull()
    expect(screen.getByText('Never asks')).toBeInTheDocument()
    // The full description belongs to the picker, not to a 320px column.
    expect(screen.queryByText('Never asks. Sandboxed repos only.')).toBeNull()
  })

  it('disables every card when the group is disabled', () => {
    render(<ModeCards value="plan" onChange={vi.fn()} disabled />)
    for (const card of screen.getAllByRole('radio')) expect(card).toBeDisabled()
  })
})

describe('ModeDot', () => {
  it('is hidden from assistive tech — the dot is never the only channel', () => {
    const { container } = render(<ModeDot mode="plan" />)
    expect(container.firstElementChild).toHaveAttribute('aria-hidden')
  })
})

describe('ModeReadout', () => {
  it('names the mode for a screen reader even though it draws only a dot', () => {
    render(<ModeReadout mode="acceptEdits" />)
    expect(screen.getByRole('img', { name: 'permission mode: acceptEdits' })).toBeInTheDocument()
    expect(screen.queryByText('acceptEdits')).toBeNull()
  })

  it('reveals the mode name and description on hover', async () => {
    render(<ModeReadout mode="bypassPermissions" />)
    expect(screen.queryByRole('tooltip')).toBeNull()

    await userEvent.hover(screen.getByRole('img', { name: /bypassPermissions/ }))

    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('bypassPermissions')
    expect(tip).toHaveTextContent('Never asks. Sandboxed repos only.')
  })
})

describe('Tooltip', () => {
  /**
   * A hover tooltip that registered an escape layer would swallow the Escape
   * meant for the dialog under the pointer — `useEscapeLayer` makes its holder
   * the single recipient of the keystroke.
   */
  it('does not claim Escape while it is only hovered', async () => {
    render(<ModeReadout mode="plan" />)
    const before = escapeLayerDepth()

    await userEvent.hover(screen.getByRole('img', { name: /plan/ }))

    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    expect(escapeLayerDepth()).toBe(before)
  })
})
