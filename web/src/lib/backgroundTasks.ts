import type { BackgroundTask } from './types'

/**
 * The background task list's model (spec 2026-09-28-background-tasks-design
 * § 3, canvas 26a–26e): what the ▣ chip reads, how the dropdown groups its
 * rows, what one row and the output view say about how a task ended, and how
 * the output's text becomes lines. Pure — the clock arrives as `nowMs`, the
 * same way `lib/subagentList` takes it.
 */

/** 26e: the chip shows the oldest running task's age only past this — a fresh task is not news. */
export const TASK_AGE_SHOWN_AFTER_MS = 10 * 60 * 1000

/** 26b: the output view keeps this many lines; older ones drop off the top. */
export const OUTPUT_BUFFER_LINES = 5000

const isRunning = (task: BackgroundTask) => task.state === 'running'

/**
 * How a task reads, one of 26e's five dot tones. A shell that exited non-zero
 * failed whatever the SDK's status says — the CLI reports a finished command
 * as `completed` and leaves the verdict to its exit code. No status and no
 * exit code is `unknown`: it ended without anyone saying how (the CLI went
 * away, or Orbital restarted under it).
 */
export type TaskTone = 'running' | 'done' | 'failed' | 'stopped' | 'unknown'

export function taskTone(task: BackgroundTask): TaskTone {
  if (isRunning(task)) return 'running'
  if (task.status === 'stopped') return 'stopped'
  if (task.status === 'failed') return 'failed'
  if (task.exitCode !== undefined) return task.exitCode === 0 ? 'done' : 'failed'
  if (task.status === 'completed') return 'done'
  return 'unknown'
}

/** The row's word after its kind (26e): nothing while running, else how it ended — `exit N` for a failed command. */
export function rowWord(task: BackgroundTask): string {
  const tone = taskTone(task)
  if (tone === 'running') return ''
  if (tone === 'failed' && task.exitCode !== undefined && task.exitCode !== 0) return `exit ${task.exitCode}`
  return tone
}

/** The output view's state badge (26b): `DONE · EXIT 0`, `FAILED · EXIT 1`, `ENDED · UNKNOWN`. */
export function badgeText(task: BackgroundTask): string {
  const tone = taskTone(task)
  const exit = task.exitCode !== undefined ? ` · EXIT ${task.exitCode}` : ''
  switch (tone) {
    case 'running':
      return 'RUNNING'
    case 'done':
      return `DONE${exit}`
    case 'failed':
      return `FAILED${exit}`
    case 'stopped':
      return 'STOPPED'
    case 'unknown':
      return 'ENDED · UNKNOWN'
  }
}

/** The kind as a row names it (26e). */
export const kindWord = (task: BackgroundTask): string => (task.kind === 'mcp' ? 'MCP' : task.kind)

/** A task's elapsed ms: ticking against `nowMs` while it runs, frozen at `endedAt` after; `undefined` when it ended unstamped. */
export function taskElapsedMs(task: BackgroundTask, nowMs: number): number | undefined {
  if (isRunning(task)) return Math.max(0, nowMs - task.startedAt)
  if (task.endedAt === undefined) return undefined
  return Math.max(0, task.endedAt - task.startedAt)
}

/** Whether a row opens an output view: shells and monitors with a file. */
export const opensOutput = (task: BackgroundTask): boolean =>
  (task.kind === 'shell' || task.kind === 'monitor') && task.hasOutput

export interface TaskChipModel {
  running: number
  /** The oldest running task's age, once it passes `TASK_AGE_SHOWN_AFTER_MS`. */
  oldestAgeMs?: number
  ended: number
  failed: number
}

/** What the ▣ chip reads (26e); `null` for a session that never had a task — no chip at all. */
export function taskChipModel(tasks: readonly BackgroundTask[], nowMs: number): TaskChipModel | null {
  if (tasks.length === 0) return null
  const running = tasks.filter(isRunning)
  const ended = tasks.filter((task) => !isRunning(task))
  const oldest = running.reduce((max, task) => Math.max(max, nowMs - task.startedAt), 0)
  return {
    running: running.length,
    oldestAgeMs: running.length > 0 && oldest >= TASK_AGE_SHOWN_AFTER_MS ? oldest : undefined,
    ended: ended.length,
    failed: ended.filter((task) => taskTone(task) === 'failed').length,
  }
}

