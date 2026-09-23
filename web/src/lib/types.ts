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
  /**
   * When the user pinned this session (epoch ms), or null — the manual
   * exemption from the map's release timer (spec
   * 2026-09-20-pinned-sessions-design). A time rather than a flag because
   * the sidebar's PINNED section keeps pin order. Never non-null at the
   * same time as `mapDismissedAt`. Mirrors `server/src/api/shape.ts`.
   *
   * Optional here for the same reason as `contextUsedTokens`: the server
   * always sends the field, absent and null mean the same thing to every
   * reader, and requiring it would rewrite every session fixture in the suite.
   */
  pinnedAt?: number | null;
  /**
   * When a server restart cut this session's turn short (epoch ms), null
   * otherwise (spec 2026-09-21-session-autoheal-design). The session itself
   * was resumed and holds its whole context; what is missing is the rest of
   * that one turn. Cleared the next time it runs a turn. Mirrors
   * `server/src/api/shape.ts`.
   *
   * Optional here for the same reason as `pinnedAt`: the server always sends
   * the field, absent and null mean the same thing to every reader, and
   * requiring it would rewrite every session fixture in the suite.
   */
  interruptedAt?: number | null;
  tagIds: number[];
  status: SessionStatus;
  /**
   * `working`, but only because of `subagents`: the session's own turn is
   * over and it is waiting for what it launched, which comes back without the
   * human doing anything. The readout says `WAITING FOR AGENT` rather than
   * counting it as a fifth state — see `server/src/api/shape.ts`.
   *
   * Optional here for the same reason as `interruptedAt`: absent and false
   * mean the same thing to every reader.
   */
  awaitingSubagents?: boolean;
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
  /**
   * Where this session's `cwd` sits in git right now, or null when it is not
   * inside a repository (spec 2026-09-22-git-location-indicator-design). The
   * live state of the directory, not a record of the session — an ended
   * session reads whatever its folder is on today (adr
   * `git-location-is-ambient-not-recorded`). Mirrors
   * `server/src/api/shape.ts`.
   *
   * Optional here for the same reason as `pendingDecision`: the server always
   * sends the field, and absent and null mean the same thing to every reader.
   */
  git?: GitLocation | null;
  /**
   * The editor open on this session's workspace right now, or null when none
   * is (spec 2026-09-23-ide-bridge-design § What reaches the browser). Live
   * state of a directory, with the same standing `git` has — two sessions in
   * one workspace always show the same editor. Mirrors
   * `server/src/api/shape.ts`.
   *
   * Optional here for the same reason as `git`: the server always sends the
   * field, and absent and null mean the same thing to every reader.
   */
  ide?: IdeContext | null;
}

/**
 * A selection in the editor, as the browser reads it. `lineStart` is 1-based
 * — it matches the gutter the person is looking at — and `text` is null when
 * the caret merely moved. Mirrors `server/src/ide/protocol.ts`.
 */
export interface IdeSelection {
  filePath: string
  lineStart: number
  lineCount: number
  text: string | null
}

/** The editor covering a session's workspace. Mirrors the server's shape. */
export interface IdeContext {
  /** As the lock reports it — the product (`WebStorm`), not the vendor. */
  ideName: string
  workspaceRoot: string
  selection: IdeSelection | null
}

/** How severe the editor thinks one of its findings is. */
export type IdeDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

/**
 * One of the editor's own findings — an inspection no test run reports
 * (spec § Talking back to the editor). `line` is 1-based, like a selection's.
 */
export interface IdeDiagnostic {
  filePath: string
  line: number
  severity: IdeDiagnosticSeverity
  message: string
  source: string | null
}

/**
 * The facts the header's git suffix is drawn from. The mark is not on the
 * wire: the browser picks trunk (default branch or detached), fork (any other
 * branch) or tree (worktree) from these three flags, so the canvas can change
 * its vocabulary without the server moving (canvas `Feature - Git worktree`
 * 1e, M1).
 */
