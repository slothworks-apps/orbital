export type SessionStatus = 'working' | 'needs_input' | 'idle' | 'ended'
export type SessionSource = 'terminal' | 'web'
/** Ordered by escalating autonomy; `lib/permissionModes.ts` carries the copy
 * and the dot colour for each. Mirrored in `server/src/types.ts`. */
export type PermissionMode = 'plan' | 'acceptEdits' | 'auto' | 'bypassPermissions'

export interface ApiSession {
  id: string
  cwd: string
  title: string
  firstAt: number | null
  lastAt: number | null
  messageCount: number
  source: SessionSource
  permissionMode: PermissionMode | null
  model: string | null
  resolvedModel: string | null
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
  contextUsedTokens?: number | null
  /**
   * When the user pinned this session (epoch ms), or null. A pinned session
   * stays on the map even once it has ended (spec
   * 2026-09-20-pinned-sessions-design, spec
   * 2026-09-24-sessions-end-only-by-hand-design § 3). A time rather than a
   * flag because the sidebar's PINNED section keeps pin order. Mirrors
   * `server/src/api/shape.ts`.
   *
   * Optional here for the same reason as `contextUsedTokens`: the server
   * always sends the field, absent and null mean the same thing to every
   * reader, and requiring it would rewrite every session fixture in the suite.
   */
  pinnedAt?: number | null
  /**
   * When the user ended this session (epoch ms), null while it is open and
   * for every terminal session, whose end is its CLI exiting rather than a
   * stamp (spec 2026-09-24-sessions-end-only-by-hand-design § 1).
   * Mirrors `server/src/api/shape.ts`.
   *
   * Optional here for the same reason as `pinnedAt`.
   */
  endedAt?: number | null
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
  interruptedAt?: number | null
  tagIds: number[]
  status: SessionStatus
  /**
   * `working`, but only because of `subagents`: the session's own turn is
   * over and it is waiting for what it launched, which comes back without the
   * human doing anything. The readout says `WAITING FOR AGENT` rather than
   * counting it as a fifth state — see `server/src/api/shape.ts`.
   *
   * Optional here for the same reason as `interruptedAt`: absent and false
   * mean the same thing to every reader.
   */
  awaitingSubagents?: boolean
  /** Subagents running in this session right now — the map's moons. */
  subagents: Subagent[]
  /**
   * Every background task — shell, monitor, workflow, MCP task — the session
   * has had, ended included, in start order (spec
   * 2026-09-28-background-tasks-design § 2). Optional for the same reason
   * as `interruptedAt`: absent and empty mean the same thing to every
   * reader, and requiring it would rewrite every session fixture.
   */
  backgroundTasks?: BackgroundTask[]
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
  pendingDecision?: PendingDecision | null
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
  git?: GitLocation | null
  /**
   * How far this session's working tree has got: line changes against the
   * parent branch and the branch's pull request (spec
   * 2026-09-30-branch-pr-and-line-changes-design § The wire). Each half is
   * present only while its setting is on and a reading exists; the key is
   * absent otherwise. Live state of a directory, like `git`. Mirrors
   * `server/src/api/shape.ts`.
   */
  branch?: BranchStatus
  /**
   * The editor open on this session's workspace right now, or null when there
   * is none (spec 2026-09-23-ide-bridge-design). Live state of a directory
   * rather than a fact about the session, exactly as `git` is — two sessions in
   * one workspace always read the same selection (adr
   * `orbital-speaks-to-the-ide-itself`). Mirrors `server/src/api/shape.ts`.
   */
  ide?: IdeContext | null
  /**
   * The compaction running in this session right now, or null — only ever
   * set for a session Orbital runs (spec 2026-09-28-context-compaction-design
   * § Live state). Mirrors `server/src/api/shape.ts`.
   *
   * Optional here, like every other snapshot field added after the fixtures.
   */
  compacting?: { startedAt: number; trigger: 'manual' | 'auto' } | null
  /**
   * The newest compaction failed and nothing has moved on from it yet — no
   * success, no new turn. Survives a restart; opening the session does not
   * clear it. Mirrors `server/src/api/shape.ts`.
   */
  lastCompactionFailed?: { at: number } | null
  /**
   * The newest compaction the server saw succeed in this process, for the
   * map's short `compacted · 186k → 22k` caption. Mirrors
   * `server/src/api/shape.ts`.
   */
  lastCompacted?: { at: number; preTokens: number | null; postTokens: number | null } | null
  /**
   * The rewind picked and not sent yet, or null: `hiddenCount` is the N the
   * client counted at pick time, `text` the picked message's. While it is
   * set the session reads `needs_input` and the transcript ends before the
   * picked message. Mirrors `server/src/api/shape.ts` (spec
   * 2026-09-29-rewind-design § Pending rewind).
   */
  rewindPending?: { hiddenCount: number; text: string } | null
}

