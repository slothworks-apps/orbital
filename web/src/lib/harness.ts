/**
 * Harness helpers (spec: 2026-09-30-session-harness-design).
 */

import type { HarnessEvent, HarnessStep, StepState } from './types'
import type { StateTone } from './stateStyle'

/**
 * A step id from its title, unique among `taken`. Diacritics are folded
 * rather than dropped, so "Načíst design" is `nacist-design`, not `nast-design`.
 */
export function generateStepId(title: string, taken: readonly string[] = []): string {
  const base =
    title
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/[\s-]+/g, '-') || 'step'
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}

/** The header chip's reading: how far along, and whether a gate waits for the user. */
export function harnessProgress(state: readonly StepState[]): { done: number; total: number; awaiting: boolean } {
  return {
    done: state.filter((s) => s.status === 'done').length,
    total: state.length,
    awaiting: state.some((s) => s.status === 'awaiting_approval'),
  }
}

export function stepTone(status: StepState['status']): StateTone {
  switch (status) {
    case 'done':
      return 'done'
    case 'active':
      return 'active'
    case 'awaiting_approval':
      return 'input'
    default:
      return 'neutral'
  }
}

const EVENT_WORD: Record<HarnessEvent['kind'], string> = {
  attached: 'started',
  ticked: 'ticked',
  verify_failed: 'verify failed',
  advanced: 'sent on to',
  nudged: 'nudged on',
  watcher_stop: 'stopped for you',
  approved: 'you approved',
  reopened: 'you reopened',
  paused: 'paused',
  resumed: 'resumed',
  finished: 'finished',
  review_started: 'reviewer looking at',
  reviewed: 'reviewer decided',
  review_failed: 'reviewer could not decide',
  review_aborted: 'review stopped',
  options: 'options changed',
  went_back: 'went back to',
  removed: 'removed',
  carried_over: 'carried over',
}

/** One line of the panel's log: what happened, to which step, and why when the harness said. */
export function eventLine(event: HarnessEvent, steps: readonly HarnessStep[]): string {
  const stepId = typeof event.detail.step === 'string' ? event.detail.step : undefined
  const step = stepId ? steps.find((s) => s.id === stepId)?.title ?? stepId : undefined
  const reason = typeof event.detail.reason === 'string' ? event.detail.reason : undefined
  const verdict = event.kind === 'reviewed' && typeof event.detail.verdict === 'string'
    ? `: ${event.detail.verdict}${event.detail.uncertain === true ? ' (uncertain)' : ''}`
    : ''
  return [`${EVENT_WORD[event.kind] ?? event.kind}${verdict}`, step && `“${step}”`, reason && `— ${reason}`].filter(Boolean).join(' ')
}

/** The `N messages removed` count a rewind to `uuid` shows: the conversation rows from it on. */
export function rewindCountFor(messages: readonly { uuid?: string; role: string }[], uuid: string): number | null {
  const index = messages.findIndex((m) => m.uuid === uuid)
  if (index === -1) return null
  return messages.slice(index).filter((m) => m.role === 'user' || m.role === 'assistant').length
}