export interface GitLocation {
  /** Branch name, or the abbreviated sha when `detached`. */
  ref: string;
  detached: boolean;
  worktree: boolean;
  /** Always false for a worktree or a detached HEAD, which draw their own mark. */
  defaultBranch: boolean;
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
 * What surface a parked decision needs. Mirrors `DecisionKind` in
 * `server/src/runner/runner.ts` — this repo has no shared types package, so
 * the two must move together.
 */
export type DecisionKind = 'question' | 'permission' | 'plan';

/**
 * A decision the session is blocked on — the CLI is inside a `canUseTool`
 * call and nothing moves until the browser answers.
 *
 * `id` IS the blocked tool_use's `toolUseId`, which is what lets a transcript
 * card recognise itself as the pending one without any extra correlation
 * state.
 *
 * A union rather than one widened interface: the two arms are answered
 * through different endpoints' bodies and drawn by different components, and
 * only the `question` arm has `input.questions` at all. Narrowing on `kind`
 * is what stops a permission prompt being read as a question — which on the
 * server would mean merging an `answers` key into a shell command
 * (spec 2026-09-23-permission-and-plan-decisions-design).
 */
export type PendingDecision = PendingQuestionDecision | PendingVerdictDecision;

export interface PendingQuestionDecision {
  id: string;
  kind: 'question';
  input: AskUserQuestionInput;
  createdAt: number;
}

/** A permission prompt or a plan approval: answered yes/no, not in words. */
export interface PendingVerdictDecision {
  id: string;
  kind: 'permission' | 'plan';
  /** The tool's own input, verbatim — `{plan}` for a plan approval. */
  input: Record<string, unknown>;
  createdAt: number;
  /** The tool being asked about. */
  toolName?: string;
  /**
   * The CLI bridge's own prompt copy, when it sent any. Preferred over
   * anything reconstructed here: the bridge writes the sentence the terminal
   * shows, and two hosts wording the same ask differently is how they come to
   * disagree about what a tool is about to do.
   */
  title?: string;
  displayName?: string;
  description?: string;
  /** The CLI flagged this ask as one no stray keystroke may approve. */
  defaultToNo?: boolean;
}

/**
 * How loudly a notice row speaks — the SDK's own vocabulary. Mirrors
 * `server/src/types.ts`.
 */
export type NoticeLevel = 'info' | 'notice' | 'suggestion' | 'warning';

export interface ChatMessage {
  id: string;
  /**
   * `notice` is the CLI speaking for itself rather than through the model —
   * a locally-answered slash command's output (`/context`, `/usage`, `/mcp`),
   * a hook's feedback. Rendered by `NoticeRow`, never by `MessageView`.
   */
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'notice';
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
  /**
   * `notice` rows only. `command` is the slash command whose output this is
   * (`/context`), absent when the CLI did not name one. Mirrors
   * `server/src/types.ts`.
   */
  notice?: { level: NoticeLevel; command?: string };
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

/**
 * `POST /api/models/validate` — whether Claude Code will start on a model id
 * the SDK catalog does not list. `reason` is Claude Code's own sentence.
 */
export type ModelValidation =
  | { ok: true; model: string; resolvedModel: string | null; contextWindow: number | null }
  | { ok: false; model: string; reason: string };

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
 * How many of a session's subagents are still out working, when that is the
 * ONLY reason the session is busy — zero whenever the session is doing
 * something of its own, or is not working at all.
 *
 * `awaitingSubagents` is the server's judgement (it alone can see the main
 * loop's turn boundaries); the count comes off the moons the map is already
 * drawing, so the readout and the orbit can never disagree about how many.
 */
export function awaitingSubagentCount(
  session: Pick<ApiSession, 'status' | 'awaitingSubagents' | 'subagents'>
): number {
  if (session.status !== 'working' || !session.awaitingSubagents) return 0;
  return session.subagents.filter((agent) => agent.state !== 'ended').length;
}

/**
 * The readout for a session that is only waiting on what it launched. One
 * wording, shared by the map's pill and the panel's chip — the moons carry
 * the count, so the label only has to get the grammar right.
 */
export const awaitingSubagentLabel = (count: number): string =>
  count === 1 ? 'WAITING FOR AGENT' : 'WAITING FOR AGENTS';

/**
 * What a `needs_input` session actually wants, in a word.
 *
 * `needs_input` covers two situations the server cannot tell apart with a
 * status, because the CLI parks on stdin for both: it asked something and is
 * blocked on the answer (`pendingDecision` — a permission request or an
 * `AskUserQuestion`), or it simply finished its turn and the next move is
 * yours. Only the first is anyone being *waited for*, so only the first says
 * NEEDS INPUT; a session that is merely done says DONE.
 *
 * DONE, not ENDED: `ended` already means the session itself is over. This one
 * is alive and can be written to.
 *
 * Reads the snapshot's `pendingDecision`, which the server republishes on both
 * edges of a park precisely so the map — where nothing is selected and the
 * `decision_pending` event is never heard — can answer this too.
 */
export const parkedLabel = (session: Pick<ApiSession, 'pendingDecision'>): string =>
  session.pendingDecision ? 'NEEDS INPUT' : 'DONE';

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
export type ErrorKind = 'session_failed' | 'api_request' | 'render_crash' | 'sessions_healed'

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

/* ---------------------------------------------------------------------------
   Stats (spec: 2026-09-20-session-stats-design). Every shape below mirrors
   what `server/src/api/stats.ts` returns — the two must move together. All
   numbers are raw: milliseconds, tokens and USD, never pre-formatted, because
   `stats/format.ts` owns how they read.
   --------------------------------------------------------------------------- */

/** The windows `GET /api/stats/overview` accepts; anything else is a 400. */
export type StatsWindow = '24h' | '7d' | '30d' | 'all'

/**
 * A finding's read-time severity. RESOLVED is not a fourth level but the
 * state a rule moves into once it stops firing — the canvas (10d) gives it
 * the same card slot as the three real severities.
 */
export type FindingSeverity = 'critical' | 'warning' | 'info' | 'resolved'

export interface StatsTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** cacheRead ÷ all priced input; null when the window priced no tokens at all. */
  cachedRatio: number | null
  apiMs: number
  localToolMs: number
  mcpMs: number
  subagentMs: number
  /** The four categories above, summed. Never the wall clock. */
  busyMs: number
  wallClockMs: number
  costTotal: number
  /** Null for a window with no sessions — there is nothing to average over. */
  costPerSession: number | null
  sessionCount: number
}

/** One column of the BUSY TIME PER DAY chart; `day` is a local `YYYY-MM-DD`. */
export interface StatsDayBusy {
  day: string
  apiMs: number
  localToolMs: number
  mcpMs: number
  subagentMs: number
  busyMs: number
}

/** One point of the cache-hit trend; null on a day that priced no input. */
export interface StatsCacheRatioDay {
  day: string
  ratio: number | null
}

export interface StatsToolRow {
  tool: string
  isMcp: boolean
  calls: number
  errors: number
  ms: number
  /** Estimated from the merged duration histogram; null when the tool never ran. */
  p50Ms: number | null
  /** Characters of `toolUseResult` — the leaderboard's "most expensive" ranking. */
  resultChars: number
}

export interface StatsToolLeaderboard {
  slowest: StatsToolRow[]
  mostExpensive: StatsToolRow[]
}

/**
 * One card in the findings feed. `sessionId`/`title`/`projectDir` are null for
 * `slow-mcp`, which is server-wide rather than a fact about one session.
 * `evidence` is the rule's own measured numbers — its keys differ per rule,
 * which is why it is not typed further than this (see `stats/findingCopy.ts`).
 */
export interface StatsFinding {
  rule: string
  severity: FindingSeverity
  sessionId: string | null
  title: string | null
  projectDir: string | null
  /** Epoch ms: the session's `lastAt`, or now for the window-level rules. */
  when: number
  evidence: Record<string, unknown>
}

/** `GET /api/stats/overview`. */
export interface StatsOverview {
  filters: { window: StatsWindow; project: string | null; model: string | null }
  sessionCount: number
  /** Null for `window=all`, which starts at the first session there is. */
  windowStart: number | null
  windowEnd: number
  totals: StatsTotals
  /** The same-length window before this one; null for `window=all`. */
  previousTotals: StatsTotals | null
  /** Already a percentage, not a ratio. Null when there is no baseline to compare against. */
  costDeltaPct: number | null
  daySeries: StatsDayBusy[]
  cacheRatioSeries: StatsCacheRatioDay[]
  toolLeaderboard: StatsToolLeaderboard
  findings: StatsFinding[]
}

export interface StatsRollup {
  apiMs: number
  localToolMs: number
  mcpMs: number
  subagentMs: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheCreation5mTokens: number
  cacheCreation1hTokens: number
  thinkingTokens: number
  subagentTokens: number
  subagentUsage: Record<
    string,
    {
      input: number
      output: number
      cacheRead: number
      cacheCreation: number
      cacheCreation5m: number
      cacheCreation1h: number
    }
  >
  toolCalls: number
  toolErrors: number
  toolBreakdown: Record<
    string,
    { calls: number; errors: number; ms: number; resultChars: number; buckets: number[] }
  >
  findings: Array<{ rule: string; evidence: Record<string, unknown> }>
}

/** One turn of the drilldown waterfall — derived on demand, never stored. */
export interface StatsTurnSegment {
  requestId: string
  /** The turn's transcript entry uuid — what a finding's evidence names (ADR
   * `a-rule-names-its-turn-by-uuid`). Empty when the entry carried none. */
  uuid: string
  startTs: number
  apiMs: number
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number }
  tools: Array<{
    name: string
    kind: 'local' | 'mcp' | 'subagent'
    ms: number
    isError: boolean
    resultChars: number
    useId: string
  }>
}

/** `GET /api/stats/sessions/:id`. */
export interface SessionStatsDetail {
  session: {
    id: string
    title: string
    projectDir: string
    model: string | null
    resolvedModel: string | null
    firstAt: number | null
    lastAt: number | null
    turns: number
  }
  rollup: StatsRollup
  /** Derived at read time from the shipped pricing table; never persisted as money. */
  cost: {
    uncachedInput: number
    cacheRead: number
    cacheWrite: number
    output: number
    mainTotal: number
    subagentTotal: number
    total: number
  }
  findings: Array<{ rule: string; severity: FindingSeverity; evidence: Record<string, unknown> }>
  turns: StatsTurnSegment[]
}
