import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ErrorRecord } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api, ApiError } from '../lib/api'
import { useOrbital } from '../store/store'
import { reportError } from '../lib/errors'
import { ErrorLog } from '../panels/ErrorLog'
import { Toasts } from '../ui/Toasts'

// ---------------------------------------------------------------------------
// The error surface as the user meets it: the log dialog, the toast's way
// through to it, and `reportError`'s two halves.
// `docs/superpowers/specs/2026-09-17-error-surface-design.md`
// ---------------------------------------------------------------------------

function makeError(overrides: Partial<ErrorRecord> & { id: number }): ErrorRecord {
  return {
    at: 1_700_000_000_000,
    source: 'web',
    kind: 'api_request',
    sessionId: null,
    message: 'Failed to rename session',
    detail: null,
    context: null,
    seenAt: null,
    ...overrides,
  }
}

function resetStore(errors: ErrorRecord[] = [], errorsUnseen = 0) {
  useOrbital.setState({ errors, errorsUnseen, toast: null })
  useOrbital.setState((s) => ({ ui: { ...s.ui, dialog: null } }))
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStore()
  vi.mocked(api.markErrorsSeen).mockResolvedValue({ ok: true, unseen: 0 })
  vi.mocked(api.reportErrorToServer).mockResolvedValue({
    error: makeError({ id: 1 }),
    unseen: 1,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ErrorLog', () => {
  it('lists the records newest first, as the store holds them', () => {
    // Already stamped: this test is about order, not about the marking the
    // effect below does on open.
    resetStore([
      makeError({ id: 2, message: 'newer', seenAt: 1 }),
      makeError({ id: 1, message: 'older', seenAt: 1 }),
    ])

    render(<ErrorLog open onClose={() => {}} />)

    const rows = within(screen.getByRole('list', { name: /recorded errors/i })).getAllByRole(
      'listitem',
    )
    expect(rows[0]).toHaveTextContent('newer')
    expect(rows[1]).toHaveTextContent('older')
  })

  it('expands a row to its full detail and context, and collapses it again', async () => {
    const user = userEvent.setup()
    resetStore(
      [
        makeError({
          id: 1,
          seenAt: 1,
          detail: 'Error: boom\n  at pump (runner.ts:344)',
          context: { status: 500, url: '/api/sessions/s1' },
        }),
      ],
      1,
    )

    render(<ErrorLog open onClose={() => {}} />)

    const toggle = screen.getByRole('button', { name: /show detail/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/at pump/)).not.toBeInTheDocument()

    await user.click(toggle)

    expect(screen.getByText(/at pump/)).toBeInTheDocument()
    expect(screen.getByText(/"url": "\/api\/sessions\/s1"/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /hide detail/i }))
    expect(screen.queryByText(/at pump/)).not.toBeInTheDocument()
  })

  it('copies the whole record, not the one line the row shows', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    resetStore([makeError({ id: 7, seenAt: 1, detail: 'the stack', message: 'the message' })])

    render(<ErrorLog open onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: /copy error 7/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const copied = writeText.mock.calls[0][0] as string
    expect(copied).toContain('the message')
    expect(copied).toContain('the stack')
  })

  it('marks a record stamped by a dev build with the DEV chip, so it reads apart from real errors', () => {
    // Canvas 5c: a dev record carries a dashed DEV chip and drops to muted
    // ink; a real error never shows the chip.
    resetStore([
      makeError({ id: 2, seenAt: 1, message: 'from a dev rebuild', context: { dev: true } }),
      makeError({ id: 1, seenAt: 1, message: 'a real one' }),
    ])

    render(<ErrorLog open onClose={() => {}} />)

    const rows = within(screen.getByRole('list', { name: /recorded errors/i })).getAllByRole(
      'listitem',
    )
    expect(within(rows[0]).getByText('DEV')).toBeInTheDocument()
    expect(within(rows[1]).queryByText('DEV')).not.toBeInTheDocument()
  })

  it('spells the kind out in uppercase without the underscore (canvas 5b)', () => {
    resetStore([makeError({ id: 1, seenAt: 1, kind: 'render_crash' })])

    render(<ErrorLog open onClose={() => {}} />)

    expect(screen.getByText('RENDER CRASH')).toBeInTheDocument()
  })

  it('marks nothing on open — reading is not marking', async () => {
    // The inbox contract: rows leave the list only when the user says so.
    resetStore([makeError({ id: 2 }), makeError({ id: 1 })], 2)

    render(<ErrorLog open onClose={() => {}} />)

    expect(api.markErrorsSeen).not.toHaveBeenCalled()
    expect(useOrbital.getState().errorsUnseen).toBe(2)
  })

  it('Mark all seen stamps the whole table and empties the inbox', async () => {
    const user = userEvent.setup()
    resetStore([makeError({ id: 2 }), makeError({ id: 1 })], 2)

    render(<ErrorLog open onClose={() => {}} />)
    await user.click(screen.getByRole('button', { name: /mark all seen/i }))

    await waitFor(() => expect(api.markErrorsSeen).toHaveBeenCalledWith('all'))
    // The rows leave the list (they stay in the server's table).
    await waitFor(() => expect(useOrbital.getState().errors).toEqual([]))
    expect(useOrbital.getState().errorsUnseen).toBe(0)
  })
})

