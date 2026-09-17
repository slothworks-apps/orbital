import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ModeCards } from '../ui/ModeCards'
import { ModeDot, ModeReadout } from '../ui/ModeDot'
import { Tooltip } from '../ui/Tooltip'
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

  /**
   * The mode family is deliberately deeper and more chromatic than the tag
   * family's fixed `oklch(80% .13 H)` so the two never read as one signal —
   * see `docs/decisions/mode-dots-are-their-own-hue-family.md`. A dot that
   * drifted to the tag lightness/chroma would undo that silently.
   */
  it('keeps every dot out of the tag family and gives each mode its own hue', () => {
    const parsed = PERMISSION_MODES.map((mode) => {
      const [, l, c, h] = mode.dot.match(/oklch\((\d+)% ([\d.]+) (\d+)\)/) ?? []
      expect(l, `${mode.value} dot is not a plain oklch() triple`).toBeDefined()
      return { lightness: Number(l) / 100, chroma: Number(c), hue: Number(h) }
    })

    for (const { lightness, chroma } of parsed) {
      expect(lightness).toBeGreaterThanOrEqual(0.66)
      expect(lightness).toBeLessThanOrEqual(0.76)
      expect(chroma).toBeGreaterThanOrEqual(0.16)
      // Not the tag family, on both axes at once.
      expect(lightness === 0.8 && chroma === 0.13).toBe(false)
    }

    expect(new Set(parsed.map((p) => p.hue)).size).toBe(PERMISSION_MODES.length)
  })
})

describe('ModeCards', () => {
  it('renders one card per mode in a two-column grid, each with its dot', () => {
    const { container } = render(<Picker />)

    const cards = screen.getAllByRole('radio')
    expect(cards).toHaveLength(4)
    expect(cards.map((c) => c.getAttribute('data-mode'))).toEqual([
      'plan',
      'acceptEdits',
      'auto',
      'bypassPermissions',
    ])
    expect(container.firstElementChild).toHaveClass('grid-cols-2')

    for (const mode of PERMISSION_MODES) {
      const card = screen.getByRole('radio', { name: mode.label })
      expect(card.querySelector(`[data-mode="${mode.value}"][aria-hidden]`)).not.toBeNull()
    }
  })

  it('selects auto — the mode that had no way to be picked before', async () => {
    render(<Picker />)

    await userEvent.click(screen.getByRole('radio', { name: 'auto' }))

    expect(screen.getByRole('radio', { name: 'auto' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'acceptEdits' })).toHaveAttribute('aria-checked', 'false')
  })

  /** Selection must survive greyscale: border + fill + pip, never the mode dot. */
  it('marks the selected card with an accent pip beyond its colour', () => {
    render(<Picker initial="plan" />)

    const selected = screen.getByRole('radio', { name: 'plan' })
    expect(selected).toHaveClass('border-accent/70')
    expect(selected.querySelector('.bg-accent')).not.toBeNull()
    expect(screen.getByRole('radio', { name: 'auto' }).querySelector('.bg-accent')).toBeNull()
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

  /** The native `title` never does this, which is why `Tooltip` exists. */
  it('reveals the same tooltip on keyboard focus and describes the trigger', () => {
    render(<ModeReadout mode="auto" />)
    const readout = screen.getByRole('img', { name: /auto/ })

    act(() => readout.focus())

    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Runs unattended; a classifier vets each command.')
    expect(readout).toHaveAttribute('aria-describedby', tip.id)
  })
})

describe('Tooltip', () => {
  it('closes on Escape when it was opened by focus', () => {
    render(<ModeReadout mode="plan" />)
    const readout = screen.getByRole('img', { name: /plan/ })
    act(() => readout.focus())
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(screen.queryByRole('tooltip')).toBeNull()
  })

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

  it('hangs from the right edge when asked, so it cannot run off the panel', () => {
    render(
      <Tooltip title="t" description="d" align="right">
        <button type="button">trigger</button>
      </Tooltip>
    )
    act(() => screen.getByRole('button').focus())
    expect(screen.getByRole('tooltip')).toHaveClass('right-0')
  })
})
