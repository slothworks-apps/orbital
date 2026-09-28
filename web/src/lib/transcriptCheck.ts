import type { ChatMessage } from './types'

/**
 * The transcript check (spec 2026-09-28-transcript-check-design): while a
 * session's transcript is on screen, the client periodically reads the tail
 * of its transcript file and asks whether the panel holds the file's last
 * message. The panel is fed live over `session:<id>`; the file is what ⌘R
 * rebuilds from. When the two disagree for longer than the live path could
 * explain, the panel is reloaded from the file.
 */

/** How often the check runs for an open transcript. */
export const TRANSCRIPT_CHECK_MS = 5_000

/** How much of the file's tail one check reads — enough to reach its last comparable row. */
export const TRANSCRIPT_CHECK_PAGE = 20

/**
 * Roles the live path and the file shape the same way — checked against 25
 * real transcripts, every row of these three matched. A row the two paths
 * disagree on would reload the panel on every check, so the rest stay out:
 * a user turn is the optimistic bubble on the live side, which a slash
 * command or an image-only turn never matches in the file, and thinking and
 * notices are the CLI's own shaping. What goes missing is the agent's output
 * anyway; the user's own turn is on screen the moment it is sent.
 */
const COMPARABLE_ROLES = new Set<ChatMessage['role']>(['assistant', 'tool_use', 'tool_result'])

/**
 * Whether `held` already shows `message`. Ids alone cannot say: a live row
 * carries the runner's id and the file's copy of it a transcript uuid, so the
 * match falls back to what both copies share — the tool call's id for tool
 * rows, the role and trimmed text for the rest. A partial row does not count:
 * a block still streaming (or stuck streaming) does not hold the finished one.
 */
export function holdsMessage(held: readonly ChatMessage[], message: ChatMessage): boolean {
  return held.some((row) => {
    if (row.id === message.id) return !row.partial
    if (row.partial || row.role !== message.role) return false
    if (message.role === 'tool_use' || message.role === 'tool_result') {
      return message.toolUseId !== undefined && row.toolUseId === message.toolUseId
    }
    return (row.text ?? '').trim() === (message.text ?? '').trim()
  })
}

/** The file's newest row the panel can be held to, if any. */
function lastComparable(fileTail: readonly ChatMessage[]): ChatMessage | null {
  for (let i = fileTail.length - 1; i >= 0; i--) {
    if (COMPARABLE_ROLES.has(fileTail[i].role)) return fileTail[i]
  }
  return null
}

/**
 * One check. `suspect` is what the previous check found missing, if anything.
 *
 * A single miss is not a gap: the CLI can write a row to the file a moment
 * before the same row reaches the socket. So a miss is only remembered, and
 * the panel is reloaded when the row remembered LAST time is still not held
 * — whatever the file's tail says now, because a busy session moves its tail
 * on every check and would otherwise never be caught.
 */
export function transcriptCheckStep(
  held: readonly ChatMessage[],
  fileTail: readonly ChatMessage[],
  suspect: ChatMessage | null
): { reload: boolean; suspect: ChatMessage | null } {
  if (suspect && !holdsMessage(held, suspect)) return { reload: true, suspect: null }
  const last = lastComparable(fileTail)
  if (last && !holdsMessage(held, last)) return { reload: false, suspect: last }
  return { reload: false, suspect: null }
}
