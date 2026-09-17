export type SessionSource = 'terminal' | 'web';
export type SessionStatus = 'working' | 'needs_input' | 'idle' | 'ended';
/** Ordered by escalating autonomy. Mirrored in `web/src/lib/types.ts` — this
 * repo has no shared types package, so the two must move together. The SDK
 * also ships `default` and `dontAsk`; Orbital offers neither, see
 * `docs/superpowers/specs/2026-09-17-permission-mode-dots-design.md`. */
export type PermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions';
export type SubagentState = 'materializing' | 'working' | 'idle' | 'needs_input' | 'ended';

export interface SessionRow {
  id: string;
  project_dir: string;
  cwd: string;
  title: string;
  first_at: number | null;
  last_at: number | null;
  message_count: number;
  file_size: number;
  source: SessionSource;
  permission_mode: PermissionMode | null;
  model: string | null;
  resolved_model: string | null;
  parent_id: string | null;
  indexed_mtime: number;
  indexed_size: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  timestamp?: string;
  /** Resolved model that produced this assistant message. Absent on user turns. */
  model?: string;
}

export interface TagRule {
  id: number;
  tag_id: number;
  position: number;
  enabled: 0 | 1;
  condition: 'path_matches' | 'title_contains' | 'permission_is';
  pattern: string;
}

/**
 * Where an error was caught. `web` rows arrive through `POST /api/errors` —
 * the browser's own failures are recorded in the same table as the server's,
 * so there is one list to read rather than two.
 *
 * Mirrored in `web/src/lib/types.ts`; this repo has no shared types package,
 * so the two must move together. See
 * `docs/superpowers/specs/2026-09-17-error-surface-design.md`.
 */
export type ErrorSource = 'server' | 'web';

/** What kind of thing failed. A short machine label, not a message. */
export type ErrorKind = 'session_failed' | 'api_request' | 'render_crash';

export interface ErrorRecord {
  id: number;
  /** Epoch ms. */
  at: number;
  source: ErrorSource;
  kind: ErrorKind;
  /** Set when the error belongs to one session, null otherwise. */
  sessionId: string | null;
  /** The one line a toast can show. */
  message: string;
  /** The long form — a stack, a `componentStack`, a response body. */
  detail: string | null;
  /** Anything else worth keeping: `cwd`, `permissionMode`, `model`, request URL, HTTP status. */
  context: Record<string, unknown> | null;
  /** When the error list showed this row. Null until then. */
  seenAt: number | null;
}