describe('Toasts', () => {
  it('offers a Detail button that opens the log', async () => {
    const user = userEvent.setup()
    useOrbital.setState({ toast: { kind: 'error', message: 'spawn claude ENOENT' } })

    render(<Toasts />)
    await user.click(screen.getByRole('button', { name: /detail/i }))

    expect(useOrbital.getState().ui.dialog).toBe('errors')
  })

  it('does not mark anything seen when the toast is dismissed', async () => {
    const user = userEvent.setup()
    resetStore([makeError({ id: 1 })], 3)
    useOrbital.setState({ toast: { kind: 'error', message: 'spawn claude ENOENT' } })

    render(<Toasts />)
    await user.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(useOrbital.getState().toast).toBeNull()
    // The store holds one toast at a time, so a burst overwrites itself —
    // which is exactly why dismissing one must not count as having read it.
    expect(api.markErrorsSeen).not.toHaveBeenCalled()
    expect(useOrbital.getState().errorsUnseen).toBe(3)
    expect(useOrbital.getState().errors[0].seenAt).toBeNull()
  })
})

describe('reportError', () => {
  it('sets the toast and records the status, the URL and the response body', async () => {
    reportError(new ApiError('{"error":"not found"}', 404, '/api/sessions/s1'), 'Failed to rename')

    expect(useOrbital.getState().toast).toEqual({
      kind: 'error',
      message: '{"error":"not found"}',
    })

    await waitFor(() => expect(api.reportErrorToServer).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.reportErrorToServer).mock.calls[0][0]).toEqual({
      kind: 'api_request',
      message: '{"error":"not found"}',
      // An ApiError's message IS the response body, so that is the detail.
      detail: '{"error":"not found"}',
      context: { status: 404, url: '/api/sessions/s1' },
    })
  })

  it('keeps the stack as the detail for a plain Error, with no context to invent', async () => {
    reportError(new Error('network down'), 'Failed to rename')

    await waitFor(() => expect(api.reportErrorToServer).toHaveBeenCalledTimes(1))
    const body = vi.mocked(api.reportErrorToServer).mock.calls[0][0]
    expect(body.message).toBe('network down')
    expect(body.detail).toContain('network down')
    expect(body.context).toBeNull()
  })

  it('falls back to the caller’s sentence when what was thrown is not an Error', async () => {
    reportError('just a string', 'Failed to rename session')

    expect(useOrbital.getState().toast?.message).toBe('Failed to rename session')
    await waitFor(() => expect(api.reportErrorToServer).toHaveBeenCalledTimes(1))
  })

  it('does not feed itself when the report POST is the thing that fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(api.reportErrorToServer).mockRejectedValue(new ApiError('down', 503))

    reportError(new Error('network down'), 'Failed to rename')

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        'orbital: failed to record an error',
        expect.any(Error),
      ),
    )
    // One post, ever. A second would be the loop this guard exists to stop.
    expect(api.reportErrorToServer).toHaveBeenCalledTimes(1)
    // And the toast still says what the user's own action did.
    expect(useOrbital.getState().toast?.message).toBe('network down')
  })
})
