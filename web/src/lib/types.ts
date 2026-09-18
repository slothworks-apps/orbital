export type SessionStatus = 'working' | 'needs_input' | 'idle' | 'ended';
export type SessionSource = 'terminal' | 'web';
/** Ordered by escalating autonomy; `lib/permissionModes.ts` carries the copy
 * and the dot colour for each. Mirrored in `server/src/types.ts`. */
export type PermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions';

export interface ApiSession {
  id: string;
  cwd: string;
  title: string;
  firstAt: number | null;
  lastAt: number | null;
  messageCount: number;
  source: SessionSource;
  permissionMode: PermissionMode | null;
  model: string | null;
  resolvedModel: string | null;
  parentId: string | null;
  tagIds: number[];
  status: SessionStatus;
  /** Subagents running in this session right now — the map's moons. */
  subagents: Subagent[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  timestamp?: string;
  /** Resolved model that produced this assistant message. */
  model?: string;
  /**
   * A user turn's machine wrapping (slash-command expansion, system
   * reminders), split off server-side so `text` is only what the human
   * typed. Folded behind a chip in `MessageView` (spec:
   * 2026-09-18-transcript-folding-design).
   */
  command?: { name: string | null; body: string; blocks: number };
  /** tool_result only: the block carried `is_error: true`. */
  isError?: boolean;
  /** Images this message carries — refs into the server's image store
   * (`GET /api/images/<ref>`), never bytes. Mirrors `server/src/types.ts`.
   * Spec: 2026-09-18-transcript-images-design. */
  images?: ImageRefEntry[];
}

/**
 * One stored transcript image: a pointer the browser turns into an
 * `<img src="/api/images/<ref>">`. `w`/`h` are the stored pixel size so the
 * box can be reserved before decode; null when the server couldn't sniff
 * them.
 */
export interface ImageRefEntry {
  ref: string;
  w: number | null;
  h: number | null;
  bytes: number;
}

/** One model as every Orbital surface consumes it. Duplicated from the
 * server's `server/src/models/catalog.ts` — this repo has no shared types
 * package, so the two declarations must be kept field-for-field in sync. */
export interface OrbitalModel {
  value: string;
  resolvedModel: string;
  family: string;
  version: string;
  shortVersion: string;
  variant: string | null;
  blurb: string;
  contextWindow: number | null;
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

/**
 * True for a session Orbital does not own: one it indexed from another
 * terminal and that is still running there. The composer refuses input on
 * these and the sidebar badges them; the server's 409 on
 * `POST /sessions/:id/messages` is the real backstop.
 *
 * An `ended` terminal session is NOT read-only — `continue` resumes it as a
 * new `source: web` session — which is why status is part of the test.
 */
export const isReadOnly = (session: Pick<ApiSession, 'source' | 'status'>): boolean =>
  session.source === 'terminal' && session.status !== 'ended';

/**
 * Where an error was caught. The browser posts its own failures to
 * `POST /api/errors` so both sides land in one list. Mirrored in
 * `server/src/types.ts` — the two must move together. See
 * `docs/superpowers/specs/2026-09-17-error-surface-design.md`.
 */
export type ErrorSource = 'server' | 'web'

/** What kind of thing failed. A short machine label, not a message. */
export type ErrorKind = 'session_failed' | 'api_request' | 'render_crash'

export interface ErrorRecord {
  id: number
  /** Epoch ms. */
  at: number
  source: ErrorSource
  kind: ErrorKind
  /** Set when the error belongs to one session, null otherwise. */
  sessionId: string | null
  /** The one line the toast shows. */
  message: string
  /** The long form — a stack, a `componentStack`, a response body. */
  detail: string | null
  /** Anything else worth keeping: `cwd`, `permissionMode`, `model`, request URL, HTTP status. */
  context: Record<string, unknown> | null
  /** When the error list showed this row. Null until then. */
  seenAt: number | null
}