/** Where the caret is, and what is selected under it. */
export interface IdeSelection {
  /** Absolute, as the extension reports it. */
  filePath: string
  /** 1-based, so it matches what the editor's gutter shows. */
  lineStart: number
  lineCount: number
  /** null when the caret moved and nothing is selected. */
  text: string | null
}

/**
 * The editor covering a session's workspace. Mirrors
 * `server/src/ide/protocol.ts` — the two must move together.
 */
export interface IdeContext {
  /** As the lock reports it: the product (`WebStorm`), not the vendor. */
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
  ref: string
  detached: boolean
  worktree: boolean
  /** Always false for a worktree or a detached HEAD, which draw their own mark. */
  defaultBranch: boolean
}

/** Mirrors `server/src/git/branchStatus.ts`. */
export interface LineCounts {
  added: number
  removed: number
}

export interface BranchLines {
  /** The branch the count is taken against; null: no parent, uncommitted only. */
  parent: string | null
  committed: LineCounts
  uncommitted: LineCounts
}

export interface BranchPr {
  number: number
  url: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  review: 'approved' | 'changes_requested' | 'review_required' | null
  /** Null: the PR has no checks at all. */
  checks: { passed: number; failed: number; pending: number } | null
  /** The PR's base branch — the parent the line count is taken against. */
  base: string
}

export interface BranchStatus {
  lines?: BranchLines
  pr?: BranchPr
}

/** `GET /api/gh-status`: whether the PR switch can be on, and if not, why. */
export type GhAvailability = 'ready' | 'missing' | 'logged_out'

/**
 * One option row of an `AskUserQuestion` question. `preview` is what the
 * focused row reveals below the block; most options do not carry one.
 * Mirrors the SDK's `AskUserQuestionInput`.
 */
export interface QuestionOption {
  label: string
  description: string
  preview?: string
}

