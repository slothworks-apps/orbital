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

  it('offers moons so orbit clearance is testable without a live session', () => {
    render(<SandboxPage />)
    const trigger = screen.getByRole('combobox', { name: 'MOONS' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: '2' }))
    expect(trigger).toHaveTextContent('2')
  })
})
