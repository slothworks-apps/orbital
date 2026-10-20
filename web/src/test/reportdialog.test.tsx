import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ErrorRecord } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api, ApiError } from '../lib/api'
import { MAX_ISSUE_URL_CHARS } from '../lib/issueReport'
import { ReportDialog } from '../panels/report/ReportDialog'
import { issueNumber, thinThousands } from '../panels/report/logic'
import { mergeExiting } from '../ui/useExitList'
import { useOrbital } from '../store/store'

// ---------------------------------------------------------------------------
// The review step before anything reaches Orbital's GitHub
// (spec 2026-10-20-report-to-github-design, canvas `Feature - Feedback` 61d):
// which way the issue goes out for each state of `gh`, and what the dialog
// says when it cannot.
// ---------------------------------------------------------------------------

function makeError(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    id: 7,
    at: 1_700_000_000_000,
    source: 'server',
    kind: 'api_request',
    sessionId: null,
    message: 'upstream closed the stream',
    detail: 'Error: boom',
    context: null,
    seenAt: 1,
    issueUrl: null,
    ...overrides,
  }
}

let opened: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.mocked(api.issueEnvironment).mockResolvedValue({ osVersion: '15.1', ghLogin: 'mira' })
  vi.mocked(api.similarIssues).mockResolvedValue([])
  opened = vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => {
  useOrbital.setState((s) => ({ settings: { ...s.settings, issue_check_enabled: 'false' } }))
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

function renderError(error = makeError()) {
  return render(<ReportDialog open kind="error" error={error} onClose={() => {}} />)
}

describe('ReportDialog', () => {
  it('with gh ready, creates the issue through gh for this record and links it', async () => {
    const user = userEvent.setup()
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'ready' })
    vi.mocked(api.createIssue).mockResolvedValue({ url: 'https://github.com/slothworks-apps/orbital/issues/123' })
    renderError()

    await user.click(await screen.findByRole('button', { name: 'Create issue' }))

    await waitFor(() => expect(api.createIssue).toHaveBeenCalledTimes(1))
    expect(vi.mocked(api.createIssue).mock.calls[0][0]).toMatchObject({ errorId: 7 })
    expect(await screen.findByRole('link', { name: '#123 ↗' })).toHaveAttribute(
      'href',
      'https://github.com/slothworks-apps/orbital/issues/123',
    )
    expect(screen.getByText('PUBLISHED · ISSUE #123')).toBeInTheDocument()
    expect(opened).not.toHaveBeenCalled()
  })

  it('without gh, opens the prefilled form in the browser and sends nothing itself', async () => {
    const user = userEvent.setup()
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'missing' })
    renderError()

    await user.click(await screen.findByRole('button', { name: 'Open on GitHub ↗' }))

    expect(api.createIssue).not.toHaveBeenCalled()
    expect(opened).toHaveBeenCalledTimes(1)
    expect(String(opened.mock.calls[0][0])).toMatch(/^https:\/\/github\.com\/slothworks-apps\/orbital\/issues\/new\?/)
    expect(screen.getByText('Opened in your browser — finish it there')).toBeInTheDocument()
  })

  it('falls back to the browser when gh logs out between opening and sending', async () => {
    const user = userEvent.setup()
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'ready' })
    vi.mocked(api.createIssue).mockResolvedValue({ error: 'logged_out' })
    renderError()

    await user.click(await screen.findByRole('button', { name: 'Create issue' }))

    await waitFor(() => expect(opened).toHaveBeenCalledTimes(1))
    expect(screen.getByText('in your browser')).toBeInTheDocument()
  })

  it('shows what gh said when it refuses, keeps the text, and offers to try again', async () => {
    const user = userEvent.setup()
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'ready' })
    vi.mocked(api.createIssue).mockRejectedValue(
      new ApiError(JSON.stringify({ error: 'gh: HTTP 401: Bad credentials\nTry authenticating with:  gh auth login' }), 502),
    )
    renderError()

    const title = await screen.findByDisplayValue('API request: upstream closed the stream')
    await user.click(screen.getByRole('button', { name: 'Create issue' }))

    const alert = await screen.findByRole('alert')
    // Verbatim — both lines, not the JSON envelope around them.
    expect(alert.querySelector('pre')?.textContent).toBe(
      'gh: HTTP 401: Bad credentials\nTry authenticating with:  gh auth login',
    )
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(title).toBeInTheDocument()
    expect(title).not.toHaveAttribute('readonly')

    await user.click(within(alert).getByRole('button', { name: /open on github instead/i }))
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('puts the whole body on the clipboard when the link has to cut it', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'missing' })
    renderError(makeError({ detail: 'x'.repeat(MAX_ISSUE_URL_CHARS * 2) }))

    await user.click(await screen.findByRole('button', { name: 'Open on GitHub ↗' }))

    expect(String(opened.mock.calls[0][0]).length).toBeLessThanOrEqual(MAX_ISSUE_URL_CHARS)
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0][0]).toContain('x'.repeat(MAX_ISSUE_URL_CHARS * 2))
    expect(screen.getByText('Full record copied — paste it into Logs')).toBeInTheDocument()
  })

  it('cannot send without a title', async () => {
    const user = userEvent.setup()
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'ready' })
    useOrbital.setState((s) => ({ settings: { ...s.settings, issue_check_enabled: 'true' } }))
    render(<ReportDialog open kind="idea" onClose={() => {}} />)

    const create = await screen.findByRole('button', { name: 'Create issue' })
    await waitFor(() => expect(create).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Check with Claude' })).toBeDisabled()

    await user.type(screen.getByPlaceholderText('The idea, in one line'), 'Pin a session')
    expect(create).toBeEnabled()
  })

  it('offers Check with Claude only while Labs has it on', async () => {
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'ready' })
    render(<ReportDialog open kind="idea" onClose={() => {}} />)
    await screen.findByRole('button', { name: 'Create issue' })
    expect(screen.queryByRole('button', { name: 'Check with Claude' })).toBeNull()
  })

  it('never says nothing was published when gh timed out, and keeps the text', async () => {
    const user = userEvent.setup()
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'ready' })
    vi.mocked(api.createIssue).mockResolvedValue({ error: 'timeout' })
    renderError()

    await user.click(await screen.findByRole('button', { name: 'Create issue' }))
    expect(await screen.findByText(/may have been created all the same/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing was published/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(opened).not.toHaveBeenCalled()
  })

  it('lists issues with a similar title', async () => {
    const user = userEvent.setup()
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'ready' })
    vi.mocked(api.similarIssues).mockResolvedValue([
      { number: 412, title: 'Stream closes after 40 s', url: 'https://github.com/slothworks-apps/orbital/issues/412', state: 'closed' },
    ])
    render(<ReportDialog open kind="broke" onClose={() => {}} />)

    await user.type(screen.getByPlaceholderText('What broke, in one line'), 'stream closes')

    const list = await screen.findByRole('list', { name: 'Similar issues' }, { timeout: 2000 })
    expect(within(list).getByRole('link')).toHaveAttribute('href', 'https://github.com/slothworks-apps/orbital/issues/412')
    expect(api.similarIssues).toHaveBeenLastCalledWith('stream closes')
  })

  it('says nothing about duplicates when GitHub could not be searched', async () => {
    const user = userEvent.setup()
    vi.mocked(api.ghStatus).mockResolvedValue({ status: 'ready' })
    vi.mocked(api.similarIssues).mockResolvedValue(null)
    render(<ReportDialog open kind="broke" onClose={() => {}} />)

    await user.type(screen.getByPlaceholderText('What broke, in one line'), 'stream closes')
    await waitFor(() => expect(api.similarIssues).toHaveBeenCalled(), { timeout: 2000 })

    await waitFor(() => expect(screen.queryByText(/by title/)).not.toBeInTheDocument())
    expect(screen.queryByRole('list', { name: 'Similar issues' })).not.toBeInTheDocument()
    expect(screen.queryByText(/no similar/i)).not.toBeInTheDocument()
  })
})

