import { describe, expect, it } from 'vitest'
import {
  EMPTY_OUTPUT,
  TASK_AGE_SHOWN_AFTER_MS,
  appendOutput,
  badgeText,
  displayLines,
  endedOutOfList,
  mergeListedTasks,
  rowWord,
  taskChipModel,
  taskGroups,
  taskTone,
} from '../lib/backgroundTasks'
import type { BackgroundTask } from '../lib/types'

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: over.id ?? 't',
  kind: 'shell',
  label: 'Run tests',
  state: 'ended',
  startedAt: 0,
  hasOutput: true,
  ...over,
})

describe('taskTone and rowWord', () => {
  it('lets a non-zero exit code fail a command the SDK called completed', () => {
    const failed = task({ status: 'completed', exitCode: 1 })
    expect(taskTone(failed)).toBe('failed')
    expect(rowWord(failed)).toBe('exit 1')
    expect(badgeText(failed)).toBe('FAILED · EXIT 1')
  })

  it('reads done for exit 0 and for a completed task with no exit code', () => {
    expect(rowWord(task({ status: 'completed', exitCode: 0 }))).toBe('done')
    expect(badgeText(task({ status: 'completed', exitCode: 0 }))).toBe('DONE · EXIT 0')
    expect(rowWord(task({ kind: 'workflow', status: 'completed' }))).toBe('done')
  })

  it('keeps stopped as stopped even with the exit code the kill left behind', () => {
    expect(rowWord(task({ status: 'stopped', exitCode: 143 }))).toBe('stopped')
  })

  it('says unknown for a task that ended without anyone saying how', () => {
    expect(rowWord(task())).toBe('unknown')
    expect(badgeText(task())).toBe('ENDED · UNKNOWN')
  })

  it('says failed for a failed workflow, which has no exit code', () => {
    expect(rowWord(task({ kind: 'workflow', status: 'failed' }))).toBe('failed')
  })
})

describe('taskChipModel', () => {
  const now = 10 * TASK_AGE_SHOWN_AFTER_MS

  it('is null for a session that never had a task', () => {
    expect(taskChipModel([], now)).toBeNull()
  })

  it('shows the oldest running age only once it is old enough', () => {
    const fresh = task({ state: 'running', startedAt: now - 1000 })
    expect(taskChipModel([fresh], now)?.oldestAgeMs).toBeUndefined()
    const old = task({ id: 'o', state: 'running', startedAt: now - 2 * TASK_AGE_SHOWN_AFTER_MS })
    expect(taskChipModel([fresh, old], now)).toMatchObject({ running: 2, oldestAgeMs: 2 * TASK_AGE_SHOWN_AFTER_MS })
  })

  it('counts failures among the ended', () => {
    const model = taskChipModel([task({ status: 'completed', exitCode: 2 }), task({ status: 'completed' })], now)
    expect(model).toMatchObject({ running: 0, ended: 2, failed: 1 })
  })
})

describe('taskGroups', () => {
  it('lists running oldest first, then ended newest first with unstamped last', () => {
    const groups = taskGroups([
      task({ id: 'r-new', state: 'running', startedAt: 5 }),
      task({ id: 'e-unstamped', startedAt: 9 }),
      task({ id: 'r-old', state: 'running', startedAt: 1 }),
      task({ id: 'e-old', endedAt: 3 }),
      task({ id: 'e-new', endedAt: 8 }),
    ])
    expect(groups.map((g) => [g.heading, g.rows.map((r) => r.id)])).toEqual([
      ['RUNNING · 2', ['r-old', 'r-new']],
      ['ENDED · 3', ['e-new', 'e-old', 'e-unstamped']],
    ])
  })
})

describe('appendOutput', () => {
  it('keeps the unfinished line apart until its newline arrives', () => {
    let out = appendOutput(EMPTY_OUTPUT, 'one\ntw')
    expect(out).toEqual({ lines: ['one'], partial: 'tw' })
    out = appendOutput(out, 'o\n')
    expect(out).toEqual({ lines: ['one', 'two'], partial: '' })
  })

  it('strips colour, even a sequence cut in two between chunks', () => {
    const out = appendOutput(appendOutput(EMPTY_OUTPUT, 'a \x1b[3'), '2mgreen\x1b[0m\n')
    expect(out.lines).toEqual(['a green'])
  })

  it('leaves a progress bar at its last state and treats \\r\\n as a newline', () => {
    const out = appendOutput(EMPTY_OUTPUT, '10%\r50%\r100%\ndone\r\n')
    expect(out.lines).toEqual(['100%', 'done'])
  })

  it('keeps only the newest lines past the limit', () => {
    const out = appendOutput(EMPTY_OUTPUT, 'a\nb\nc\nd\n', 2)
    expect(out.lines).toEqual(['c', 'd'])
  })
})

describe('displayLines', () => {
  it("leaves out the CLI's closing exit line and the blank before it", () => {
    const out = appendOutput(EMPTY_OUTPUT, 'Tests 3 passed\n\n[exited with code 0]\n')
    expect(displayLines(out)).toEqual(['Tests 3 passed'])
  })

  it('keeps an exit-looking line that is not the last one', () => {
    const out = appendOutput(EMPTY_OUTPUT, '[exited with code 0]\nmore\n')
    expect(displayLines(out)).toEqual(['[exited with code 0]', 'more'])
  })

  it('shows the line still being written', () => {
    expect(displayLines(appendOutput(EMPTY_OUTPUT, 'a\nloading'))).toEqual(['a', 'loading'])
  })
})

describe('mergeListedTasks', () => {
  it('keeps ended tasks the listed shape left out, in start order', () => {
    const held = [task({ id: 'a', startedAt: 1 }), task({ id: 'b', startedAt: 2 })]
    const next = [task({ id: 'b', startedAt: 2, label: 'fresh' }), task({ id: 'c', startedAt: 3, state: 'running' })]
    const merged = mergeListedTasks(held, next)
    expect(merged?.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(merged?.[1].label).toBe('fresh')
  })

  it('drops a held running task the next list no longer has', () => {
    const next = [task({ id: 'b' })]
    expect(mergeListedTasks([task({ id: 'a', state: 'running' })], next)).toBe(next)
  })

  it('passes next through when nothing is held', () => {
    const next = [task({ id: 'a' })]
    expect(mergeListedTasks(undefined, next)).toBe(next)
  })
})

describe('endedOutOfList', () => {
  it('is true when a held running task is missing from the listed ones', () => {
    expect(endedOutOfList([task({ id: 'a', state: 'running' })], [])).toBe(true)
  })

  it('is false when every held running task is still listed, or only ended ones are missing', () => {
    expect(endedOutOfList([task({ id: 'a', state: 'running' }), task({ id: 'b' })], [task({ id: 'a', state: 'running' })])).toBe(false)
  })
})