/** One question of an `AskUserQuestion` call: 2–4 options, single or multi. */
export interface QuestionSpec {
  question: string
  /** The chip over the question — capped and uppercased by the card. */
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

/** The tool call's input as the SDK delivers it: 1–4 questions. */
export interface AskUserQuestionInput {
  questions: QuestionSpec[]
}

/**
 * What surface a parked decision needs. Mirrors `DecisionKind` in
 * `server/src/runner/runner.ts` — this repo has no shared types package, so
 * the two must move together.
 */
export type DecisionKind = 'question' | 'permission' | 'plan'

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
export type PendingDecision = PendingQuestionDecision | PendingVerdictDecision

export interface PendingQuestionDecision {
  id: string
  kind: 'question'
  input: AskUserQuestionInput
  createdAt: number
}

/** A permission prompt or a plan approval: answered yes/no, not in words. */
export interface PendingVerdictDecision {
  id: string
  kind: 'permission' | 'plan'
  /** The tool's own input, verbatim — `{plan}` for a plan approval. */
  input: Record<string, unknown>
  createdAt: number
  /** The tool being asked about. */
  toolName?: string
  /**
   * The CLI bridge's own prompt copy, when it sent any. Preferred over
   * anything reconstructed here: the bridge writes the sentence the terminal
   * shows, and two hosts wording the same ask differently is how they come to
   * disagree about what a tool is about to do.
   */
  title?: string
  displayName?: string
  description?: string
  /** The CLI flagged this ask as one no stray keystroke may approve. */
  defaultToNo?: boolean
}

/**
 * How loudly a notice row speaks — the SDK's own vocabulary. Mirrors
 * `server/src/types.ts`.
 */
export type NoticeLevel = 'info' | 'notice' | 'suggestion' | 'warning'

/**
 * What one compaction left behind (spec 2026-09-28-context-compaction-design).
 * A figure the CLI did not report is null, never estimated. Mirrors
 * `server/src/types.ts`.
 */
export interface CompactionMark {
  outcome: 'success' | 'failed'
  trigger: 'manual' | 'auto'
  preTokens: number | null
  postTokens: number | null
  durationMs: number | null
  /** Success only. */
  summary?: string
  /** Failure only: verbatim, null when the CLI gave no reason. */
  error?: string | null
}

export interface ChatMessage {
  id: string
  /**
   * `thinking` is Claude's reasoning block, published ahead of any prose or
   * tool call for the turn. Its own role rather than a flag on `assistant`
   * or a side array, because the transcript renders it as a distinct block
   * interleaved in publish order with everything else. Mirrors
   * `server/src/types.ts`. See
   * `docs/superpowers/specs/2026-09-22-subagent-transcript-panel-design.md` § 7.
   *
   * `notice` is the CLI speaking for itself rather than through the model —
   * a locally-answered slash command's output (`/context`, `/usage`, `/mcp`),
   * a hook's feedback. Rendered by `NoticeRow`, never by `MessageView`.
   *
   * `compaction` is the permanent mark a context compaction leaves, its facts
   * in `compaction`. Rendered by `CompactionMark`; never a bubble, never
   * folded into a tool run.
   *
   * `rewind` is the divider where the transcript passes a rewind, its count
   * in `rewind` (null for one done in the terminal). A mark like
   * `compaction` (spec 2026-09-29-rewind-design).
   */
  role: 'user' | 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'notice' | 'compaction' | 'rewind'
  /**
   * The transcript entry this message came from — what a rewind names. On
   * every message read from the file and every live one whose frame carried
   * it; the user's own turn gets it from the send response. Mirrors
   * `server/src/types.ts`.
   */
  uuid?: string
  /** `user` rows only: can be picked as a rewind target. Absent means not. */
  rewindable?: true
  text?: string
  toolName?: string
  toolInput?: unknown
  toolUseId?: string
  timestamp?: string
  /** Resolved model that produced this assistant message. */
  model?: string
  /**
   * A user turn's machine wrapping (slash-command expansion, system
   * reminders), split off server-side so `text` is only what the human
   * typed. Folded behind a chip in `MessageView` (spec:
   * 2026-09-18-transcript-folding-design). `walkthrough` is the turn's own
   * walkthrough tag, read from a top-level block only. Mirrors
   * `server/src/types.ts`.
   */
  command?: {
    name: string | null
    body: string
    blocks: number
    walkthrough?: WalkthroughTag
  }
  /** tool_result only: the block carried `is_error: true`. */
  isError?: boolean
  /**
   * `notice` rows only. `command` is the slash command whose output this is
   * (`/context`), absent when the CLI did not name one. Mirrors
   * `server/src/types.ts`.
   */
  notice?: { level: NoticeLevel; command?: string }
  /** `compaction` rows only. Mirrors `server/src/types.ts`. */
  compaction?: CompactionMark
  /** `rewind` rows only: N, or null for a rewind done in the terminal. Mirrors `server/src/types.ts`. */
  rewind?: { hiddenCount: number | null }
  /** Images this message carries — refs into the server's image store
   * (`GET /api/images/<ref>`), never bytes. Mirrors `server/src/types.ts`.
   * Spec: 2026-09-18-transcript-images-design. */
  images?: ImageRefEntry[]
  /**
   * Local-only provenance for the images above, keyed by ref — never on the
   * wire, never persisted. Set by `sendPrompt` on the optimistic turn and
   * carried across the WS replacement, which is the whole window in which the
   * transcript can caption a thumbnail (spec: 2026-09-20-composer-design
   * § The transcript side).
   */
  imageProvenance?: Record<string, ImageProvenance>
  /**
   * The row is still being streamed: its text is what the `delta` events
   * have delivered so far. Cleared when the complete block replaces it or
   * the turn ends. Never set on a message read from the file (spec:
   * 2026-09-24-streaming-output-design). Mirrors `server/src/types.ts`.
   */
  partial?: true
}

/** Walkthrough wire shape — mirrors server/src/walkthrough/types.ts (spec: 2026-09-23-walkthrough-design). */

/** A walkthrough turn's tag, as the parser reads it (spec § The wire format). Mirrors `server/src/walkthrough/tag.ts`. */
export type WalkthroughTag =
  | { kind: 'narrate' }
  | { kind: 'ask'; step: string; n: number | null }

/** How a later step treated an earlier step's work (spec § Blind alleys). */
export type FateKind = 'revised' | 'reverted'

/** A writing call as the transcript carries it, joined to its result; the browser builds the diff. */
export interface StepCall {
  call: ChatMessage
  result: ChatMessage | null
}

/** A later step that revised or reverted this step's work on `path`. */
export interface StepFate {
  kind: FateKind
  byStep: string
  path: string
}

/**
 * A run's direct writing calls, or one writing dispatch in it. `id` is the
 * `toolUseId` of its first writing call (falling back to that message's id),
 * stable while the transcript grows.
 */
export interface WalkthroughStep {
  id: string
  ordinal: number
  narration: string
  calls: StepCall[]
  folded: Record<string, number>
  subagent: { name: string; prompt: string; steps: WalkthroughStep[] } | null
  fate: StepFate[]
  durationMs: number | null
}

/** Everything between two steps: tool calls folded per tool, subagents that changed nothing, and what the agent said. */
export interface Gap {
  kind: 'gap'
  durationMs: number | null
  folded: Record<string, number>
  subagents: string[]
  said: string
}

/** Steps and gaps interleaved, in transcript order. */
export type TimelineEntry = { kind: 'step'; id: string } | Gap

/**
 * One path the session wrote: the steps that wrote it, whether it was
 * created, its last fate, and whether a call on it failed with no later
 * successful writing call on the same path (a retried failure is not open).
 */
export interface FileSummary {
  path: string
  steps: string[]
  created: boolean
  fate: FateKind | null
  notApplied: boolean
}

/** One intent the narration grouped steps under (spec § Narration). */
export interface NarrationIntent {
  title: string
  summary: string
  steps: string[]
  considered: string[]
  abandoned: boolean
}

/** The last finished narration, laid over the current steps. */
export interface Narration {
  intents: NarrationIntent[]
  /** Current steps no stored intent names — added since the narration. */
  staleSteps: number
}

/** Why the last narrate query failed (spec 2026-09-30-narrate-out-of-band-design § Failure). */
export type NarrationFailure = 'refused' | 'unparsable' | 'error'

/**
 * What the walkthrough page is built from. The spine is rebuilt from the
 * transcript on every request; the narration fields come from the stored
 * narration. `narration` is the last *finished* run's; `narrationPending`
 * says a newer run is in flight; `narrationFailure` is set exactly when
 * `narrationFailed` is.
 */
export interface Walkthrough {
  steps: WalkthroughStep[]
  timeline: TimelineEntry[]
  files: FileSummary[]
  narration: Narration | null
  narrationFailed: boolean
  narrationPending: boolean
  narrationFailure: NarrationFailure | null
  lastMessageId: string | null
}

/** `GET /api/sessions/:id/walkthrough/summary` — the header's entry control asks this; it is the same parse, smaller answer. */
export interface WalkthroughSummary {
  steps: number
  files: number
  blindAlleys: number
  subagents: number
}

/**
 * One stored transcript image: a pointer the browser turns into an
 * `<img src="/api/images/<ref>">`. `w`/`h` are the stored pixel size so the
 * box can be reserved before decode; null when the server couldn't sniff
 * them.
 */
export interface ImageRefEntry {
  ref: string
  w: number | null
  h: number | null
  bytes: number
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
  value: string
  resolvedModel: string
  family: string
  version: string
  shortVersion: string
  variant: string | null
  blurb: string
  contextWindow: number | null
}

/**
 * `POST /api/models/validate` — whether Claude Code will start on a model id
 * the SDK catalog does not list. `reason` is Claude Code's own sentence.
 */
export type ModelValidation =
  | { ok: true; model: string; resolvedModel: string | null; contextWindow: number | null }
  | { ok: false; model: string; reason: string }

export interface Tag {
  id: number
  name: string
  hue: number
  is_default: 0 | 1
  /**
   * The clump's stored home spot on the map, in world units — written when
   * the user drops a dragged body somewhere new; null (or absent, in old
   * fixtures) means the automatic circle layout places the tag. Both set or
   * both null; a half-set pair falls back to the automatic layout.
   */
  anchor_x?: number | null
  anchor_y?: number | null
}

export interface TagRule {
  id: number
  tag_id: number
  position: number
  enabled: 0 | 1
  condition: 'path_matches' | 'title_contains' | 'permission_is'
  pattern: string
}

/**
 * Mirrors `SubagentInfo` in `server/src/transcript/subagents.ts` —
 * the two must move together.
 */
export interface Subagent {
  id: string
  name: string
  state: 'materializing' | 'working' | 'idle' | 'needs_input' | 'ended'
  /**
   * The `Agent` tool_use this agent was launched from, when the SDK's
   * `task_started` carried one — `task_started.tool_use_id` is optional, so
   * this can be absent even for a real, running agent. It is what joins a
   * moon (or the parent transcript's own `Agent` row) back to its buffer:
   * `subagentMessages(sessionId, toolUseId)` and the
   * `subagent:<sessionId>:<toolUseId>` WS topic both key on it. A moon whose
   * `SubagentInfo` has none of this cannot be opened at all (spec
   * 2026-09-22-subagent-transcript-panel-design.md § 5) — it is decoration,
   * not a broken control.
   */
  toolUseId?: string
  /** Epoch ms when this agent was first seen. */
  startedAt: number
  /**
   * How the agent ended, from the SDK's own `task_notification` — absent
   * while it runs, and still absent if a `background_tasks_changed`
   * retirement closed it out with no notification to read a status from.
   */
  status?: 'completed' | 'failed' | 'stopped'
  /**
   * Epoch ms when this agent ended, stamped by the tracker wherever it sets
   * `state` to `'ended'` — the `task_notification`, the
   * `background_tasks_changed` retirement, and `feed()`'s `tool_result` on
   * the transcript path. Absent while it runs; a resume drops it along with
   * `status`.
   * Frozen at the first end, so the subagent list can show a finished row's
   * duration without opening its buffer (subagent list spec § 3).
   */
  endedAt?: number
}

/** What started a background task: `Bash` or `Monitor`, a `Workflow`, an MCP tool. */
export type BackgroundTaskKind = 'shell' | 'monitor' | 'workflow' | 'mcp'

/**
 * Mirrors `BackgroundTaskInfo` in `server/src/transcript/backgroundTasks.ts`
 * — the two must move together (spec 2026-09-28-background-tasks-design
 * § 2).
 */
export interface BackgroundTask {
  /** The SDK's `task_id` — what the stop and output routes key on. */
  id: string
  kind: BackgroundTaskKind
  label: string
  /** Shells and monitors only: the launching call's `command`. */
  command?: string
  state: 'running' | 'ended'
  /** Once ended; absent when it ended without the SDK saying how — the list's "unknown". */
  status?: 'completed' | 'failed' | 'stopped'
  /** Shells and monitors only, read off the output file's closing line. */
  exitCode?: number
  startedAt: number
  endedAt?: number
  /** The launching call, which the transcript row joins on for `OUTPUT →`. */
  toolUseId?: string
  /** Whether there is an output file to open. */
  hasOutput: boolean
}

/** The body of `GET /api/sessions/:id/tasks/:taskId/output`: the file's tail and the byte range it covers. */
export interface TaskOutputTail {
  text: string
  start: number
  end: number
}

/**
 * The body of `GET /api/sessions/:id/subagents/:toolUseId/messages` — mirrors
 * `SubagentTranscript` in `server/src/transcript/subagents.ts`. `messages` is
 * in publish order; `droppedCount` is how many earlier ones the server's ring
 * buffer evicted to make room, for the panel's TRUNCATED chip (spec
 * `2026-09-22-subagent-transcript-panel-design.md` §§ 3, 9).
 */
export interface SubagentTranscript {
  messages: ChatMessage[]
  droppedCount: number
}

/**
 * The client's cap on an open panel's message list, evicted from the front —
 * the same number and the same rule as the server's ring buffer
 * (`MAX_SUBAGENT_MESSAGES` in `server/src/transcript/subagents.ts`, spec
 * § 3). Restated here rather than fetched because the two workspaces share
 * no runtime code; it is deliberately a copy that must move together, not a
 * client-side policy of its own.
 *
 * Without it the panel's list grew without bound off the WS while the
 * server's stayed at 2 000 — so a long run could render TRUNCATED's "buffer
 * 3,412 steps", a figure the buffer it is reporting on cannot produce.
 */
export const MAX_SUBAGENT_MESSAGES = 2000

export const tagColor = (hue: number) => `oklch(80% 0.13 ${hue})`

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
  session: Pick<ApiSession, 'status' | 'awaitingSubagents' | 'subagents'>,
): number {
  if (session.status !== 'working' || !session.awaitingSubagents) return 0
  return session.subagents.filter((agent) => agent.state !== 'ended').length
}