describe('report logic', () => {
  it('reads the number off an issue address and nothing else', () => {
    expect(issueNumber('https://github.com/slothworks-apps/orbital/issues/123')).toBe(123)
    expect(issueNumber('https://github.com/slothworks-apps/orbital/issues/123#issuecomment-1')).toBe(123)
    expect(issueNumber('https://github.com/slothworks-apps/orbital/pull/5')).toBeNull()
    expect(issueNumber(null)).toBeNull()
  })

  it('separates thousands with a thin space', () => {
    expect(thinThousands(999)).toBe('999')
    expect(thinThousands(1234)).toBe('1 234')
    expect(thinThousands(1234567)).toBe('1 234 567')
  })
})

describe('mergeExiting', () => {
  const key = (n: number) => n
  const entries = (...keys: number[]) => keys.map((k) => ({ item: k, key: k, leaving: false }))

  it('keeps a removed item where it was, marked leaving', () => {
    const merged = mergeExiting(entries(3, 2, 1), [3, 1], key, new Set())
    expect(merged.map((e) => [e.key, e.leaving])).toEqual([
      [3, false],
      [2, true],
      [1, false],
    ])
  })

  it('keeps a run of removed items in order, the first one included', () => {
    const merged = mergeExiting(entries(4, 3, 2, 1), [1], key, new Set())
    expect(merged.map((e) => e.key)).toEqual([4, 3, 2, 1])
    expect(merged.filter((e) => e.leaving).map((e) => e.key)).toEqual([4, 3, 2])
  })

  it('drops an item that has finished leaving, and keeps one that came back', () => {
    const prev = [
      { item: 3, key: 3, leaving: false },
      { item: 2, key: 2, leaving: true },
      { item: 1, key: 1, leaving: true },
    ]
    const merged = mergeExiting(prev, [3, 1, 0], key, new Set([2]))
    expect(merged.map((e) => [e.key, e.leaving])).toEqual([
      [3, false],
      [1, false],
      [0, false],
    ])
  })
})
