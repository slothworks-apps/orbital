import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ApiSession, Walkthrough } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())
vi.mock('../lib/socket', () => ({ getSocket: () => ({ subscribe: () => () => {}, onStatusChange: () => () => {} }) }))

import { api } from '../lib/api'
import { WalkthroughPage } from '../walkthrough/WalkthroughPage'
import { installKeyListener } from '../lib/commands'
import { MAP_PATH } from '../lib/pageCrumbs'
import { STATS_PATH } from '../stats/route'
import { walkthroughPath } from '../walkthrough/route'
import { stubLocationAssign } from './stubLocationAssign'

const session = (patch: Partial<ApiSession> = {}) =>
  ({ id: 'w1', title: 'auth-refactor', status: 'idle', source: 'web', cwd: '/w/auth', ide: null, subagents: [], ...patch }) as unknown as ApiSession

const edit = (id: string, path: string, from: string, to: string) => ({
  call: { id: `${id}:1`, role: 'tool_use' as const, toolName: 'Edit', toolInput: { file_path: path, old_string: from, new_string: to }, toolUseId: id },
  result: { id: `${id}:r`, role: 'tool_result' as const, toolUseId: id, text: 'ok' },
})
const walkthrough: Walkthrough = {
  steps: [
    { id: 'e1', ordinal: 1, narration: 'Adding the margin.', calls: [edit('e1', 'src/refresh.ts', 'skew = 0', 'skew = 30')], folded: { Read: 2 }, subagent: null, fate: [{ kind: 'revised', byStep: 'e2', path: 'src/refresh.ts' }], questions: [{ question: 'Why?', answer: 'Because.', messageId: 'q1' }], durationMs: 14200 },
    { id: 'e2', ordinal: 2, narration: 'Into config.', calls: [edit('e2', 'src/refresh.ts', 'skew = 30', 'skew = cfg')], folded: {}, subagent: null, fate: [], questions: [], durationMs: null },
  ],
  timeline: [{ kind: 'gap', durationMs: 5000, folded: { Read: 4 }, subagents: [], said: 'Looking around.' }, { kind: 'step', id: 'e1' }, { kind: 'step', id: 'e2' }],
  files: [{ path: 'src/refresh.ts', steps: ['e1', 'e2'], created: false, fate: 'revised', notApplied: false }],
  narration: null, narrationFailed: false, narrationPending: false, lastMessageId: 'x',
}

beforeEach(() => {
  vi.mocked(api.getSettings).mockResolvedValue({ walkthrough_enabled: 'true' })
  vi.mocked(api.getWalkthrough).mockResolvedValue({ session: session(), walkthrough })
})

describe('WalkthroughPage', () => {
  it('sends a link to the map while the Experimental switch is off', async () => {
    vi.mocked(api.getSettings).mockResolvedValue({})
    const replace = vi.fn()
    vi.stubGlobal('location', { ...window.location, replace, origin: window.location.origin })
    render(<WalkthroughPage id="w1" />)
    await waitFor(() => expect(replace).toHaveBeenCalledWith(expect.stringContaining('w1')))
    expect(api.getWalkthrough).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('opens on the cover with the counts, starts into step 1, and shows the diff and the exchange', async () => {
    render(<WalkthroughPage id="w1" />)
    await screen.findByRole('heading', { name: 'auth-refactor' })
    expect(screen.getByLabelText('steps')).toHaveTextContent('2')
    expect(screen.getByLabelText('files touched')).toHaveTextContent('1')
    fireEvent.click(screen.getByRole('button', { name: /start/i }))
    // The eyebrow and the top bar both say it; the rail repeats the narration.
    expect((await screen.findAllByText(/step 1 of 2/i)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Adding the margin.').length).toBeGreaterThan(0)
    expect(screen.getByText('Looking around.')).toBeInTheDocument()       // the gap before step 1, said verbatim
    expect(screen.getByText(/revised in/)).toBeInTheDocument()
    expect(screen.getByText('Why?')).toBeInTheDocument()
    expect(screen.getByText('Because.')).toBeInTheDocument()
  })

  it('goes up to the cover on ⌘↑ from a step, without leaving the page', async () => {
    const uninstall = installKeyListener()
    try {
      render(<WalkthroughPage id="w1" />)
      fireEvent.click(await screen.findByRole('button', { name: /start/i }))
      await screen.findAllByText(/step 1 of 2/i)
      expect(document.title).toBe('step 1 · auth-refactor · Orbital')
      fireEvent.keyDown(window, { key: 'ArrowUp', code: 'ArrowUp', metaKey: true })
      expect(await screen.findByRole('button', { name: /start/i })).toBeInTheDocument()
      expect(document.title).toBe('auth-refactor · Walkthrough · Orbital')
    } finally {
      uninstall()
    }
  })

  it('⌘1 loads the map and ⌘2 the stats page', async () => {
    const uninstall = installKeyListener()
    const { assign, restore } = stubLocationAssign()
    window.history.replaceState(null, '', walkthroughPath('w1'))
    try {
      render(<WalkthroughPage id="w1" />)
      await screen.findByRole('heading', { name: 'auth-refactor' })

      fireEvent.keyDown(window, { key: '1', code: 'Digit1', metaKey: true })
      expect(assign).toHaveBeenLastCalledWith(MAP_PATH)
      fireEvent.keyDown(window, { key: '2', code: 'Digit2', metaKey: true })
      expect(assign).toHaveBeenLastCalledWith(STATS_PATH)
    } finally {
      restore()
      uninstall()
      window.history.replaceState(null, '', '/')
    }
  })

  it('asks the session from a step', async () => {
    vi.mocked(api.askWalkthrough).mockResolvedValue({ ok: true })
    render(<WalkthroughPage id="w1" />)
    fireEvent.click(await screen.findByRole('button', { name: /start/i }))
    const field = await screen.findByPlaceholderText(/ask the session/i)
    fireEvent.change(field, { target: { value: 'Why the margin?' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(api.askWalkthrough).toHaveBeenCalledWith('w1', 'e1', 'Why the margin?'))
  })

  it('disables the field, with the reason, while the session is working', async () => {
    vi.mocked(api.getWalkthrough).mockResolvedValue({ session: session({ status: 'working' }), walkthrough })
    render(<WalkthroughPage id="w1" />)
    fireEvent.click(await screen.findByRole('button', { name: /start/i }))
    const field = await screen.findByPlaceholderText(/ask the session/i)
    expect((field as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByText(/asking waits until it settles/i)).toBeInTheDocument()
  })

  it('narrates on request from the cover', async () => {
    vi.mocked(api.narrateWalkthrough).mockResolvedValue({ ok: true })
    render(<WalkthroughPage id="w1" />)
    fireEvent.click(await screen.findByRole('button', { name: /^narrate/i }))
    await waitFor(() => expect(api.narrateWalkthrough).toHaveBeenCalledWith('w1'))
  })

  it('says so when the session is unknown', async () => {
    const { ApiError } = await import('../lib/api')
    vi.mocked(api.getWalkthrough).mockRejectedValue(new ApiError('nf', 404))
    render(<WalkthroughPage id="nope" />)
    expect(await screen.findByText(/not known/i)).toBeInTheDocument()
  })
})