/**
 * What a session that is only waiting on what it launched is waiting FOR:
 * its running subagents and the kinds of its running background tasks. Both
 * empty whenever the session is doing something of its own, or is not
 * working at all — the same gate as `awaitingSubagentCount`, whose server
 * flag now covers background tasks too (spec 2026-09-28-background-tasks-design
 * § 2, "Working while a task runs").
 */
export interface AwaitedWork {
  agents: number
  tasks: BackgroundTaskKind[]
}

export function awaitedWork(
  session: Pick<ApiSession, 'status' | 'awaitingSubagents' | 'subagents' | 'backgroundTasks'>,
): AwaitedWork {
  if (session.status !== 'working' || !session.awaitingSubagents) return { agents: 0, tasks: [] }
  return {
    agents: session.subagents.filter((agent) => agent.state !== 'ended').length,
    tasks: (session.backgroundTasks ?? []).filter((task) => task.state === 'running').map((task) => task.kind),
  }
}

export const awaitedCount = (work: AwaitedWork): number => work.agents + work.tasks.length

const TASK_NOUNS: Record<BackgroundTaskKind | 'mixed', [string, string]> = {
  shell: ['shell', 'shells'],
  monitor: ['monitor', 'monitors'],
  workflow: ['workflow', 'workflows'],
  mcp: ['MCP task', 'MCP tasks'],
  mixed: ['task', 'tasks'],
}

