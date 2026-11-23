import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api, ApiError } from '../lib/api'
import type { PendingDecision } from '../lib/types'
import { useOrbital } from '../store/store'

const waiting: PendingDecision = {
  id: 'tu1',
  kind: 'view',
  input: { viewId: 'tu1', title: 'Release latency' },
  createdAt: 0,
  toolName: 'mcp__orbital__show_view',
  title: 'Release latency',
}

beforeEach(() => {
  vi.clearAllMocks()
  useOrbital.setState({ pendingDecisions: { s1: waiting }, viewAnswers: {}, composerDrafts: {} })
})

describe('answering a waiting view', () => {
  it('keeps words typed while the view’s answer is on its way, instead of dropping them', async () => {
    vi.mocked(api.answerView).mockReturnValue(new Promise(() => {}))
    useOrbital.getState().answerView('s1', 'tu1', { value: ['Jan'] })
    expect(await useOrbital.getState().sendPrompt('s1', 'March instead')).toBe(false)
    expect(useOrbital.getState().composerDrafts.s1).toBe('March instead')
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it('takes back its own answer when the wait was already over, so the call’s result decides', async () => {
    vi.mocked(api.answerView).mockRejectedValue(new ApiError('not_found', 404))
    expect(useOrbital.getState().answerView('s1', 'tu1', { value: ['Jan'] })).toBe(true)
    expect(useOrbital.getState().viewAnswers.tu1).toBeDefined()
    await vi.waitFor(() => expect(useOrbital.getState().viewAnswers.tu1).toBeUndefined())
    expect(useOrbital.getState().pendingDecisions.s1).toBeUndefined()
  })

  it('answers a view that waits behind a permission with what its page sent, but never with words', () => {
    const permission: PendingDecision = { id: 'p1', kind: 'permission', input: {}, createdAt: 0 }
    useOrbital.setState({ pendingDecisions: { s1: permission } })
    vi.mocked(api.answerView).mockReturnValue(new Promise(() => {}))
    expect(useOrbital.getState().answerView('s1', 'tu1', { value: 1 })).toBe(false)
    expect(useOrbital.getState().answerView('s1', 'tu1', { text: 'no' }, { behind: true })).toBe(false)
    expect(useOrbital.getState().answerView('s1', 'tu1', { value: 1 }, { behind: true })).toBe(true)
    expect(api.answerView).toHaveBeenCalledWith('s1', 'tu1', 1)
  })
})
