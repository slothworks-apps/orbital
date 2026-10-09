import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { SheetPresence } from '../mobile/ui'

/** Long enough for any sheet's way out. */
const PAST_EXIT_MS = 1000

function Host({ title }: { title: string | null }) {
  return <SheetPresence>{title !== null && <div data-testid="sheet">{title}</div>}</SheetPresence>
}

function sheet() {
  return screen.queryByTestId('sheet')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SheetPresence', () => {
  it('keeps the closed sheet, with what it last showed, until it has left', () => {
    const { rerender } = render(<Host title="Context" />)
    expect(sheet()?.closest('[data-sheet-leaving]')).toBeNull()

    // The caller's condition is false now, so its props are gone too.
    rerender(<Host title={null} />)
    expect(sheet()).toHaveTextContent('Context')
    expect(sheet()?.closest('[data-sheet-leaving]')).not.toBeNull()

    act(() => {
      vi.advanceTimersByTime(PAST_EXIT_MS)
    })
    expect(sheet()).toBeNull()
  })

  it('reopened while leaving, shows the new sheet and does not drop it', () => {
    const { rerender } = render(<Host title="Context" />)
    rerender(<Host title={null} />)
    rerender(<Host title="Worktrees" />)

    act(() => {
      vi.advanceTimersByTime(PAST_EXIT_MS)
    })
    expect(sheet()).toHaveTextContent('Worktrees')
    expect(sheet()?.closest('[data-sheet-leaving]')).toBeNull()
  })

  it('renders nothing when it was never open', () => {
    render(<Host title={null} />)
    expect(sheet()).toBeNull()
  })
})
