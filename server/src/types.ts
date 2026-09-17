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