/**
 * The running tasks as a noun phrase (canvas 26d): one kind is named, mixed
 * kinds are `tasks`. `dropOne` leaves a count of one out (`shell`, not
 * `1 shell`) — the pill's form; the chips always count.
 */
export function taskPhrase(kinds: readonly BackgroundTaskKind[], dropOne: boolean): string {
  if (kinds.length === 0) return ''
  const distinct = new Set(kinds)
  const [one, many] = TASK_NOUNS[distinct.size === 1 ? kinds[0] : 'mixed']
  if (kinds.length === 1) return dropOne ? one : `1 ${one}`
  return `${kinds.length} ${many}`
}

/** The agents as the chips read them: `1 agent`, `2 agents`. */
export const agentPhrase = (count: number): string => (count === 1 ? '1 agent' : `${count} agents`)

/**
 * The readout for a session that is only waiting on what it launched — the
 * map's pill (canvas 26d). Agents first, then tasks, joined by `+`, never
 * more than those two terms; a count of one is dropped, from two it shows
 * (`WAITING FOR 2 AGENTS + SHELL`). The detail row says only `WAITING FOR`
 * and lets its chips carry the nouns.
 */
export function waitingLabel(work: AwaitedWork): string {
  const terms: string[] = []
  if (work.agents > 0) terms.push(work.agents === 1 ? 'agent' : agentPhrase(work.agents))
  if (work.tasks.length > 0) terms.push(taskPhrase(work.tasks, true))
  return `WAITING FOR ${terms.join(' + ')}`.toUpperCase()
}

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
  asksForHuman(session) ? 'NEEDS INPUT' : 'DONE'

