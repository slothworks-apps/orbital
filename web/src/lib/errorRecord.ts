import type { ErrorRecord } from './types'

/**
 * The whole record as one block of text, which is what a person pasting it
 * into an issue or a session actually wants — not the one line the row shows.
 */
export function formatRecordForCopy(error: ErrorRecord): string {
  const lines = [
    `[${new Date(error.at).toISOString()}] ${error.source} · ${error.kind}`,
    error.sessionId ? `session: ${error.sessionId}` : null,
    '',
    error.message,
  ]
  if (error.context) lines.push('', JSON.stringify(error.context, null, 2))
  if (error.detail) lines.push('', error.detail)
  return lines.filter((line) => line !== null).join('\n')
}

/** Claude's own words for a failure that is Claude's: the API, the plan, the account — never Orbital's. */
const CLAUDE_SIDE =
  /\bAPI Error\b|\boverloaded\b|rate[ _-]?limit|usage limit|\bcredit balance\b|\b(429|529)\b|invalid api key|please run \/login/i

/**
 * An error that came from Claude rather than from Orbital: a session or a
 * compaction that failed because the API was overloaded, a limit was hit or
 * the account is signed out. Reported to Orbital's GitHub it would reach
 * someone who cannot fix it, so the log does not offer Report on it.
 */
export function fromClaude(error: Pick<ErrorRecord, 'kind' | 'message' | 'detail'>): boolean {
  if (error.kind !== 'session_failed' && error.kind !== 'compaction_failed') return false
  return CLAUDE_SIDE.test(`${error.message}\n${error.detail ?? ''}`)
}
