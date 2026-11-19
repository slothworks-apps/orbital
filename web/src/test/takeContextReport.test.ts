import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSession, ChatMessage, ContextReport } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { ApiError, api } from '../lib/api'
import { useContextReport } from '../store/contextReport'
import { useOrbital } from '../store/store'
import {
  configureTakeReport,
  latestContextAnswer,
  reportSourceFor,
  takeReport,
} from '../store/takeContextReport'

/**
 * Opening the report from the context read-out (spec
 * 2026-11-19-context-report-dialog-design § Opening it from the context
 * read-out): taken now from a live Orbital session, else the transcript's
 * last `/context`, and never a row in the transcript.
 */

function report(totalTokens: number): ContextReport {
  return {
    model: 'claude-opus-5', totalTokens, rawMaxTokens: 200000, percentage: Math.round(totalTokens / 2000),
    categories: [], mcpTools: [], memoryFiles: [], agents: [], skills: [],
  }
}

function contextAnswer(id: string, totalTokens: number): ChatMessage {
  return {
    id, role: 'notice', text: '## Context Usage', timestamp: '2026-11-19T10:00:00Z',
    notice: { level: 'notice', command: '/context', contextReport: report(totalTokens) },
  }
}

const said = (id: string): ChatMessage => ({ id, role: 'assistant', text: 'hi' })

function session(over: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's1', cwd: '/w/x', title: 'Session', firstAt: 1, lastAt: 1, messageCount: 0, source: 'web',
    permissionMode: null, model: null, resolvedModel: null, tagIds: [], status: 'needs_input', subagents: [],
    ...over,
  }
}

function seed(s: ApiSession, messages: ChatMessage[] = []) {
  useOrbital.setState((state) => ({
    sessions: { ...state.sessions, [s.id]: s },
    transcripts: { ...state.transcripts, [s.id]: messages },
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  configureTakeReport({ servesOnDemand: () => true })
  useContextReport.setState({ open: null, asked: {}, onScreen: 's1', taking: null })
})

describe('latestContextAnswer', () => {
  it('is the newest /context answer with a report, and null without one', () => {
    const older = contextAnswer('n1', 1000)
    const newer = contextAnswer('n2', 2000)
    const bare: ChatMessage = { id: 'n3', role: 'notice', text: 'old CLI', notice: { level: 'notice', command: '/context' } }
    expect(latestContextAnswer([older, said('a'), newer, bare, said('b')])?.id).toBe('n2')
    expect(latestContextAnswer([said('a'), bare])).toBeNull()
    expect(latestContextAnswer(undefined)).toBeNull()
  })
})

describe('reportSourceFor', () => {
  const history = [contextAnswer('n1', 1000)]

  it('takes it now from an Orbital session that runs, working or waiting', () => {
    expect(reportSourceFor(session({ status: 'needs_input' }), [], true)).toBe('live')
    expect(reportSourceFor(session({ status: 'working' }), [], true)).toBe('live')
  })

  it('opens the transcript’s for one that is ended, asleep, a terminal’s, or on a Mac too old to ask', () => {
    expect(reportSourceFor(session({ status: 'ended' }), history, true)).toBe('transcript')
    expect(reportSourceFor(session({ status: 'idle' }), history, true)).toBe('transcript')
    expect(reportSourceFor(session({ source: 'terminal', status: 'working' }), history, true)).toBe('transcript')
    expect(reportSourceFor(session(), history, false)).toBe('transcript')
  })

  it('has nothing to open when neither is there', () => {
    expect(reportSourceFor(session({ status: 'idle' }), [said('a')], true)).toBeNull()
    expect(reportSourceFor(session(), [], false)).toBeNull()
    expect(reportSourceFor(undefined, undefined, true)).toBeNull()
  })
})

describe('takeReport', () => {
  it('opens a report taken now, without a printout and without touching the transcript', async () => {
    const messages = [said('a')]
    seed(session(), messages)
    vi.mocked(api.contextReport).mockResolvedValue({ report: report(5000), takenAt: '2026-11-19T11:00:00Z' })
    const pending = takeReport('s1')
    expect(useContextReport.getState().taking).toBe('s1')
    expect(await pending).toBe('live')
    expect(api.contextReport).toHaveBeenCalledWith('s1')
    expect(useContextReport.getState().taking).toBeNull()
    expect(useContextReport.getState().open).toEqual({
      sessionId: 's1', key: 'taken:2026-11-19T11:00:00Z', report: report(5000), takenAt: '2026-11-19T11:00:00Z', text: null,
    })
    expect(useOrbital.getState().transcripts.s1).toBe(messages)
  })

  it('opens the transcript’s last /context when the Mac refuses or cannot be asked', async () => {
    seed(session(), [contextAnswer('n1', 1000), said('a')])
    vi.mocked(api.contextReport).mockResolvedValue({ error: 'not_running' })
    expect(await takeReport('s1')).toBe('transcript')
    expect(useContextReport.getState().open).toMatchObject({ key: 'n1', text: '## Context Usage', takenAt: '2026-11-19T10:00:00Z' })

    useContextReport.setState({ open: null })
    vi.mocked(api.contextReport).mockRejectedValue(new ApiError('Not Found', 404))
    expect(await takeReport('s1')).toBe('transcript')
    expect(useContextReport.getState().open?.key).toBe('n1')
    expect(useContextReport.getState().taking).toBeNull()
  })

  it('does not ask a session that is not live, or a Mac too old for the route', async () => {
    seed(session({ status: 'idle' }), [contextAnswer('n1', 1000)])
    expect(await takeReport('s1')).toBe('transcript')
    seed(session(), [contextAnswer('n1', 1000)])
    configureTakeReport({ servesOnDemand: () => false })
    expect(await takeReport('s1')).toBe('transcript')
    expect(api.contextReport).not.toHaveBeenCalled()
  })

  it('opens nothing when there is nothing to open', async () => {
    seed(session({ status: 'ended' }), [said('a')])
    expect(await takeReport('s1')).toBe('none')
    expect(useContextReport.getState().open).toBeNull()
  })

  it('opens nothing once the session has left the screen, and lets a later take supersede it', async () => {
    seed(session(), [contextAnswer('n1', 1000)])
    let answer!: (v: Awaited<ReturnType<typeof api.contextReport>>) => void
    vi.mocked(api.contextReport).mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const first = takeReport('s1')
    useContextReport.setState({ onScreen: 's2' })
    answer({ report: report(5000), takenAt: '2026-11-19T11:00:00Z' })
    expect(await first).toBe('none')
    expect(useContextReport.getState().open).toBeNull()

    useContextReport.setState({ onScreen: 's1' })
    const earlier = takeReport('s1')
    const answerEarlier = answer
    const later = takeReport('s1')
    answerEarlier({ report: report(1), takenAt: '2026-11-19T11:01:00Z' })
    expect(await earlier).toBe('none')
    expect(useContextReport.getState().taking).toBe('s1')
    answer({ report: report(2), takenAt: '2026-11-19T11:02:00Z' })
    expect(await later).toBe('live')
    expect(useContextReport.getState().open?.key).toBe('taken:2026-11-19T11:02:00Z')
  })
})
