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
  /**
   * Context tokens at the end of the session's last turn, or null when it was
   * never measured — the numerator of the map's context arc (spec
   * `context-fill-arc`). Only sessions Orbital runs itself ever carry one; a
   * terminal session's is permanently null, the indexer having no usage to
   * read. Mirrors `server/src/api/shape.ts`.
   *
   * Optional here for the same reason as `pendingDecision`: the server always
   * sends the field, absent and null mean the same thing to every reader, and
   * requiring it would rewrite every session fixture in the suite.
   */
  contextUsedTokens?: number | null;
  /**
   * Map-only dismissal stamp (epoch ms), or null — set when the session was
   * dragged into the map's hole, cleared by undo or any new activity. Only
   * the map reads it; the sidebar and search never do (spec
   * 2026-09-18-tag-clusters-design § 5). Mirrors `server/src/api/shape.ts`.
   */
  mapDismissedAt: number | null;
  tagIds: number[];
  status: SessionStatus;
  /** Subagents running in this session right now — the map's moons. */
  subagents: Subagent[];
  /**
   * The question this session is blocked on, or null. Part of the session
   * snapshot precisely so a reload does not lose it (spec:
   * 2026-09-20-interactive-decisions-design § State and lifecycle) — the
   * `decision_pending` WS event is only heard by a tab that was already
   * connected. Mirrors `server/src/api/shape.ts`.
   *
   * Optional here (like `Tag.anchor_*`): the server always sends the field,
   * but absent and null mean the same thing to every reader, and requiring
   * it would rewrite every session fixture in the suite for no signal.
   */
  pendingDecision?: PendingDecision | null;
}

/**
 * One option row of an `AskUserQuestion` question. `preview` is what the
 * focused row reveals below the block; most options do not carry one.
 * Mirrors the SDK's `AskUserQuestionInput`.
 */
export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

/** One question of an `AskUserQuestion` call: 2–4 options, single or multi. */
export interface QuestionSpec {
  question: string;
  /** The chip over the question — capped and uppercased by the card. */
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** The tool call's input as the SDK delivers it: 1–4 questions. */
export interface AskUserQuestionInput {
  questions: QuestionSpec[];
}

/**
 * A decision the session is blocked on. `kind` is the extension point the
 * spec leaves for permission prompts and dialogs later; today only
 * `'question'` rides this channel.
 *
 * `id` IS the `AskUserQuestion` tool_use's `toolUseId`, which is what lets a
 * transcript card recognise itself as the pending one without any extra
 * correlation state.
 */
export interface PendingDecision {
  id: string;
  kind: 'question';
  input: AskUserQuestionInput;
  createdAt: number;
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
  /**
   * Local-only provenance for the images above, keyed by ref — never on the
   * wire, never persisted. Set by `sendPrompt` on the optimistic turn and
   * carried across the WS replacement, which is the whole window in which the
   * transcript can caption a thumbnail (spec: 2026-09-20-composer-design
   * § The transcript side).
   */
  imageProvenance?: Record<string, ImageProvenance>;
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

/**
 * Where an attachment came from — the composer's two intakes (spec:
 * 2026-09-20-composer-design § Image intake). It decides the chip's name and
 * the transcript caption's: a paste is honestly `Clipboard image`, never a
 * made-up filename, while a dropped file wears its own.
 */
export type AttachmentSource = 'clipboard' | 'file'

/**
 * What the client knows about one sent image that the wire does not. An SDK
 * image block carries no name, so this is LOCAL-ONLY state: it exists on the
 * optimistic message and on the WS replacement that supersedes it, and is gone
 * after a reload — which is exactly why a history turn renders captionless
 * (spec § The transcript side).
 */
export interface ImageProvenance {
  name: string
  source: AttachmentSource
}

/**
 * One attachment upload as the composer consumes it — the client mirror of
 * `POST /api/sessions/:id/attachments`. Shaped like `FilePreview`: the three
 * refusals are chip/hint-line states carrying a measured fact, not errors, so
 * `api.uploadAttachment` reads them out of the 413/415/400 bodies instead of
 * throwing. Only a status outside the contract is a real failure.
 */
export type AttachmentUpload =
  | { kind: 'ok'; entry: ImageRefEntry }
  /** `truncated` means the server stopped at its 2× wall — the size is a floor. */
  | { kind: 'too_large'; size: number; truncated: boolean }
  | { kind: 'not_image'; mediaType: string }
  | { kind: 'empty' }

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
  /**
   * The clump's stored home spot on the map, in world units — written when
   * the user drops a dragged body somewhere new; null (or absent, in old
   * fixtures) means the automatic circle layout places the tag. Both set or
   * both null; a half-set pair falls back to the automatic layout.
   */
  anchor_x?: number | null;
  anchor_y?: number | null;
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
 * One file as the viewer sees it — the client-side mirror of the server's
 * `PreviewResult` (spec: 2026-09-19-file-viewer-design § Server). The four
 * non-`ok` kinds are viewer states, never errors: `api.filePreview` reads
 * them out of the 403/404/413/415 bodies instead of throwing.
 */
export type FilePreview =
  | { kind: 'ok'; content: string; size: number; mtimeMs: number; lines: number }
  | { kind: 'not_found' }
  | { kind: 'outside' }
  | { kind: 'too_large'; size: number }
  | { kind: 'binary'; size: number; mediaType: string }

/**
 * Which of the two completion sources a session key resolves against: a live
 * session id in the detail panel, the chosen directory in the New Session
 * dialog (spec: 2026-09-20-composer-design § Server). One shape, so
 * `api.commands` / `api.filesComplete` have one signature and the composer has
 * one prop.
 */
export type CompletionKey = { session: string } | { cwd: string }

/** Where a slash command comes from — the popup's right-hand badge (canvas 9b). */
export type CommandSource = 'user' | 'project' | 'plugin' | 'built-in'

/** One row of `GET /api/commands`. */
export interface SlashCommand {
  /** With or without a leading slash; `commandNameSet` normalises it. */
  name: string
  description: string
  source: CommandSource
}

/** One row of `GET /api/files/complete`. `size` is absent for directories. */
export interface FileCompletionEntry {
  name: string
  dir: boolean
  size?: number
}

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
