import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSession, ChatMessage, ContextReport } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { ApiError, api, type ContextReportAnswer } from '../lib/api'
import { useContextReport } from '../store/contextReport'
import { useOrbital } from '../store/store'
import { configureTakeReport, latestContextAnswer, reportSourceFor, takeReport } from '../store/takeContextReport'

/**
 * Opening the report from the context read-out (spec
 * 2026-11-19-context-report-dialog-design § Opening it from the context
 * read-out; canvas 71a–71e): fresh from a session Orbital runs, the Mac's kept
 * one otherwise, the transcript's against an older Mac; at once with what the
 * read-out knows, and never a row in the transcript.
 */

function report(totalTokens: number): ContextReport {
  return {
    model: 'claude-opus-5', totalTokens, rawMaxTokens: 200000, percentage: Math.round(totalTokens / 2000),
    categories: [], mcpTools: [], memoryFiles: [], agents: [], skills: [],
  }
}

const AT = '2026-11-19T10:00:00Z'

function contextAnswer(id: string, totalTokens: number, timestamp = AT): ChatMessage {
  return {
    id, role: 'notice', text: '## Context Usage', timestamp,
    notice: { level: 'notice', command: '/context', contextReport: report(totalTokens) },
  }
}

const said = (id: string): ChatMessage => ({ id, role: 'assistant', text: 'hi' })

function session(over: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's1', cwd: '/w/x', title: 'Session', firstAt: 1, lastAt: 1, messageCount: 0, source: 'web',
    permissionMode: null, model: null, resolvedModel: 'claude-opus-5', tagIds: [], status: 'needs_input', subagents: [],
    contextUsedTokens: 50000, contextReportAt: null,
    ...over,
  }
}

function seed(s: ApiSession, messages: ChatMessage[] = []) {
  useOrbital.setState((state) => ({
    sessions: { ...state.sessions, [s.id]: s },
    transcripts: { ...state.transcripts, [s.id]: messages },
    contextWindows: { 'claude-opus-5': 200000 },
  }))
}

const fresh = (totalTokens: number, takenAt = '2026-11-19T11:00:00Z'): ContextReportAnswer => ({ report: report(totalTokens), takenAt, fresh: true })

beforeEach(() => {
  vi.clearAllMocks()
  configureTakeReport({ asleep: () => false })
  useContextReport.setState({ open: null, asked: {}, onScreen: 's1' })
})

describe('latestContextAnswer', () => {
  it('is the newest /context answer with a report, and null without one', () => {
    const bare: ChatMessage = { id: 'n3', role: 'notice', text: 'old CLI', notice: { level: 'notice', command: '/context' } }
    expect(latestContextAnswer([contextAnswer('n1', 1), said('a'), contextAnswer('n2', 2), bare, said('b')])?.id).toBe('n2')
    expect(latestContextAnswer([said('a'), bare])).toBeNull()
    expect(latestContextAnswer(undefined)).toBeNull()
  })
})

describe('reportSourceFor', () => {
  it('takes it now from an Orbital session that runs, working or waiting', () => {
    expect(reportSourceFor(session({ status: 'needs_input' }), [])).toBe('live')
    expect(reportSourceFor(session({ status: 'working' }), [])).toBe('live')
  })

  it('opens the kept one for a session that is ended, asleep or a terminal’s, else the transcript’s, else nothing', () => {
    for (const over of [{ status: 'ended' as const }, { status: 'idle' as const }, { source: 'terminal' as const, status: 'working' as const }]) {
      expect(reportSourceFor(session({ ...over, contextReportAt: 5 }), [])).toBe('kept')
      // Nothing kept yet — the transcript not indexed since the update — but the loaded one holds a /context.
      expect(reportSourceFor(session({ ...over, contextReportAt: null }), [contextAnswer('n1', 1)])).toBe('transcript')
      expect(reportSourceFor(session({ ...over, contextReportAt: null }), [said('a')])).toBeNull()
    }
  })

  it('falls back to the loaded transcript against an older Mac, which sends no contextReportAt', () => {
    expect(reportSourceFor(session({ contextReportAt: undefined }), [contextAnswer('n1', 1)])).toBe('transcript')
    expect(reportSourceFor(session({ contextReportAt: undefined }), [said('a')])).toBeNull()
    expect(reportSourceFor(undefined, undefined)).toBeNull()
  })
})

