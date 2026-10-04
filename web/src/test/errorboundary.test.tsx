import { describe, expect, it, vi, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
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
  // Reset rolls this test’s api overrides back to apiMock’s defaults;
  // restore takes the console spies off.
  vi.resetAllMocks()
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

  it('records the crash in the shared error log, with both stacks and the label', async () => {
    silenceReactErrorLog()

    render(
      <ErrorBoundary label="Detail panel">
        <Boom />
      </ErrorBoundary>,
    )

    await waitFor(() => expect(api.reportErrorToServer).toHaveBeenCalledTimes(1))
    const body = vi.mocked(api.reportErrorToServer).mock.calls[0][0]
    expect(body.kind).toBe('render_crash')
    expect(body.message).toBe('sourceOptions is not defined')
    expect(body.context).toEqual({ label: 'Detail panel' })
    // The component stack is the half React knows and the JS stack does not.
    expect(body.detail).toContain('Boom')
  })

  it('does not report its own failed report — a crash reporter that loops is worse than none', async () => {
    const consoleError = silenceReactErrorLog()
    vi.mocked(api.reportErrorToServer).mockRejectedValue(new Error('offline'))

    render(
      <ErrorBoundary label="Sidebar">
        <Boom />
      </ErrorBoundary>,
    )

    await waitFor(() => expect(api.reportErrorToServer).toHaveBeenCalledTimes(1))
    // A retry would show up here as a second call; it never comes.
    expect(api.reportErrorToServer).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        'orbital: failed to record a render crash',
        expect.any(Error),
      ),
    )
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
