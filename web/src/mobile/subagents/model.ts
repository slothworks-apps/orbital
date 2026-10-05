import { kindWord, opensOutput, taskElapsedMs, taskGroups, taskTone } from '../../lib/backgroundTasks'
import { elapsedMsFor, taskStateFor, withoutLeadingUserFrame } from '../../lib/subagentPanel'
import type { BackgroundTask, ChatMessage, Subagent } from '../../lib/types'
import { asOfLabel, clockLabel } from '../format'

/**
 * What the phone says about a session's subagents and background tasks (spec
 * 2026-10-05-mobile-next § 3; canvas 10a moons rows, 10f, 10h): the header
 * chip, the sheet's order and rows, and the subagent screen's header and
 * body. Pure — the clock arrives as `now`. The task output screen's own
 * words live in `tasks.ts`.
 */

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS

/** Canvas 10f, 10g, 10h inks. */
export const INK = {
  /** RUNNING and its pulsing dot. */
  running: '#59e4f3',
  /** WAS RUNNING while the Mac sleeps (10h). */
  runningAsleep: 'rgba(89,228,243,.7)',
  /** DONE, EXITED · CODE 0. */
  done: '#7fe3b0',
  /** A real failure: exit code ≠ 0 (spec § 0). */
  failed: '#fa8880',
  /** A stop, an unknown end, a lost stream — never a failure (10h `N`). */
  neutral: 'rgba(200,215,235,.8)',
  /** The end line of what is no longer there (10h `M`). */
  muted: 'rgba(160,190,225,.6)',
  /** "stopped by you after …" (10g). */
  stoppedByYou: 'rgba(200,220,245,.8)',
  /** The paused pill and a pressable path (10g, 10h). */
  accent: 'oklch(85% .12 205)',
} as const

/**
 * An elapsed reading as 10f–10h write it: "48s", "2m", "1m 12s", "3h 04m".
 * A running clock drops the seconds past a minute, so it does not tick every
 * second for a reader who only needs the minute; a frozen one keeps them.
 */
