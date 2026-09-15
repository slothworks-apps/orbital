export type SessionStatus = 'working' | 'needs_input' | 'idle' | 'ended';
export type SessionSource = 'terminal' | 'web';
export type PermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions';

export interface ApiSession {
  id: string;
  cwd: string;
  title: string;
  firstAt: number | null;
  lastAt: number | null;
  messageCount: number;
  source: SessionSource;
  permissionMode: PermissionMode | null;
  parentId: string | null;
  tagIds: number[];
  status: SessionStatus;
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

export interface Tag {
  id: number;
  name: string;
  hue: number;
  is_default: 0 | 1;
}

export interface TagRule {
  id: number;
  tag_id: number;
  position: number;
  enabled: 0 | 1;
  condition: 'path_matches' | 'title_contains' | 'permission_is';
  pattern: string;
}

export interface Subagent {
  id: string;
  name: string;
  state: 'materializing' | 'working' | 'idle' | 'needs_input' | 'ended';
}

export const tagColor = (hue: number) => `oklch(80% 0.13 ${hue})`;
