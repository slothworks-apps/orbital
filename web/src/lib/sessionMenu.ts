import { canTakeOver, type ApiSession } from './types'

/**
 * Which actions a session offers, wherever it is offered them: the phone's ⋯
 * sheet (spec 2026-10-05-mobile-next § 4; canvas 10i, 10j) and the desktop's
 * context menu on a planet or a sidebar row (spec
 * 2026-10-24-session-context-menu-design), which adds its own openings around
 * this set rather than keeping a second one.
 */

/** The sheet's rows, in the canvas's order: the reversible ones, a divider, the deliberate ones. */
export type MenuItem = 'rename' | 'tag' | 'pin' | 'takeover' | 'clear' | 'end'

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
 */
export function menuFor(
  session: Pick<ApiSession, 'source' | 'status' | 'firstAt'>,
  asleep: boolean,
  macTakesOver = false,
): MenuShape {
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
