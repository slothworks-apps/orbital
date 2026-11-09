import { canTakeOver, setupStateKey, type ApiSession } from './types'

/**
 * Which actions a session offers, wherever it is offered them: the phone's ⋯
 * sheet (spec 2026-10-05-mobile-next § 4; canvas 10i, 10j) and the desktop's
 * context menu on a planet or a sidebar row (spec
 * 2026-10-24-session-context-menu-design), which adds its own openings around
 * this set rather than keeping a second one.
 */

/**
 * The sheet's rows, in the canvas's order: the reversible ones, a divider,
 * the deliberate ones. `retry` to `error-log` and `discard` are a worktree
 * launch's that has not started (canvas 66d).
 */
export type MenuItem =
  | 'rename'
  | 'tag'
  | 'pin'
  | 'retry'
  | 'without-worktree'
  | 'copy-prompt'
  | 'error-log'
  | 'takeover'
  | 'clear'
  | 'end'
  | 'discard'

/** The deliberate rows, under the divider. */
export const DELIBERATE_ITEMS: ReadonlySet<MenuItem> = new Set(['takeover', 'clear', 'end', 'discard'])

export interface MenuShape {
  items: MenuItem[]
  /** A terminal session's one line on where End and Clear live instead (10j TERMINAL). */
  terminalNote: boolean
  /** The Mac sleeps: every item waits for it, drawn but inert (10j MAC ASLEEP). */
  inert: boolean
}

/**
 * Rename, tag and pin are Orbital's own labels, so every session has them.
 * Clear and End act on the session itself: a terminal session never gets
 * either, ended or not (spec § 0); End is gone once the session has ended.
 * A terminal still running it gets Take over instead, when its Mac serves it
 * (spec 2026-10-21-take-over-terminal-session-design § The phone).
 * Asleep keeps the set and makes it inert, so the sheet still shows what it
 * would offer.
 *
 * A worktree launch that has not started has nothing to clear or end:
 * discarding it is its one deliberate row (spec
 * 2026-11-09-worktree-setup-in-background-design § Discard). While it is set
 * up, its labels work at once; once it failed, the ways out come first and
 * its labels wait for a session that runs (canvas 66d).
 */
export function menuFor(
  session: Pick<ApiSession, 'source' | 'status' | 'firstAt' | 'setup'>,
  asleep: boolean,
  macTakesOver = false,
): MenuShape {
  const setup = setupStateKey(session)
  if (setup === 'setting_up') return { items: ['rename', 'tag', 'pin', 'copy-prompt', 'discard'], terminalNote: false, inert: asleep }
  if (setup === 'not_started') {
    return { items: ['retry', 'without-worktree', 'copy-prompt', 'error-log', 'pin', 'discard'], terminalNote: false, inert: asleep }
  }
  const items: MenuItem[] = ['rename', 'tag', 'pin']
  const terminal = session.source === 'terminal'
  if (!terminal) {
    items.push('clear')
    if (session.status !== 'ended') items.push('end')
  } else if (macTakesOver && canTakeOver(session)) {
    items.push('takeover')
  }
  return { items, terminalNote: terminal, inert: asleep }
}