/**
 * Whether a parked session is actually blocked on the human — the NEEDS INPUT
 * half of `parkedLabel`, as a boolean, and the test `sessionStateKey` splits
 * NEEDS INPUT from DONE with. The map's "you are being waited for" signals
 * (the amber ripple ring, the breathing dot) follow that key, so a DONE or
 * an interrupted planet goes without both (ADR
 * what-a-session-waits-for-is-a-label). One predicate, so the pill's word
 * and the planet's ring cannot disagree.
 */
export function asksForHuman(session: Pick<ApiSession, 'pendingDecision'>): boolean {
  return Boolean(session.pendingDecision)
}

/**
 * Which of the seven state words a session wears — the one answer every
 * state surface reads (the map pill, the summary line, the sidebar row, the
 * detail chip, the needs-input ripple). How each is drawn lives in
 * `lib/stateStyle.ts`; this only decides which state it is.
 *
 * Most specific first. INTERRUPTED displaces whatever status the session
 * has: a restart cut its turn short, and that is the thing to say. A
 * `needs_input` session splits by WHY it stopped (`parkedLabel`): NEEDS INPUT
 * when something is parked on the human, DONE when the turn merely finished.
 * A `working` session whose work is all happening in its moons is WAITING —
 * labelled so the map does not read as "something is going on here" when the
 * only thing going on is out in orbit.
 */