describe('takeReport', () => {
  it('opens at once with what the read-out knows, then fills in the fresh report, touching no transcript', async () => {
    const messages = [said('a')]
    seed(session(), messages)
    let answer!: (v: ContextReportAnswer) => void
    vi.mocked(api.contextReport).mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const pending = takeReport('s1')
    const loading = useContextReport.getState().open
    expect(loading).toMatchObject({
      phase: 'loading', counting: true, origin: 'readout', snapshot: null,
      preview: { used: 50000, window: 200000, model: 'claude-opus-5' },
    })
    answer(fresh(5000))
    expect(await pending).toBe('live')
    expect(useContextReport.getState().open).toMatchObject({
      key: loading?.key, phase: 'ready', snapshot: { report: report(5000), takenAt: '2026-11-19T11:00:00Z', text: null },
    })
    expect(useOrbital.getState().transcripts.s1).toBe(messages)
  })

  it('opens an ended session’s kept report from the transcript at once when it is the same one', async () => {
    seed(session({ status: 'ended', contextReportAt: Date.parse(AT) }), [contextAnswer('n1', 1)])
    expect(await takeReport('s1')).toBe('kept')
    expect(api.contextReport).not.toHaveBeenCalled()
    expect(useContextReport.getState().open).toMatchObject({ phase: 'ready', origin: 'ended', snapshot: { text: '## Context Usage' } })
  })

  it('fetches a kept report the transcript does not hold, without counting words', async () => {
    seed(session({ status: 'idle', contextReportAt: Date.parse('2026-11-19T12:00:00Z') }), [contextAnswer('n1', 1)])
    vi.mocked(api.contextReport).mockResolvedValue({ report: report(9), takenAt: '2026-11-19T12:00:00Z', fresh: false })
    const pending = takeReport('s1')
    expect(useContextReport.getState().open).toMatchObject({ phase: 'loading', counting: false })
    expect(await pending).toBe('kept')
    expect(useContextReport.getState().open?.snapshot?.report.totalTokens).toBe(9)
  })

  it('fails with why, the Mac’s earlier report, and Try again on the same opening', async () => {
    seed(session(), [contextAnswer('n1', 1)])
    vi.mocked(api.contextReport).mockResolvedValue({ error: 'timeout', earlier: { report: report(3), takenAt: '2026-11-19T09:00:00Z' } })
    expect(await takeReport('s1')).toBe('failed')
    const failed = useContextReport.getState().open!
    expect(failed).toMatchObject({ phase: 'failed', failure: 'timeout', earlier: { report: report(3), text: null } })

    vi.mocked(api.contextReport).mockResolvedValue(fresh(4))
    expect(await takeReport('s1', { key: failed.key })).toBe('live')
    expect(useContextReport.getState().open).toMatchObject({ key: failed.key, phase: 'ready' })
  })

  it('offers the transcript’s report when the Mac cannot be reached, and shows it on asking', async () => {
    seed(session(), [contextAnswer('n1', 1)])
    vi.mocked(api.contextReport).mockRejectedValue(new ApiError('Not Found', 404))
    expect(await takeReport('s1')).toBe('failed')
    expect(useContextReport.getState().open).toMatchObject({ failure: 'unreachable', earlier: { text: '## Context Usage' } })
    useContextReport.getState().showEarlier()
    expect(useContextReport.getState().open).toMatchObject({ phase: 'ready', snapshot: { report: report(1) } })
  })

  it('says out of reach for a request that never got an answer, or a member Mac offline', async () => {
    seed(session(), [])
    for (const err of [new TypeError('tunnel failed'), new ApiError('{"error":"member_offline"}', 409)]) {
      vi.mocked(api.contextReport).mockRejectedValue(err)
      expect(await takeReport('s1')).toBe('failed')
      expect(useContextReport.getState().open).toMatchObject({ failure: 'unreachable' })
    }
    expect(api.reportErrorToServer).not.toHaveBeenCalled()
  })

  it('says failed for any other status, and records it', async () => {
    seed(session(), [])
    vi.mocked(api.contextReport).mockRejectedValue(new ApiError('Internal Server Error', 500, '/api/sessions/s1/context-report'))
    expect(await takeReport('s1')).toBe('failed')
    expect(useContextReport.getState().open).toMatchObject({ failure: 'failed' })
    expect(api.reportErrorToServer).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'api_request', context: { status: 500, url: '/api/sessions/s1/context-report' },
    }))
  })

  it('fails at once while the phone’s Mac is asleep', async () => {
    configureTakeReport({ asleep: () => true })
    seed(session(), [])
    expect(await takeReport('s1')).toBe('failed')
    expect(api.contextReport).not.toHaveBeenCalled()
    expect(useContextReport.getState().open).toMatchObject({ failure: 'asleep', earlier: null })
  })

  it('opens nothing when there is nothing to open, and drops an answer for a closed or replaced opening', async () => {
    seed(session({ status: 'ended' }), [said('a')])
    expect(await takeReport('s1')).toBe('none')
    expect(useContextReport.getState().open).toBeNull()

    seed(session(), [])
    let answer!: (v: ContextReportAnswer) => void
    vi.mocked(api.contextReport).mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const closed = takeReport('s1')
    useContextReport.getState().close()
    answer(fresh(1))
    expect(await closed).toBe('none')
    expect(useContextReport.getState().open).toBeNull()

    const earlier = takeReport('s1')
    const answerEarlier = answer
    const later = takeReport('s1')
    answerEarlier(fresh(1))
    expect(await earlier).toBe('none')
    answer(fresh(2))
    expect(await later).toBe('live')
    expect(useContextReport.getState().open?.snapshot?.report.totalTokens).toBe(2)
  })
})