export type TaskGroup = { key: 'running' | 'ended'; heading: string; rows: BackgroundTask[] }

/**
 * The dropdown's groups: RUNNING, oldest first — the one that has been
 * running all day is the one to look at — then ENDED by `endedAt` newest
 * first, unstamped ones last. An empty group is omitted.
 */
export function taskGroups(tasks: readonly BackgroundTask[]): TaskGroup[] {
  const running = tasks.filter(isRunning).sort((a, b) => a.startedAt - b.startedAt)
  const ended = tasks
    .filter((task) => !isRunning(task))
    .sort((a, b) => {
      if (a.endedAt !== undefined && b.endedAt !== undefined) return b.endedAt - a.endedAt
      if (a.endedAt !== undefined) return -1
      if (b.endedAt !== undefined) return 1
      return b.startedAt - a.startedAt
    })
  const groups: TaskGroup[] = [
    { key: 'running', heading: `RUNNING · ${running.length}`, rows: running },
    { key: 'ended', heading: `ENDED · ${ended.length}`, rows: ended },
  ]
  return groups.filter((group) => group.rows.length > 0)
}

// CSI sequences (colour, cursor movement, erase) and the two-byte escapes
// around them. The output is plain text in practice; this is the safety net
// for a command that forces colour on (adr
// background-shell-output-is-not-forced-into-colour).
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g

/**
 * The output's text so far, as the view holds it: complete lines, and the
 * line still being written.
 */
export interface OutputLines {
  lines: string[]
  partial: string
}

export const EMPTY_OUTPUT: OutputLines = { lines: [], partial: '' }

/**
 * Appends a chunk of output. Escape sequences go, and a `\r` that is not
 * part of `\r\n` starts its line over, so a progress bar reads as its last
 * state. At most `limit` complete lines are kept, the newest.
 */
export function appendOutput(current: OutputLines, text: string, limit = OUTPUT_BUFFER_LINES): OutputLines {
  if (text === '') return current
  // Stripped after joining: a sequence cut in two by a read boundary sits
  // half in `partial`, where it could not match on its own.
  const pieces = (current.partial + text).replace(ANSI, '').split('\n')
  const partial = pieces.pop() ?? ''
  const lines = current.lines.concat(pieces.map(settleCarriageReturns))
  return { lines: lines.length > limit ? lines.slice(lines.length - limit) : lines, partial }
}

function settleCarriageReturns(line: string): string {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
  const cut = trimmed.lastIndexOf('\r')
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

const EXIT_LINE = /^\[exited with code -?\d+\]$/

/**
 * The lines to draw. The CLI closes a finished command's file with a blank
 * line and `[exited with code N]`; the view draws its own end line instead
 * (26b: "the one line Orbital adds"), so the CLI's is left out.
 */
export function displayLines(output: OutputLines): string[] {
  const lines = output.partial === '' ? output.lines : [...output.lines, settleCarriageReturns(output.partial)]
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end -= 1
  if (end > 0 && EXIT_LINE.test(lines[end - 1])) {
    end -= 1
    while (end > 0 && lines[end - 1] === '') end -= 1
  }
  return end === lines.length ? lines : lines.slice(0, end)
}

/**
 * A session's tasks after an upsert or a list read, which carry only the
 * running ones (the server's `listedBackgroundTasks`): ended tasks already
 * held here stay, so the history `GET /api/sessions/:id` filled in survives
 * every later upsert. An ended task never changes again, so the held copy is
 * still the truth.
 */
export function mergeListedTasks(held: BackgroundTask[] | undefined, next: BackgroundTask[] | undefined): BackgroundTask[] | undefined {
  if (!held?.length) return next
  const listed = new Set((next ?? []).map((t) => t.id))
  const kept = held.filter((t) => !isRunning(t) && !listed.has(t.id))
  if (kept.length === 0) return next
  return [...kept, ...(next ?? [])].sort((a, b) => a.startedAt - b.startedAt)
}

/** A task held as running that `next` no longer lists has ended, and how it ended is only in the detail. */
export function endedOutOfList(held: BackgroundTask[] | undefined, next: BackgroundTask[] | undefined): boolean {
  const listed = new Set((next ?? []).map((t) => t.id))
  return (held ?? []).some((t) => isRunning(t) && !listed.has(t.id))
}
