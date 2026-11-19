import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSession, LimitWait } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { useContextReport } from '../store/contextReport'
import { useOrbital } from '../store/store'

/**
 * When a `/context` sent from here counts as asking for the report (spec
 * 2026-11-19-context-report-dialog-design § When it opens): only when it
 * goes out now, and never past a reconnect.
 */

function session(over: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's1',
    cwd: '/w/x',
    title: 'Session',
    firstAt: 1,
    lastAt: 1,
    messageCount: 0,
    source: 'web',
    permissionMode: null,
    model: null,
    resolvedModel: null,
    tagIds: [],
    status: 'idle',
    subagents: [],
    ...over,
  }
}

const WAIT: LimitWait = {
  resetsAt: '2026-11-19T18:00:00Z',
  windowKind: 'five_hour',
  windowLabel: '5-hour window',
  cancelled: false,
  willContinue: true,
  queued: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.sendMessage).mockResolvedValue(undefined as never)
  useContextReport.setState({ open: null, asked: {}, onScreen: null, taking: null })
})

function seed(s: ApiSession) {
  useOrbital.setState({ sessions: { [s.id]: s }, order: [s.id], transcripts: {}, browserSelections: {}, composerDrafts: {} })
}

describe('asking for the report', () => {
  it('asks when a /context goes out', async () => {
    seed(session())
    await useOrbital.getState().sendPrompt('s1', '/context')
    expect(useContextReport.getState().asked).toEqual({ s1: true })
  })

  it('does not ask when the /context is queued behind a limit wait', async () => {
    seed(session({ limitWait: WAIT }))
    await useOrbital.getState().sendPrompt('s1', '/context')
    expect(api.sendMessage).toHaveBeenCalled()
    expect(useContextReport.getState().asked).toEqual({})
  })

  it('forgets every ask on a reconnect, whose catch-up delivers answers as history', async () => {
    useContextReport.setState({ asked: { s1: true, s2: true } })
    await useOrbital.getState().resyncAfterReconnect()
    expect(useContextReport.getState().asked).toEqual({})
  })
})
