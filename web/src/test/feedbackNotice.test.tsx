import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { useOrbital, type Toast } from '../store/store'
import { useMapNotices } from '../store/mapNotices'
import { FEEDBACK_NOTICE_ID, FEEDBACK_NOTICE_MS, useFeedbackNotice } from '../ui/FeedbackNotice'
import { MapNoticeHost } from '../ui/MapNoticeHost'

// Spec 2026-10-09-one-place-for-messages-design: the store's toast rides the
// Mac's notice queue, ahead of every notice.

function Replies() {
  useFeedbackNotice()
  return <MapNoticeHost inWindow />
}

const ids = () => useMapNotices.getState().queue.map((e) => e.id)
function pass(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}
function raise(toast: Toast | null) {
  act(() => useOrbital.setState({ toast }))
}

beforeEach(() => {
  vi.useFakeTimers()
  useOrbital.setState({ toast: null })
  useOrbital.setState((s) => ({ ui: { ...s.ui, dialog: null } }))
  useMapNotices.setState({ queue: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the reply in the notice queue', () => {
  it('goes ahead of a waiting notice and leaves the queue when cleared', () => {
    useMapNotices.getState().push({ id: 'app-update', kind: 'update', Body: () => <p>update ready</p> })
    render(<Replies />)

    raise({ kind: 'error', message: 'Could not stop the session' })
    expect(ids()).toEqual([FEEDBACK_NOTICE_ID, 'app-update'])

    raise(null)
    expect(ids()).toEqual(['app-update'])
  })

  it('a newer reply replaces the one showing, in the same entry', () => {
    render(<Replies />)
    raise({ kind: 'info', message: 'Record copied as Markdown' })
    raise({ kind: 'info', message: 'Paired with Pixel' })

    expect(ids()).toEqual([FEEDBACK_NOTICE_ID])
    expect(screen.getByText('Paired with Pixel')).toBeInTheDocument()
    expect(screen.queryByText('Record copied as Markdown')).not.toBeInTheDocument()
  })
})

describe('what goes by itself', () => {
  it('an info reply goes after its time; a failure stays', () => {
    render(<Replies />)
    raise({ kind: 'info', message: 'Paired with Pixel' })
    pass(FEEDBACK_NOTICE_MS)
    expect(useOrbital.getState().toast).toBeNull()

    raise({ kind: 'error', message: 'Could not stop the session' })
    pass(FEEDBACK_NOTICE_MS * 3)
    expect(useOrbital.getState().toast?.message).toBe('Could not stop the session')
  })

  it('waits while the pointer is over it, and counts again once it leaves', () => {
    render(<Replies />)
    raise({ kind: 'info', message: 'Paired with Pixel' })
    const card = screen.getByRole('status')

    fireEvent.pointerEnter(card)
    pass(FEEDBACK_NOTICE_MS * 2)
    expect(useOrbital.getState().toast).not.toBeNull()

    fireEvent.pointerLeave(card)
    pass(FEEDBACK_NOTICE_MS - 1)
    expect(useOrbital.getState().toast).not.toBeNull()
    pass(1)
    expect(useOrbital.getState().toast).toBeNull()
  })

  it('a newer reply is not taken down by the older one\'s clock', () => {
    render(<Replies />)
    raise({ kind: 'info', message: 'Record copied as Markdown' })
    pass(FEEDBACK_NOTICE_MS - 1)
    raise({ kind: 'error', message: 'Could not stop the session' })
    pass(1)
    expect(useOrbital.getState().toast?.message).toBe('Could not stop the session')
  })
})

describe('the reply\'s action', () => {
  it('Undo runs and ends the reply', () => {
    const run = vi.fn()
    render(<Replies />)
    raise({ kind: 'info', message: 'auth refactor ended', action: { label: 'Undo', run } })

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(run).toHaveBeenCalledOnce()
    expect(useOrbital.getState().toast).toBeNull()
  })

  it('Details opens the log and leaves a refused rewind up', () => {
    const run = vi.fn()
    render(<Replies />)
    raise({ kind: 'rewind_refused', message: 'The CLI refused the rewind', action: { label: 'Details', run } })

    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(run).toHaveBeenCalledOnce()
    expect(useOrbital.getState().toast?.kind).toBe('rewind_refused')
  })
})
