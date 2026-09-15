export type SessionSource = 'terminal' | 'web';
export type SessionStatus = 'working' | 'needs_input' | 'idle' | 'ended';
export type PermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions';
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
}

export interface TagRule {
  id: number;
  tag_id: number;
  position: number;
  enabled: 0 | 1;
  condition: 'path_matches' | 'title_contains' | 'permission_is';
  pattern: string;
}
