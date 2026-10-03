import { composerPlaceholderFor } from '../lib/decisionCard'
import { isMcpCommand } from '../lib/mcp'
import { openQuestion, type AnswerMap } from '../lib/questionCard'
import { isRewindCommand } from '../lib/rewind'
import type { PendingDecision } from '../lib/types'
import type { Toast } from '../store/store'

/**
 * The pure part of the session screen's footer (spec 2026-10-02-mobile-app-design
 * § 6.1, § 6.3; canvas 9b, 9c, 9p): which of its three forms it takes, and what
 * the composer's empty field says.
 */

/** The name the locked line uses when the pairing never learnt the Mac's. */
export const UNNAMED_MAC = 'Your Mac'

export type FooterMode = { kind: 'asleep'; macName: string } | { kind: 'terminal' } | { kind: 'composer' }

/**
 * The Mac asleep locks every session, whoever started it (9p "MAC OFFLINE ·
 * LOCKED"); a live terminal session has no composer on the phone (9p "TERMINAL
 * SESSION · NO COMPOSER"); everything else gets the composer.
 */
export function footerMode(input: { offline: boolean; macName: string | null; readOnly: boolean }): FooterMode {
  if (input.offline) return { kind: 'asleep', macName: input.macName ?? UNNAMED_MAC }
  if (input.readOnly) return { kind: 'terminal' }
  return { kind: 'composer' }
}

/**
 * The placeholder, and whether the well wears the answering accent. While a
 * decision is parked the composer is its escape hatch (§ 6.3) and says so; a
 * question whose every part is answered no longer is, so it falls through.
 */
export function composerPlaceholder(input: {
  pending: PendingDecision | undefined
  answers: AnswerMap | undefined
  ended: boolean
}): { text: string; answering: boolean } {
  const { pending } = input
  if (pending?.kind === 'question') {
    const open = openQuestion(pending.input.questions, input.answers ?? {})
    if (open) return { text: `Answer ${open.header}, or pick an option above…`, answering: true }
  } else if (pending) {
    return { text: composerPlaceholderFor(pending.kind), answering: true }
  }
  return { text: input.ended ? 'Continue conversation…' : 'Reply to Claude…', answering: false }
}

// The composer's error line (spec § 6.1). Copy provisional until the canvas words it.

/** What the line says when `/rewind` or `/mcp` is sent from the phone. */
export const DESKTOP_COMMAND_LINE = 'Needs the desktop app.'
/** A photo that failed for any reason but a cancel or a refused permission. */
export const PHOTO_FAILED_LINE = "Couldn't take that photo."

/**
 * Orbital's own commands, which open desktop UI the phone does not have
 * (rewind's pick mode, the MCP dialog). Sent raw, the Mac would refuse them.
 * `/compact` is not one: it goes to the Mac, as on the desktop.
 */
export function isDesktopCommand(text: string): boolean {
  return isRewindCommand(text) || isMcpCommand(text)
}

/** The route codes the phone can meet, in words; any other reads as its code. */
const ERROR_WORDS: Readonly<Record<string, string>> = {
  local_command: 'That command needs the desktop app.',
  terminal_session: 'This session is live in a terminal.',
}

/** A `TunnelError`'s message when the Mac could not be reached. */
const TUNNEL_DOWN = /^tunnel (lost|offline|timeout)$/

/**
 * An error as the phone shows it. A route's `ApiError` message is its JSON
 * body, `{ error: <code> }`; a dropped tunnel names the Mac; anything else is
 * shown as it came.
 */
export function humanizeError(message: string, macName: string | null): string {
  if (TUNNEL_DOWN.test(message.trim())) return `${macName ?? UNNAMED_MAC} is unreachable — try again.`
  let body: unknown
  try {
    body = JSON.parse(message)
  } catch {
    return message
  }
  const code = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  if (typeof code !== 'string' || !code) return message
  return ERROR_WORDS[code] ?? code.replace(/_/g, ' ')
}

/**
 * The message of a store toast the phone's composer line takes over: an
 * error a request of this client raised (a send, an answer, a verdict). A
 * record arriving on the errors topic (`source: 'log'`) is the Mac's, not a
 * failure of anything done here, and is left alone.
 */
export function phoneError(toast: Toast | null): string | null {
  return toast?.kind === 'error' && toast.source !== 'log' ? toast.message : null
}