export function elapsedLabel(ms: number, running = false): string {
  const total = Math.max(0, Math.floor(ms / SECOND_MS))
  if (total < 60) return `${total}s`
  if (ms < HOUR_MS) {
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return running || seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
  }
  const minutes = Math.floor(ms / MINUTE_MS)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** The end lines' "13:22" is the phone's one clock (`format.ts`). */
export { clockLabel }

const subagentRunning = (agent: Subagent) => agent.state !== 'ended'
const taskRunning = (task: BackgroundTask) => task.state === 'running'

/** A moon opens its transcript only with a `toolUseId` to join it on (spec § 3). */
export const opensSubagent = (agent: Subagent): boolean => agent.toolUseId !== undefined

/** A task opens its output only when it has one: shells and monitors with a file. */
export const opensTask = opensOutput

/**
 * The 9b header chip (canvas 10f): "3 · ▣ 1" — every subagent, then the
 * running tasks, or every task once none runs. Null when the session has
 * neither: no chip.
 */
export function chipLabel(subagents: readonly Subagent[], tasks: readonly BackgroundTask[]): string | null {
  const parts: string[] = []
  if (subagents.length > 0) parts.push(String(subagents.length))
  if (tasks.length > 0) {
    const running = tasks.filter(taskRunning).length
    parts.push(`▣ ${running > 0 ? running : tasks.length}`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * The sheet's subagents (canvas 10f): RUNNING before ended. Running ones
 * oldest first, ended ones by when they ended, newest first — the order
 * `taskGroups` gives tasks, so the two lists read alike.
 */
export function orderSubagents(subagents: readonly Subagent[]): Subagent[] {
  const running = subagents.filter(subagentRunning).sort((a, b) => a.startedAt - b.startedAt)
  const ended = subagents
    .filter((agent) => !subagentRunning(agent))
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  return [...running, ...ended]
}

/** The sheet's tasks: `taskGroups`' RUNNING then ENDED, as one list. */
export function orderTasks(tasks: readonly BackgroundTask[]): BackgroundTask[] {
  return taskGroups(tasks).flatMap((group) => group.rows)
}

/** Canvas 10f's group headings: "SUBAGENTS · 3 · 2 RUNNING", "BACKGROUND TASKS · 1 RUNNING". */
export function subagentsHeading(subagents: readonly Subagent[]): string {
  const running = subagents.filter(subagentRunning).length
  return `SUBAGENTS · ${subagents.length}${running > 0 ? ` · ${running} RUNNING` : ''}`
}

export function tasksHeading(tasks: readonly BackgroundTask[]): string {
  const running = tasks.filter(taskRunning).length
  return running > 0 ? `BACKGROUND TASKS · ${running} RUNNING` : `BACKGROUND TASKS · ${tasks.length} ENDED`
}

/** A row's status after its name (10a, 10f): the word, its own ink when it has one, and the time. */
export interface RowStatus {
  word: string
  /** The word's ink; undefined keeps the row's own. */
  ink?: string
  /** "2m", "14s", "12:58"; undefined when there is no moment to give. */
  time?: string
}

/**
 * A subagent row (canvas 10f: "running · 2m", "done · 14s"). No model — the
 * moon does not carry one (spec Decision 2); the subagent screen names it
 * once its messages arrive.
 */
export function subagentStatus(agent: Subagent, now: number): RowStatus {
  const state = taskStateFor(agent, true)
  const elapsed = elapsedMsFor(agent, [], now)
  const time = elapsed === undefined ? undefined : elapsedLabel(elapsed, state === 'running')
  switch (state) {
    case 'running':
      return { word: 'running', time }
    case 'completed':
      return { word: 'done', ink: INK.done, time }
    case 'failed':
      return { word: 'failed', ink: INK.failed, time }
    default:
      return { word: 'stopped', time }
  }
}

/**
 * A task row (canvas 10f, 10a): "shell · running · 3h 04m", "shell · exited
 * with code 1 · 12:58". An ended one is dated by when it ended.
 */
export function taskStatus(task: BackgroundTask, now: number): RowStatus & { kind: string } {
  const kind = kindWord(task)
  const tone = taskTone(task)
  if (tone === 'running') {
    const elapsed = taskElapsedMs(task, now)
    return { kind, word: 'running', time: elapsed === undefined ? undefined : elapsedLabel(elapsed, true) }
  }
  const time = task.endedAt === undefined ? undefined : clockLabel(task.endedAt)
  if (task.exitCode !== undefined) {
    return { kind, word: `exited with code ${task.exitCode}`, ink: task.exitCode === 0 ? INK.done : INK.failed, time }
  }
  switch (tone) {
    case 'done':
      return { kind, word: 'done', ink: INK.done, time }
    case 'failed':
      return { kind, word: 'failed', ink: INK.failed, time }
    case 'stopped':
      return { kind, word: 'stopped', time }
    default:
      return { kind, word: 'ended', time }
  }
}

/** The subagent screen's state row (canvas 10f, 10h). */
export interface SubagentHeader {
  word: string
  ink: string
  /** The dot before the word: pulsing while it runs live, absent otherwise. */
  pulse: boolean
  /** "ended 13:22" after a finished agent's word. */
  ended?: string
  /** What closes the body: END OF SUBAGENT, the asleep divider, a lost stream's line. */
  end: { text: string; ink: string; divider: boolean } | null
}

export interface SubagentHeaderInput {
  agent: Subagent
  /** False once the Mac answered 404: it no longer holds the agent's buffer. */
  found: boolean
  messages: readonly ChatMessage[]
  offline: boolean
  asOf: number | null
  now: number
}

/**
 * The header state per subagent state (canvas 10f, 10h; the task states of
 * `taskStateFor`). Asleep, only a running agent changes: the data stops
 * where the last sync left it, so it WAS running as of then; a finished one
 * is a fact that does not age.
 */
export function subagentHeader({ agent, found, messages, offline, asOf, now }: SubagentHeaderInput): SubagentHeader {
  const state = taskStateFor(agent, found)
  if (state === 'stream_lost') {
    return {
      word: 'STREAM LOST', ink: INK.neutral, pulse: false,
      end: { text: 'transcript no longer available', ink: INK.muted, divider: false },
    }
  }
  if (state === 'running') {
    if (offline) {
      const word = asOf === null ? 'WAS RUNNING' : `WAS RUNNING · ${asOfLabel(asOf, now).toUpperCase()}`
      return { word, ink: INK.runningAsleep, pulse: false, end: { text: 'nothing newer · Mac asleep', ink: INK.muted, divider: true } }
    }
    const elapsed = elapsedMsFor(agent, messages, now)
    return {
      word: elapsed === undefined ? 'RUNNING' : `RUNNING · ${elapsedLabel(elapsed, true)}`,
      ink: INK.running, pulse: true, end: null,
    }
  }
  const elapsed = elapsedMsFor(agent, messages, now)
  const took = elapsed === undefined ? '' : ` · ${elapsedLabel(elapsed)}`
  const ended = agent.endedAt === undefined ? undefined : `ended ${clockLabel(agent.endedAt)}`
  const end = { text: 'END OF SUBAGENT', ink: INK.muted, divider: true }
  if (state === 'completed') return { word: `DONE${took}`, ink: INK.done, pulse: false, ended, end }
  if (state === 'failed') return { word: `FAILED${took}`, ink: INK.failed, pulse: false, ended, end }
  return { word: `STOPPED${took}`, ink: INK.neutral, pulse: false, ended, end }
}

/** The subagent screen's body, split the way canvas 10f draws it. */
export interface SubagentBody {
  /** TASK FROM <parent>: the prompt the parent gave it; null when neither source holds it. */
  task: string | null
  /** The rows between the task and the result. */
  rows: ChatMessage[]
  /** RESULT · RETURNED TO <parent>: the agent's last words once it finished; null while it runs. */
  result: string | null
}

/**
 * Splits a subagent's messages into 10f's TASK FROM, rows and RESULT. The
 * task is its leading user frame; when the phone's page (`PHONE_SUBAGENT_PAGE`)
 * no longer reaches back to it, the parent's launching call's `prompt`
 * stands in. Once the agent has ended, its last assistant text is the
 * result it returned and leaves the rows, so it is not shown twice.
 */
export function subagentBody(
  messages: ChatMessage[],
  parentMessages: readonly ChatMessage[],
  toolUseId: string | undefined,
  ended: boolean,
): SubagentBody {
  const lead = messages[0]?.role === 'user' ? (messages[0].text ?? null) : null
  const task = lead ?? launchPrompt(parentMessages, toolUseId)
  const rows = withoutLeadingUserFrame(messages)
  if (!ended) return { task, rows, result: null }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]
    if (row.role !== 'assistant') continue
    if (!row.text?.trim()) continue
    return { task, rows: [...rows.slice(0, i), ...rows.slice(i + 1)], result: row.text }
  }
  return { task, rows, result: null }
}

function launchPrompt(parentMessages: readonly ChatMessage[], toolUseId: string | undefined): string | null {
  if (!toolUseId) return null
  const call = parentMessages.find((m) => m.role === 'tool_use' && m.toolUseId === toolUseId)
  const input = call?.toolInput as { prompt?: unknown } | undefined
  return typeof input?.prompt === 'string' ? input.prompt : null
}
