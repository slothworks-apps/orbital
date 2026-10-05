import { describe, expect, it } from 'vitest'
import type { BackgroundTask, ChatMessage, Subagent } from '../lib/types'
import { asOfLabel } from '../mobile/format'
import {
  chipLabel,
  clockLabel,
  elapsedLabel,
  orderSubagents,
  orderTasks,
  subagentBody,
  subagentHeader,
  subagentStatus,
  taskStatus,
} from '../mobile/subagents/model'

// Local time, so the clock words read the same whatever the machine's zone.
const NOW = new Date(2026, 9, 5, 13, 41).getTime()
const AS_OF = new Date(2026, 9, 5, 13, 30).getTime()
const MIN = 60_000

const agent = (patch: Partial<Subagent> = {}): Subagent => ({
  id: 'a', name: 'tests', state: 'working', toolUseId: 'tu', startedAt: NOW - 2 * MIN, ...patch,
})

const task = (patch: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 't', kind: 'shell', label: 'npm run dev', state: 'running', startedAt: NOW - 3 * MIN, hasOutput: true, ...patch,
})

const msg = (patch: Partial<ChatMessage>): ChatMessage => ({ id: Math.random().toString(36), role: 'assistant', ...patch })

describe('elapsedLabel', () => {
  it('reads seconds, minutes and hours as the canvas writes them', () => {
    expect(elapsedLabel(48_000)).toBe('48s')
    expect(elapsedLabel(72_000)).toBe('1m 12s')
    expect(elapsedLabel(2 * MIN)).toBe('2m')
    expect(elapsedLabel(184 * MIN)).toBe('3h 04m')
  })

  it('drops the seconds of a running clock past a minute', () => {
    expect(elapsedLabel(133_000, true)).toBe('2m')
    expect(elapsedLabel(48_000, true)).toBe('48s')
  })
})

describe('chipLabel', () => {
  it('counts every subagent and the running tasks', () => {
    const tasks = [task({ id: '1' }), task({ id: '2', state: 'ended', exitCode: 1 })]
    expect(chipLabel([agent({ id: '1' }), agent({ id: '2' }), agent({ id: '3' })], tasks)).toBe('3 · ▣ 1')
  })

  it('counts every task once none runs, and is absent with neither', () => {
    expect(chipLabel([], [task({ state: 'ended' }), task({ id: '2', state: 'ended' })])).toBe('▣ 2')
    expect(chipLabel([agent()], [])).toBe('1')
    expect(chipLabel([], [])).toBeNull()
  })
})

describe('the sheet order', () => {
  it('puts running subagents first, oldest first, then ended ones newest first', () => {
    const ordered = orderSubagents([
      agent({ id: 'lint', state: 'ended', endedAt: NOW - 20 * MIN }),
      agent({ id: 'docs', startedAt: NOW - MIN }),
      agent({ id: 'old', state: 'ended', endedAt: NOW - 40 * MIN }),
      agent({ id: 'tests', startedAt: NOW - 5 * MIN }),
    ])
    expect(ordered.map((a) => a.id)).toEqual(['tests', 'docs', 'lint', 'old'])
  })

  it('puts running tasks before ended ones', () => {
    const ordered = orderTasks([
      task({ id: 'build', state: 'ended', exitCode: 1, endedAt: NOW - MIN }),
      task({ id: 'dev' }),
    ])
    expect(ordered.map((t) => t.id)).toEqual(['dev', 'build'])
  })
})

describe('row status', () => {
  it('says running with a ticking minute, done with how long it took', () => {
    expect(subagentStatus(agent(), NOW)).toMatchObject({ word: 'running', time: '2m' })
    const done = subagentStatus(agent({ state: 'ended', status: 'completed', endedAt: NOW - 2 * MIN + 14_000 }), NOW)
    expect(done).toMatchObject({ word: 'done', time: '14s' })
    expect(done.ink).toBeDefined()
  })

  it('names a task by its exit code, dated by when it ended', () => {
    const endedAt = new Date(2026, 9, 5, 12, 58).getTime()
    const failed = taskStatus(task({ state: 'ended', exitCode: 1, endedAt }), NOW)
    expect(failed).toMatchObject({ kind: 'shell', word: 'exited with code 1' })
    expect(failed.time).toBe(clockLabel(endedAt))
    expect(taskStatus(task({ state: 'ended', status: 'stopped' }), NOW)).toMatchObject({ word: 'stopped' })
  })
})

describe('subagentHeader', () => {
  const header = (a: Subagent, opts: { found?: boolean; offline?: boolean } = {}) =>
    subagentHeader({ agent: a, found: opts.found ?? true, messages: [], offline: opts.offline ?? false, asOf: AS_OF, now: NOW })

  it('runs with a pulse and no end line', () => {
    expect(header(agent())).toMatchObject({ word: 'RUNNING · 2m', pulse: true, end: null })
  })

  it('is done, still, with when it ended and the end of the subagent', () => {
    const endedAt = new Date(2026, 9, 5, 13, 22).getTime()
    const done = header(agent({ state: 'ended', status: 'completed', startedAt: endedAt - 14_000, endedAt }))
    expect(done).toMatchObject({ word: 'DONE · 14s', pulse: false, end: { text: 'END OF SUBAGENT', divider: true } })
    expect(done.ended).toBe(`ended ${clockLabel(endedAt)}`)
  })

  it('says the stream is lost whatever the moon still claims', () => {
    expect(header(agent(), { found: false })).toMatchObject({ word: 'STREAM LOST', pulse: false })
  })

  it('was running as of the last sync while the Mac sleeps, and stops moving', () => {
    const asleep = header(agent(), { offline: true })
    expect(asleep.word).toBe(`WAS RUNNING · ${asOfLabel(AS_OF, NOW).toUpperCase()}`)
    expect(asleep).toMatchObject({ pulse: false, end: { text: 'nothing newer · Mac asleep' } })
  })

  it('keeps a finished agent as it was while the Mac sleeps', () => {
    const done = agent({ state: 'ended', status: 'completed', endedAt: NOW - MIN })
    expect(header(done, { offline: true }).word).toBe(header(done).word)
  })
})

describe('subagentBody', () => {
  it('takes the leading prompt as the task and the last words as the result once ended', () => {
    const messages = [
      msg({ role: 'user', text: 'Lint src/auth.' }),
      msg({ role: 'tool_use', toolName: 'Bash' }),
      msg({ role: 'assistant', text: 'Fixed 7 issues.' }),
    ]
    const body = subagentBody(messages, [], 'tu', true)
    expect(body.task).toBe('Lint src/auth.')
    expect(body.result).toBe('Fixed 7 issues.')
    expect(body.rows.map((m) => m.role)).toEqual(['tool_use'])
  })

  it('leaves the last words among the rows while it runs', () => {
    const body = subagentBody([msg({ role: 'user', text: 'Go' }), msg({ text: 'Working on it' })], [], 'tu', false)
    expect(body.result).toBeNull()
    expect(body.rows).toHaveLength(1)
  })

  it("reads the task off the parent's launching call when the page no longer reaches the prompt", () => {
    const parent = [msg({ role: 'tool_use', toolUseId: 'tu', toolName: 'Agent', toolInput: { prompt: 'Run the auth tests' } })]
    expect(subagentBody([msg({ text: 'step' })], parent, 'tu', false).task).toBe('Run the auth tests')
    expect(subagentBody([msg({ text: 'step' })], parent, 'other', false).task).toBeNull()
  })
})
