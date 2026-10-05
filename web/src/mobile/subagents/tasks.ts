import { taskElapsedMs, taskTone } from '../../lib/backgroundTasks'
import type { BackgroundTask } from '../../lib/types'
import { asOfLabel } from '../format'
import { INK, clockLabel, elapsedLabel } from './model'

/**
 * What the task output screen says (spec 2026-10-05-mobile-next § 3; canvas
 * 10g, 10h `tStates`): the state word, the end line under the output,
 * whether Stop is offered, the follow pill, and the count of lines that
 * arrived while the reader was scrolled up. Pure — the clock arrives as `now`.
 */

export interface TaskViewInput {
  task: BackgroundTask
  /** The store's read of the output: `gone` once the Mac answered 404 or 410. */
  phase: 'loading' | 'ready' | 'gone'
  /** This phone sent the stop that ended it, in this run (spec Decision 3). */
  stoppedHere: boolean
  offline: boolean
  /** A terminal session's task is read, never stopped (spec § 0). */
  readOnly: boolean
  asOf: number | null
  now: number
}

export interface TaskView {
  word: string
  ink: string
  /** The dot before the word: a running task's pulse; none once it ended or the Mac sleeps. */
  dot: 'pulse' | 'still' | null
  /** "after 1m 12s · 12:58" beside an ended task's word. */
  after?: string
  /** The line that closes the output, if anything closes it. */
  end: { text: string; ink: string } | null
  /** Stop is offered: only on a running task the phone may stop now. */
  canStop: boolean
  /** The cursor blinks after the last line: running, live, output in hand. */
  cursor: boolean
  /** Whether the footer's follow pill applies — only while output can still grow. */
  live: boolean
}

export function taskView({ task, phase, stoppedHere, offline, readOnly, asOf, now }: TaskViewInput): TaskView {
  const elapsed = taskElapsedMs(task, now)
  const running = task.state === 'running'

  if (phase === 'gone') {
    // 10h OUTPUT GONE: the header and its facts stay, the bytes do not.
    return {
      word: 'ENDED BEFORE THE RESTART', ink: INK.neutral, dot: null,
      end: { text: 'output no longer available', ink: INK.muted },
      canStop: false, cursor: false, live: false,
    }
  }

  if (running) {
    if (offline) {
      // 10h MAC ASLEEP: last lines kept, no cursor, no Stop.
      const word = asOf === null ? 'WAS RUNNING' : `WAS RUNNING · ${asOfLabel(asOf, now).toUpperCase()}`
      return {
        word, ink: INK.runningAsleep, dot: 'still',
        end: { text: 'nothing newer · Mac asleep', ink: INK.muted },
        canStop: false, cursor: false, live: false,
      }
    }
    return {
      word: elapsed === undefined ? 'RUNNING' : `RUNNING · ${elapsedLabel(elapsed, true)}`,
      ink: INK.running, dot: 'pulse', end: null,
      canStop: !readOnly, cursor: phase === 'ready', live: true,
    }
  }

  const took = elapsed === undefined ? undefined : elapsedLabel(elapsed)
  const at = task.endedAt === undefined ? undefined : clockLabel(task.endedAt)
  const after = [took && `after ${took}`, at].filter(Boolean).join(' · ') || undefined
  const ended = { dot: null, canStop: false, cursor: false, live: false } as const
  const tone = taskTone(task)

  if (tone === 'stopped') {
    // 10g: who stopped it, when the phone knows; a stop is never a failure.
    if (stoppedHere) {
      return {
        ...ended, word: took ? `STOPPED BY YOU · ${took}` : 'STOPPED BY YOU', ink: INK.neutral,
        end: { text: `stopped by you${took ? ` after ${took}` : ''} · output frozen`, ink: INK.stoppedByYou },
      }
    }
    return {
      ...ended, word: took ? `STOPPED · ${took}` : 'STOPPED', ink: INK.neutral,
      end: { text: took ? `stopped after ${took}` : 'stopped', ink: INK.neutral },
    }
  }
  if (task.exitCode !== undefined) {
    // 10g, 10h: mint for 0, coral for anything else — a real failure.
    const ok = task.exitCode === 0
    return {
      ...ended, word: `EXITED · CODE ${task.exitCode}`, ink: ok ? INK.done : INK.failed, after,
      end: { text: ok ? 'exited with code 0' : `exited with code ${task.exitCode} · output frozen`, ink: ok ? INK.done : INK.failed },
    }
  }
  if (tone === 'done') return { ...ended, word: 'DONE', ink: INK.done, after, end: { text: 'done · output frozen', ink: INK.done } }
  if (tone === 'failed') return { ...ended, word: 'FAILED', ink: INK.failed, after, end: { text: 'failed · output frozen', ink: INK.failed } }
  // Ended without anyone saying how (`taskTone`'s unknown).
  return { ...ended, word: 'ENDED', ink: INK.neutral, after, end: { text: 'ended · output frozen', ink: INK.neutral } }
}

/** The footer's pill (canvas 10g, 10h): following, or paused with what arrived since. */
export function followPill(newLines: number | null): string {
  if (newLines === null) return 'following ↓'
  return `paused · ${newLines.toLocaleString('en-US')} new ${newLines === 1 ? 'line' : 'lines'} · ↓ live`
}

/**
 * How many complete lines `next` holds that `prev` did not — what a paused
 * reader is told about without being shown. The store keeps only the newest
 * lines, so `next` may have lost some from the front as it grew at the end:
 * the answer is the smallest shift that lines the two up, with `prev`'s
 * surviving tail as `next`'s head. When nothing lines up (the output was
 * read again from a fresh tail), every line of `next` counts.
 */
export function appendedLines(prev: readonly string[], next: readonly string[]): number {
  if (prev === next) return 0
  if (prev.length === 0) return next.length
  for (let dropped = 0; dropped < prev.length; dropped += 1) {
    const kept = prev.length - dropped
    if (kept > next.length) continue
    if (next[0] !== prev[dropped] || next[kept - 1] !== prev[prev.length - 1]) continue
    let aligned = true
    for (let i = 1; i < kept - 1; i += 1) {
      if (next[i] !== prev[dropped + i]) {
        aligned = false
        break
      }
    }
    if (aligned) return next.length - kept
  }
  return next.length
}