export type SessionStateKey = 'needs_input' | 'waiting' | 'interrupted' | 'done' | 'working' | 'idle' | 'ended'

export function sessionStateKey(
  session: Pick<ApiSession, 'status' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents' | 'backgroundTasks'>,
): SessionStateKey {
  if (session.interruptedAt) return 'interrupted'
  if (session.status === 'needs_input') return asksForHuman(session) ? 'needs_input' : 'done'
  if (session.status === 'working') return awaitedCount(awaitedWork(session)) > 0 ? 'waiting' : 'working'
  return session.status
}

/**
 * The map's state pill for a session: which state it is and its word, or
 * null when the planet wears none. One function for the pill `Planet` draws
 * and the room the simulation keeps around it.
 *
 * Only the four states that say something the planet's own body does not
 * get a pill: NEEDS INPUT, DONE, INTERRUPTED and WAITING. WORKING, IDLE and
 * ENDED are already told by the planet's pulse, rings and dimming (canvas 24c).
 */
export function statePill(
  session: Pick<ApiSession, 'status' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents' | 'backgroundTasks'>,
): { key: SessionStateKey; label: string } | null {
  const key = sessionStateKey(session)
  switch (key) {
    case 'interrupted':
      return { key, label: 'INTERRUPTED' }
    case 'needs_input':
    case 'done':
      return { key, label: parkedLabel(session) }
    case 'waiting':
      return { key, label: waitingLabel(awaitedWork(session)) }
    default:
      return null
  }
}

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
  session.source === 'terminal' && session.status !== 'ended'

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
export type CommandSource = 'user' | 'project' | 'plugin' | `plugin:${string}` | 'built-in'

/** One row of `GET /api/commands`. */
export interface SlashCommand {
  /** With or without a leading slash; `commandNameSet` normalises it. */
  name: string
  description: string
  source: CommandSource
  /** What the command takes, ghosted after `/name ` in the composer (spec:
   * 2026-09-29-composer-rich-editor-design § 3). */
  argumentHint?: string
}

/** `GET /api/commands/content` — the file behind one catalog command, for the
 * skill viewer (spec: 2026-09-30-skill-preview-design). */
