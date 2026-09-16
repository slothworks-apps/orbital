import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { usePresence } from '../ui/usePresence'
import { MODAL_ENTER_MS, MODAL_EXIT_MS } from '../ui/motion'

function Surface({ open }: { open: boolean }) {
  const { mounted, state } = usePresence(open, MODAL_ENTER_MS, MODAL_EXIT_MS)
  if (!mounted) return null
  return <div data-testid="surface" data-state={state} />
}

function surface() {
  return screen.queryByTestId('surface')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * The point of the hook: a component that renders `null` the moment `open`
 * goes false can only ever animate IN, because React has already removed the
 * node before the exit transition could run.
 */
describe('usePresence', () => {
  it('holds the node mounted for the exit duration, then drops it', () => {
    const { rerender } = render(<Surface open />)
    expect(surface()).toBeInTheDocument()

    rerender(<Surface open={false} />)
    // Still there, and marked so the caller can swap in its closed styles.
    expect(surface()).toHaveAttribute('data-state', 'exiting')

    act(() => {
      vi.advanceTimersByTime(MODAL_EXIT_MS - 1)
    })
    expect(surface()).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(surface()).not.toBeInTheDocument()
  })

  it('mounts closed first, so the browser has a state to transition FROM', () => {
    // Opening straight into the open styles gives the browser nothing to
    // interpolate from and the entrance is simply skipped.
    render(<Surface open={false} />)
    expect(surface()).not.toBeInTheDocument()
  })

  it('cancels a pending unmount when reopened mid-close', () => {
    const { rerender } = render(<Surface open />)
    rerender(<Surface open={false} />)
    act(() => {
      vi.advanceTimersByTime(MODAL_EXIT_MS - 20)
    })

    rerender(<Surface open />)
    // Past when the old timer would have fired: reopening must have cancelled
    // it, or the surface would vanish moments after coming back.
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(surface()).toBeInTheDocument()
  })

  it('never animates out something that was never shown', () => {
    const { rerender } = render(<Surface open={false} />)
    rerender(<Surface open={false} />)
    expect(surface()).not.toBeInTheDocument()
  })
})

describe('usePresence with reduced motion', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // The surface must still appear and disappear — just without a hold the
  // user would experience as lag, since they can't see the animation anyway.
  it('unmounts immediately instead of waiting out the exit', () => {
    const { rerender } = render(<Surface open />)
    expect(surface()).toHaveAttribute('data-state', 'entered')

    rerender(<Surface open={false} />)
    expect(surface()).not.toBeInTheDocument()
  })
})
