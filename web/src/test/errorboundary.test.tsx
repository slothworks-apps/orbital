import { describe, expect, it, vi, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ErrorBoundary, resetErrorBoundaries } from '../ui/ErrorBoundary'

/**
 * React prints the caught error and a component stack to console.error on
 * every boundary catch. That is React working, not the test misbehaving, so
 * it is silenced per-test to keep the run's output pristine.
 */
function silenceReactErrorLog() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

function Boom(): never {
  throw new Error('sourceOptions is not defined')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary label="Detail panel">
        <p>transcript</p>
      </ErrorBoundary>,
    )

    expect(screen.getByText('transcript')).toBeInTheDocument()
  })

  it('renders a named fallback instead of nothing when a child throws', () => {
    silenceReactErrorLog()

    render(
      <ErrorBoundary label="Detail panel">
        <Boom />
      </ErrorBoundary>,
    )

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Detail panel')
    expect(alert).toHaveTextContent('sourceOptions is not defined')
  })

  it('renders its children again once resetErrorBoundaries runs and they stop throwing', () => {
    silenceReactErrorLog()
    // Stands in for the module a hot update replaced: broken when the
    // boundary caught, valid by the time the next update lands.
    let broken = true
    function Sidebar() {
      if (broken) throw new Error('sourceOptions is not defined')
      return <p>sidebar</p>
    }

    render(
      <ErrorBoundary label="Sidebar">
        <Sidebar />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    broken = false
    act(() => resetErrorBoundaries())

    expect(screen.getByText('sidebar')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