export interface CommandContent {
  name: string
  source: CommandSource
  /** Absolute path of the SKILL.md or command file. */
  path: string
  description: string
  /** The markdown with its frontmatter stripped. */
  body: string
}

/** One row of `GET /api/files/complete`. `size` is absent for directories. */
export interface FileCompletionEntry {
  name: string
  dir: boolean
  size?: number
  /**
   * The row's path relative to the session's cwd, sent ONLY when the row does
   * not live in the directory the typed prefix names — an open editor tab
   * reached by its base name from somewhere else in the tree (spec
   * 2026-09-23-ide-bridge-design § Open files). Absent means the old rule: the
   * prefix's directory part plus `name`.
   */
  path?: string
  /** The file is open in the editor right now. Absent means not. */
  open?: boolean
  /** It is the tab the caret is in — it wears the editor slot's caret bar
   * (canvas `Feature - IDE bridge` 20c). */
  active?: boolean
  /** The caret's line in the active tab, which its mark slot reads (20c). */
  line?: number
}

/**
 * Where an error was caught. The browser posts its own failures to
 * `POST /api/errors` so both sides land in one list. Mirrored in
 * `server/src/types.ts` — the two must move together. See
 * `docs/superpowers/specs/2026-09-17-error-surface-design.md`.
 */
export type ErrorSource = 'server' | 'web'

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
 */
export type ErrorKind =
  | 'session_failed'
  | 'api_request'
  | 'render_crash'
  | 'sessions_healed'
  | 'transcript_gap'
  | 'compaction_failed'
  | 'rewind_refused'
  | 'rewind_failed'

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
  /**
   * Time the sessions spent waiting on the user inside tool calls — questions,
   * plan approvals, permission prompts. Never part of `busyMs` (spec
   * 2026-09-30-human-wait-tools-design).
   */
  humanWaitMs: number
  /** `AskUserQuestion` calls. */
  questionCount: number
  /** `ExitPlanMode` calls. */
  planCount: number
  /** Permission prompts, counted in Orbital-run sessions only. */
  permissionCount: number
  /** Sessions in range whose permission prompts were timed — Orbital-run ones. */
  timedSessionCount: number
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
  /** Beside the day's busy time, never inside it. */
  humanWaitMs: number
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

export type StatsHumanTool = 'AskUserQuestion' | 'ExitPlanMode' | 'permission'

/** One row of the leaderboard's YOU group: a wait on the user, not a tool's time. */
export interface StatsHumanRow {
  tool: StatsHumanTool
  calls: number
  ms: number
  p50Ms: number | null
  /** The permission row's calls per prompted tool; empty for the other two. */
  byTool: Record<string, number>
}

export interface StatsToolLeaderboard {
  slowest: StatsToolRow[]
  mostExpensive: StatsToolRow[]
  /** Never ranked with the tools above. The permission row is absent without an Orbital-run session in range. */
  human: StatsHumanRow[]
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
  toolBreakdown: Record<string, StatsToolStat>
  /** Every human wait, summed — never part of the four categories above. */
  humanWaitMs: number
  /** `AskUserQuestion` and `ExitPlanMode`: their time is the user answering. */
  humanBreakdown: Record<string, StatsToolStat>
  /** Permission waits keyed by the prompted tool; `ms` is the wait, not the tool. */
  permissionBreakdown: Record<string, StatsToolStat>
  /** An Orbital-run session: its permission prompts were timed and cut out of tool time. */
  permissionTimed: boolean
  findings: Array<{ rule: string; evidence: Record<string, unknown> }>
}

export interface StatsToolStat {
  calls: number
  errors: number
  ms: number
  resultChars: number
  buckets: number[]
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
    /** `human`: a question or a plan approval — its `ms` is the user answering. */
    kind: 'local' | 'mcp' | 'subagent' | 'human'
    ms: number
    /**
     * The permission-prompt wait cut out of this call, already gone from `ms`.
     * On an `Agent` call, the waits of the prompts its subagent raised.
     */
    waitMs?: number
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
