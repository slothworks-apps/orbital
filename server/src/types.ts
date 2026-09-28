import type { WalkthroughTag } from './walkthrough/tag.js';

export type SessionSource = 'terminal' | 'web';
export type SessionStatus = 'working' | 'needs_input' | 'idle' | 'ended';
/** Ordered by escalating autonomy. Mirrored in `web/src/lib/types.ts` — this
 * repo has no shared types package, so the two must move together. The SDK
 * also ships `default` and `dontAsk`; Orbital offers neither, see
 * `docs/superpowers/specs/2026-09-17-permission-mode-dots-design.md`. */
export type PermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions';
export type SubagentState = 'materializing' | 'working' | 'idle' | 'needs_input' | 'ended';
/**
 * Where a session's title came from. `derived` is the indexer's read of the
 * first user turn, `auto` is the titler's, and `manual` is a person's — the
 * only one nothing may overwrite. See
 * `docs/superpowers/specs/2026-09-18-auto-title-design.md`.
 */
export type TitleSource = 'derived' | 'auto' | 'manual';

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
  indexed_mtime: number;
  indexed_size: number;
  /** Context tokens at the end of the last turn, or null if never measured.
   * See db/schema.ts. */
  context_used_tokens: number | null;
  /** When the user pinned this session (epoch ms), or null. See db/schema.ts. */
  pinned_at: number | null;
  /** The Runner's claim on this session, null when it holds none. See db/schema.ts. */
  runner_status: SessionStatus | null;
  /** When a restart cut a turn short (epoch ms), null otherwise. See db/schema.ts. */
  interrupted_at: number | null;
  /** When the user ended this session (epoch ms), or null. See db/schema.ts. */
  ended_at: number | null;
}

/**
 * One stored transcript image on the wire: a pointer into the server's
 * content-addressed store (`GET /api/images/<ref>`), never the bytes.
 * `w`/`h` are sniffed at store time so the client can reserve the box
 * before decode; null when the sniffer didn't recognise the payload.
 */
export interface ImageRefEntry {
  ref: string;
  w: number | null;
  h: number | null;
  bytes: number;
}

/**
 * How loudly a notice row speaks. The SDK's own vocabulary
 * (`SDKInformationalMessage.level`): `info` shows only in a transcript, which
 * is where Orbital puts it anyway; `notice` is the ordinary answer to a local
 * slash command; `suggestion` and `warning` are meant to stand out.
 */
export type NoticeLevel = 'info' | 'notice' | 'suggestion' | 'warning';

export interface ChatMessage {
  id: string;
  /**
   * `thinking` is Claude's reasoning block — the text it emits before the
   * assistant answer, ahead of any `tool_use`. It gets its own role rather
   * than riding along on an assistant message (a boolean flag, a side
   * array) because the transcript renders it as a distinct block,
   * interleaved in publish order with prose and tool rows rather than
   * folded into either. See
   * `docs/superpowers/specs/2026-09-22-subagent-transcript-panel-design.md` § 7.
   *
   * `notice` is the CLI speaking for itself rather than through the model —
   * a locally-answered slash command's output, a hook's feedback. It is not a
   * turn: nothing about it went to or came from the model, so it carries no
   * `model` and is never folded into a tool run
   * (`docs/domains/locally-answered-slash-commands.md`).
   *
   * `compaction` is the permanent mark a context compaction leaves, success
   * or failure; its facts ride in `compaction`. Like `notice` it is not a
   * turn and never folds into a tool run
   * (spec 2026-09-28-context-compaction-design).
   */
  role: 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'notice' | 'compaction';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  timestamp?: string;
  /** Resolved model that produced this assistant message. Absent on user turns. */
  model?: string;
  /**
   * A user turn's machine wrapping (slash-command expansion, system
   * reminders), split off by `splitUserText` so `text` is only what the
   * human typed. `name` verbatim from `<command-name>` incl. the slash,
   * `body` the raw tag blocks, `blocks` how many. The web folds this
   * behind a chip (spec: 2026-09-18-transcript-folding-design).
   * `walkthrough` is the turn's own walkthrough tag, read only from a
   * top-level block — one quoted inside another block is not the turn's
   * (spec: 2026-09-23-walkthrough-design § The wire format).
   */
  command?: { name: string | null; body: string; blocks: number; walkthrough?: WalkthroughTag };
  /** tool_result only: the block carried `is_error: true`. */
  isError?: boolean;
  /**
   * `notice` rows only. `command` is the slash command whose output this is
   * (`/context`), absent when the CLI did not say which — a refused command
   * carries no `local_command_run`, and a hook's banner names no command.
   */
  notice?: { level: NoticeLevel; command?: string };
  /** Images this message carries — refs into the image store, never data.
   * A pasted user image is its own message (no text); a tool_result keeps
   * its text beside them. Spec: 2026-09-18-transcript-images-design. */
  images?: ImageRefEntry[];
  /**
   * The row is still being streamed: its text is what the `delta` events
   * have delivered so far. Cleared when the complete block replaces it or
   * the turn ends. Never set on a message read from the file (spec:
   * 2026-09-24-streaming-output-design).
   */
  partial?: true;
  /** `compaction` rows only. */
  compaction?: CompactionMark;
}

/**
 * What one compaction left behind, as both the live stream and the transcript
 * file can say it. Only what was reported: a figure the CLI did not give is
 * null, never estimated (spec 2026-09-28-context-compaction-design § What the
 * SDK and the transcript give us).
 */
export interface CompactionMark {
  outcome: 'success' | 'failed';
  trigger: 'manual' | 'auto';
  preTokens: number | null;
  /** Success only, and optional there too: absent in some real boundaries. */
  postTokens: number | null;
  durationMs: number | null;
  /** Success only: the summary Claude carries on from, when it was seen. */
  summary?: string;
  /** Failure only: the CLI's error text verbatim, null when it gave none. */
  error?: string | null;
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

/**
 * What kind of thing failed. A short machine label, not a message.
 *
 * `sessions_healed` is legacy: the boot-time resume that recorded it is gone
 * (spec 2026-09-24-sessions-end-only-by-hand-design § 5) and nothing produces
 * it now, but rows written before still carry it.
 *
 * `transcript_gap` is not a failure anyone saw as one: the open panel was
 * missing a message its transcript file had, and the transcript check filled
 * it in (spec 2026-09-28-transcript-check-design). Logged so the gap's cause
 * can be read off a real occurrence.
 *
 * `compaction_failed` is a context compaction the CLI reported as failed, so
 * it can be read even when the session is not open (spec
 * 2026-09-28-context-compaction-design § Failure).
 */
export type ErrorKind =
  | 'session_failed'
  | 'api_request'
  | 'render_crash'
  | 'sessions_healed'
  | 'transcript_gap'
  | 'compaction_failed';

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
