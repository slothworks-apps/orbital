/**
 * A terminal as the server lists it (`server/src/terminal/store.ts` has the
 * same type; the workspaces do not import each other). `label` is the tab's
 * name before the window numbers equal ones (`tabLabels`).
 */
export interface TerminalInfo {
  id: string
  sessionId: string
  cwd: string
  createdAt: number
  /** null while the shell runs. */
  exitCode: number | null
  /** When the shell ended, from a server that reports it. */
  exitedAt?: number | null
  label: string
  /** Something other than the shell holds the foreground. */
  busy: boolean
}

/** What the server sends on a terminal's socket besides output, as JSON text. */
export type TerminalControl =
  | { type: 'exit'; exitCode: number }
  | { type: 'status'; label: string; busy: boolean }
  | { type: 'restart' }

/** The socket's close code for a terminal the server does not know. */
export const TERMINAL_GONE_CLOSE_CODE = 4404

/** A text frame from the terminal's socket, or null for anything else. */
export function parseTerminalControl(text: string): TerminalControl | null {
  let msg: unknown
  try {
    msg = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof msg !== 'object' || msg === null) return null
  const m = msg as Record<string, unknown>
  if (m.type === 'exit' && typeof m.exitCode === 'number') return { type: 'exit', exitCode: m.exitCode }
  if (m.type === 'status' && typeof m.label === 'string' && typeof m.busy === 'boolean') {
    return { type: 'status', label: m.label, busy: m.busy }
  }
  if (m.type === 'restart') return { type: 'restart' }
  return null
}
