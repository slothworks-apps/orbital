import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SandboxPage } from '../sandbox/SandboxPage'

// R3F's <Canvas> (via react-use-measure) needs ResizeObserver, which jsdom
// lacks — same file-scoped polyfill app.test.tsx uses. The canvas never
// measures a size in jsdom, so no WebGL context is ever created; these tests
// cover the control panel, not the scene.
beforeAll(() => {
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = NoopObserver
})

describe('SandboxPage', () => {
  it('starts on a working planet with nothing toggled', () => {
    render(<SandboxPage />)
    expect(screen.getByRole('combobox', { name: 'STATE' })).toHaveTextContent('working')
    expect(screen.getByRole('combobox', { name: 'TAG HUE' })).toHaveTextContent('hue 210')
    expect(screen.getByLabelText('selected (reticle)')).not.toBeChecked()
    expect(screen.getByLabelText('hidden (ended suppression)')).not.toBeChecked()
    // On by default so the sandbox transition includes the tier-size change
    // the map performs (`scaleFor` in map/layout.ts).
    expect(screen.getByLabelText('scale follows state (layout tiers)')).toBeChecked()
  })

  it('offers every planet state and commits a change', () => {
    render(<SandboxPage />)
    const trigger = screen.getByRole('combobox', { name: 'STATE' })
    fireEvent.click(trigger)
    // The four SessionStatus values, `needs_input` spelled readably.
    for (const label of ['working', 'idle', 'needs input', 'ended']) {
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('option', { name: 'needs input' }))
    expect(trigger).toHaveTextContent('needs input')
  })

  it('toggles the selection reticle and the ended suppression', () => {
    render(<SandboxPage />)
    const selected = screen.getByLabelText('selected (reticle)')
    fireEvent.click(selected)
    expect(selected).toBeChecked()
    const hidden = screen.getByLabelText('hidden (ended suppression)')
    fireEvent.click(hidden)
    expect(hidden).toBeChecked()
  })
})
