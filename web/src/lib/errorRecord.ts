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
