import { describe, expect, it } from 'vitest'
import type { ApiSession, BackgroundTask, OrbitalModel, SessionHarness, Subagent, Tag } from '../lib/types'
import {
  canSaveTitle, carriesHarness, clearKeepsLines, endStopsLines, menuFor, taskAge,
} from '../mobile/menu/sessionMenu'

const NOW = 1_000_000_000

function session(patch: Partial<ApiSession> = {}): ApiSession {
  return {
    id: 's', cwd: '/Users/tomin/work/platform/auth-service', title: 'auth-refactor', firstAt: 1, lastAt: 1,
    messageCount: 1, source: 'web', permissionMode: null, model: null, resolvedModel: null, tagIds: [],
    status: 'idle', subagents: [], ...patch,
  }
}

const agent = (state: Subagent['state']): Subagent => ({ id: state, name: 'a', state, startedAt: 1 })
const task = (patch: Partial<BackgroundTask>): BackgroundTask => ({
  id: 't', kind: 'shell', label: 'npm run dev', state: 'running', startedAt: NOW, hasOutput: true, ...patch,
})

describe('menuFor', () => {
  it('gives a live Orbital session every item, in the canvas order', () => {
    expect(menuFor(session({ status: 'working' }), false)).toEqual({
      items: ['rename', 'tag', 'pin', 'clear', 'end'], terminalNote: false, inert: false,
    })
  })

  it('drops End once an Orbital session has ended, and keeps Clear', () => {
    expect(menuFor(session({ status: 'ended' }), false).items).toEqual(['rename', 'tag', 'pin', 'clear'])
  })

  it('never offers a terminal session End or Clear, ended or not, and says why', () => {
    for (const status of ['idle', 'working', 'ended'] as const) {
      expect(menuFor(session({ source: 'terminal', status }), false)).toEqual({
        items: ['rename', 'tag', 'pin'], terminalNote: true, inert: false,
      })
    }
  })

  it('keeps the same items asleep, all inert', () => {
    expect(menuFor(session(), true)).toEqual({ items: ['rename', 'tag', 'pin', 'clear', 'end'], terminalNote: false, inert: true })
    expect(menuFor(session({ source: 'terminal' }), true).inert).toBe(true)
  })
})

describe('endStopsLines', () => {
  it('counts the running subagents and names each running task with its age', () => {
    const s = session({
      subagents: [agent('working'), agent('needs_input'), agent('ended')],
      backgroundTasks: [
        task({ startedAt: NOW - (3 * 60 + 4) * 60_000 }),
        task({ id: 'done', label: 'tsc', state: 'ended', status: 'completed' }),
      ],
    })
    expect(endStopsLines(s, NOW)).toEqual([
      'stops with it · 2 running subagents',
      'stops with it · ▣ npm run dev (3h 04m)',
    ])
  })

  it('says one subagent in the singular, and nothing when nothing else runs', () => {
    expect(endStopsLines(session({ subagents: [agent('working')] }), NOW)).toEqual(['stops with it · 1 running subagent'])
    expect(endStopsLines(session({ subagents: [agent('ended')] }), NOW)).toEqual([])
  })
})

describe('taskAge', () => {
  it('reads minutes under an hour and pads them past one', () => {
    expect(taskAge(42 * 60_000)).toBe('42m')
    expect(taskAge(60 * 60_000)).toBe('1h 00m')
    expect(taskAge(-5)).toBe('0m')
  })
})

describe('clearKeepsLines', () => {
  const tags: Tag[] = [{ id: 1, name: 'work', hue: 210, is_default: 0 }]
  const models = [
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'sonnet', shortVersion: 'Sonnet 5' },
  ] as unknown as OrbitalModel[]

  it("lists the session's own folder, tag, model and mode, then the context it drops", () => {
    const s = session({ tagIds: [1], model: 'sonnet', permissionMode: 'acceptEdits', contextUsedTokens: 212_000 })
    const lines = clearKeepsLines(s, tags, models)
    expect(lines[0]).toBe('keeps · ~/work/platform/auth-service')
    expect(lines[1]).toMatch(/^keeps · work · .+ · acceptEdits$/)
    expect(lines[2]).toBe('context · 212k → 0')
  })

  it("names a null model and mode as the Mac's default, and skips an unmeasured context", () => {
    expect(clearKeepsLines(session({ contextUsedTokens: null }), tags, models)).toEqual([
      'keeps · ~/work/platform/auth-service',
      'keeps · default model · default mode',
    ])
  })
})

describe('carriesHarness', () => {
  const harness = (statuses: Array<'done' | 'active' | 'pending'>, removedAt: number | null = null) =>
    ({ removedAt, state: statuses.map((status) => ({ status })), steps: [] }) as unknown as SessionHarness

  it('follows the held harness once the phone has read it', () => {
    expect(carriesHarness(harness(['done', 'active']), null)).toBe(true)
    expect(carriesHarness(harness(['done', 'done']), { index: 0, total: 2 })).toBe(false)
    expect(carriesHarness(harness(['active'], 5), null)).toBe(false)
    expect(carriesHarness(null, { index: 0, total: 2 })).toBe(false)
  })

  it("reads the snapshot's step until then", () => {
    expect(carriesHarness(undefined, { index: 1, total: 3 })).toBe(true)
    expect(carriesHarness(undefined, { index: 3, total: 3 })).toBe(false)
    expect(carriesHarness(undefined, null)).toBe(false)
  })
})

describe('canSaveTitle', () => {
  it('needs a title with something in it, other than the current one', () => {
    expect(canSaveTitle('', 'auth-refactor')).toBe(false)
    expect(canSaveTitle('   ', 'auth-refactor')).toBe(false)
    expect(canSaveTitle('auth-refactor', 'auth-refactor')).toBe(false)
    expect(canSaveTitle(' auth-refactor ', 'auth-refactor')).toBe(false)
    expect(canSaveTitle('token rotation', 'auth-refactor')).toBe(true)
  })
})
