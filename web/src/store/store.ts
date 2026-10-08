import { create } from 'zustand'
import { api, ApiError, type EndedSummary } from '../lib/api'
import type { McpjsonDecisions } from '../lib/mcpjson'
import { getSocket } from '../lib/socket'
import { completedAnswers, openQuestion, type AnswerMap } from '../lib/questionCard'
import { isAttachable, promptWithOpenFile, promptWithSelection, selectionId } from '../lib/ideSelection'
import { withViewTransition } from '../lib/viewTransition'
import { focusSession } from '../lib/desktop'
import { MAX_SUBAGENT_MESSAGES } from '../lib/types'
import { EMPTY_OUTPUT, appendOutput, type OutputLines } from '../lib/backgroundTasks'
import { historyEndedOutOfList, withDetailHistory, withHeldHistory } from '../lib/listedHistory'
import { TRANSCRIPT_CHECK_PAGE, transcriptCheckStep } from '../lib/transcriptCheck'
import { ENDED_HIDE_MS } from '../map/transition'
import { REWIND_REFUSED_TOAST } from '../lib/rewind'
import { isListable } from '../lib/harnessSession'
import type { ContextThresholds } from '../lib/usage'
import type { MapStatePills } from '../lib/stateStyle'
import type { LinesMode } from '../lib/branchStatus'
import type {
  ApiSession,
  AttachmentSource,
  ChatMessage,
  ClaudeDirName,
  ErrorRecord,
  ImageRefEntry,
  OrbitalModel,
  PendingDecision,
  PermissionMode,
  RemoteStatus,
  SessionSource,
  SessionStatus,
  SessionHarness,
  HarnessEvent,
  HarnessMessageKind,
  Subagent,
  Tag,
  TagRule,
} from '../lib/types'

// ---------------------------------------------------------------------------
// WS event contracts (server -> client)
// ---------------------------------------------------------------------------

/** Events delivered on the `sessions` topic. */
export type SessionsEvent =
  | { event: 'upsert'; session: ApiSession }
  | { event: 'status'; sessionId: string; status: SessionStatus }
  | { event: 'remove'; sessionId: string }

/** Events delivered on the `session:<id>` topic. */
export type SessionEvent =
  | { event: 'message'; message: ChatMessage }
  /**
   * A slice of a row still being written (spec:
   * 2026-09-24-streaming-output-design § 2). `offset` is where `text` goes
   * in the row; the complete block arrives later as a `message` under the
   * same `id` and replaces the row.
   */
  | {
      event: 'delta'
      id: string
      role: 'assistant' | 'thinking'
      offset: number
      text: string
      model?: string
    }
  | { event: 'status'; status: SessionStatus }
  /** A turn ended. The `usage` payload rides along on the wire but nothing
   * reads it any more — the context gauge is fed by `contextUsedTokens` on
   * the session row (adr: context-usage-has-one-source). What this event is
   * still FOR is the crash flag below and `lastTurnResultAt`. */
  | { event: 'turn_result'; usage: unknown }
  /**
   * The server has rewritten this session's stored stats — whichever of the
   * three cadences did it (ADR `the-stats-row-reads-when-the-stats-are-written`).
   * It carries nothing: what changed is a row in the database, and whoever
   * cares re-reads `GET /api/stats/sessions/:id`.
   */
  | { event: 'stats' }
  /** The session is blocked on a question (spec: 2026-09-20-interactive-decisions-design). */
  | { event: 'decision_pending'; decision: PendingDecision }
  /** It was settled — by this tab, another window, an interrupt, or the session ending. */
  | { event: 'decision_resolved'; decisionId: string }
  /**
   * The transcript's live branch changed under the rows held — a rewind done
   * in the terminal, or an interrupt's dangling call dropped (spec
   * 2026-09-29-rewind-design § Reading the live branch). Nothing to append;
   * the transcript is read again.
   */
  | { event: 'transcript_reset' }
  /**
   * The walkthrough's stored narration changed — a narrate query started or
   * landed (spec 2026-09-30-narrate-out-of-band-design § Storage and state).
   * Carries nothing; an open walkthrough page asks again.
   */
  | { event: 'walkthrough_narration' }
  /**
   * The CLI refused a pending rewind's send: nothing was sent, the hidden
   * messages are back (a `transcript_reset` follows) and the edited text
   * stays as an ordinary draft. `message` is the CLI's own words (spec
   * 2026-09-29-rewind-design § Behaviour 8). Handled by the rewind UI step.
   */
  | { event: 'rewind_refused'; message: string; hiddenCount: number | null }
  /** The session's harness changed (added, updated, or removed). */
  | { event: 'harness'; harness: SessionHarness | null }
  /**
   * Orbital sent this on the harness's account (kickoff, sent on, nudge,
   * findings): the user entry `uuid` is the harness's, a dashed ◆ row and
   * never a bubble. `step` is 0-based (spec 2026-10-02-harness-redesign-design
   * § Session state and the transcript).
   */
  | {
      event: 'harness_message'
      message: { uuid: string; kind: HarnessMessageKind; step: number; text: string; at: number }
    }

/**
 * Events delivered on the `subagent:<sessionId>:<toolUseId>` topic — one
 * `message` per live append to that agent's buffer, mirroring `session:<id>`'s
 * own event exactly (spec: 2026-09-22-subagent-transcript-panel-design.md
 * § 9), and the `delta`s of a block the agent is still writing, shaped as on
 * `session:<id>` (spec: 2026-09-24-streaming-output-design § 1). Nothing
 * else rides this topic: the panel is frozen by its
 * `Subagent.state`/`status` (read live off the parent session — see
 * `SubagentPanel`), not by a WS event, and STREAM LOST is read off the
 * messages fetch's 404, not off anything published here.
 *
 * `droppedCount` is the server's running total for that agent's ring buffer
 * AFTER this append — spec § 3 puts it on the WS increments as well as the
 * REST response, and it is optional here only so a frame published by an
 * older server (or by a `Runner` wired without `subagentTranscripts`) still
 * parses.
 */
export type SubagentEvent =
  | { event: 'message'; message: ChatMessage; droppedCount?: number }
  | (Extract<SessionEvent, { event: 'delta' }> & { droppedCount?: number })

/**
 * Events on a task's `task-output:<sessionId>:<taskId>` topic (spec
 * 2026-09-28-background-tasks-design § 4): the bytes appended to its output
 * file, `offset` being where in the file `text` starts, and `gone` when the
 * file disappears under an open view.
 */
export type TaskOutputEvent = { event: 'output'; offset: number; text: string } | { event: 'gone' }

/**
 * Events delivered on the `errors` topic — the shared error log
 * (`docs/superpowers/specs/2026-09-17-error-surface-design.md`).
 *
 * Every one of them carries `unseen` because the server owns that number:
 * the client holds only the newest page, so counting unstamped rows in
 * `errors` would under-report the moment there is more than one page.
 *
 * `seen.ids` is `null` — not the string `'all'` — for the whole-table case;
 * that is the shape `server/src/errors/log.ts` publishes. Payloads also
 * arrive with the hub's `topic` field merged in, which nothing here reads,
 * the same way `SessionsEvent` ignores it.
 */
export type ErrorsEvent =
  | { event: 'error'; error: ErrorRecord; unseen: number }
  | { event: 'seen'; ids: number[] | null; unseen: number }

/**
 * Events on the `remote` topic (`server/src/remote/service.ts`). A
 * `pair_request` is always followed by a `status` carrying the same request
 * as `pendingPair`, so only `status` is read.
 */
export type RemoteEvent =
  | ({ event: 'status' } & RemoteStatus)
  | { event: 'pair_request'; phone: string; name: string; platform: string; fingerprint: string }

export interface Toast {
  /**
   * `rewind_refused` is the CLI turning down a pending rewind's send (spec
   * 2026-09-29-rewind-design § Behaviour 8; canvas 27c REFUSAL): the 1g toast
   * shell with the errors-log red dot, a Details link to the log, and it stays
   * until dismissed or the next send.
   */
  kind: 'error' | 'info' | 'rewind_refused'
  message: string
  /**
   * One optional action button ("Undo" on an absorption toast). `run` is
   * called on click; the toast is cleared by the caller of `run`, not here.
   */
  action?: { label: string; run: () => void }
  /**
   * `log`: raised by a record arriving on the errors topic (`applyErrorsEvent`),
   * not by a request this client made. The desktop ignores it; the phone shows
   * only its own request failures and leaves these alone.
   */
  source?: 'log'
}

export interface OrbitalUiState {
  selectedId: string | null
  filterTagId: number | 'all'
  search: string
  sourceFilter: 'all' | SessionSource
  wsStatus: string
  dialog: null | 'new' | 'clear' | 'end' | 'stop' | 'settings' | 'errors'
  /**
   * The file the read-only viewer is showing over the app, or null when it
   * is closed (spec: 2026-09-19-file-viewer-design). Plain synchronous UI
   * state like `selectedId` — never persisted; the URL mirror in
   * `lib/sessionUrl.ts` is what survives a reload. The viewer always
   * belongs to the selected session, so `select()`ing a different session
   * closes it.
   *
   * `cwd` is the one the transcript entry the path came from was written in,
   * read against on the server (spec 2026-10-07-live-working-tree-design § 4);
   * absent for a path from anywhere else. The URL does not carry it.
   */
  fileViewer: { path: string; line: number | null; cwd?: string } | null
  /** Sidebar collapsed to its narrow rail (Panel's `collapsed` prop). See Sidebar.tsx (task 10). */
  sidebarCollapsed: boolean
  /**
   * True while the detail panel's drag handle is held. The panel and the
   * map's right-anchored overlays drop their width/right transitions for the
   * duration, so everything tracks the pointer 1:1 instead of easing 420ms
   * behind it. Optional — absent means false.
   */
  resizingPanel?: boolean
  /**
   * Bumped by `revealHistory()` (clicking the map's hole). The sidebar
   * scrolls its HISTORY heading into view on each bump — a counter rather
   * than a flag, so two clicks in a row both land. Optional — absent means
   * never revealed.
   */
  historyRevealNonce?: number
  /**
   * Set once by `lib/sessionUrl.ts` when the `?session=` restore has settled
   * (immediately, when the URL names nothing to restore). Until then the page
   * has not finished deciding what is open, so the map's fit-on-load waits
   * for it: fitting first and letting the deep link's detail panel open over
   * the result is how the sessions end up under a panel again. Optional —
   * absent means the restore is still in flight.
   */
  urlRestored?: boolean
}

/** How many of the newest error rows the log holds at a time. */
export const ERROR_PAGE_SIZE = 50

/**
 * The one subagent panel the app can have open (task 7 brief: "One slot:
 * opening a second agent swaps the contents"). `sessionId` is the PARENT
 * session's id — the panel is read-only and everything it needs to join back
 * to the parent (its transcript's `OPEN →` row, `QuestionCard`'s decision
 * lookup) keys off that, never off the agent's own id.
 *
 * `found` is what carries the 404-vs-empty-200 distinction the whole design
 * hinges on: `subagentMessages` 404s when the server no longer knows this
 * agent at all (a restart dropped the buffer — STREAM LOST) and 200s with an
 * empty `messages` array when the agent is known and has simply not said
 * anything yet (an ordinary running panel with nothing to show yet). Both
 * leave `messages` empty, so `found` is the only field that tells them apart
 * — collapsing the two into "empty means empty" is the one mistake the brief
 * calls out by name.
 */
export interface OpenSubagentState {
  sessionId: string
  subagent: Subagent
  messages: ChatMessage[]
  droppedCount: number
  found: boolean
}

/**
 * The one open output view (canvas 26b). It shares the side slot with the
 * subagent panel: opening either closes the other (spec § 3).
 *
 * `end` is the byte offset the text so far reaches — a delta starting below
 * it is already here, in whole or in part. `pending` holds the deltas that
 * arrive while the tail fetch is in flight, folded in once it lands.
 */
export interface OpenTaskOutputState {
  sessionId: string
  taskId: string
  phase: 'loading' | 'ready' | 'gone'
  output: OutputLines
  end: number
  pending: { offset: number; text: string }[]
}

export interface OrbitalState {
  sessions: Record<string, ApiSession>
  order: string[]
  tags: Tag[]
  rules: TagRule[]
  models: OrbitalModel[]
  /** The server's measured wire-id → context-window map, served beside the
   * catalog — the exact-id fallback denominator for a session whose resolved
   * model matches no catalog row (fix: revived-session-shows-no-context-gauge). */
  contextWindows: Record<string, number>
  /**
   * The configured Claude directories, names only, and the two the New
   * session choice falls back to — read once from `GET /api/sessions/defaults`,
   * the one route both the Mac and the phone may use (spec
   * 2026-10-04-multiple-claude-directories-design § 7). Every directory label
   * reads its name from here; with fewer than two nothing is labelled.
   */
  claudeDirs: ClaudeDirName[]
  defaultClaudeDir: number | null
  lastClaudeDir: number | null
  settings: Record<string, string>
  transcripts: Record<string, ChatMessage[]>
  /** Tracks which sessions have had their initial message history fetched, so
   * `select()` only ever fetches once per session regardless of how many
   * live messages have already arrived over the WS for that session. */
  historyLoaded: Record<string, boolean>
  /** Sessions that transitioned `working` -> `idle` on the `session:<id>`
   * topic without an intervening `turn_result` — the "SDK process crash"
   * error state from the spec (`docs/superpowers/specs/2026-09-15-orbital-design.md`
   * § Error states). `Transcript` renders an error row when a session's
   * flag here is set. See `turnResultSeen` below for how it's derived. */
  transcriptErrors: Record<string, boolean>
  /**
   * When each session last completed a turn normally, as this tab observed
   * it. The timestamp form of the `turnResultSeen` flag below, and kept for
   * the same reason it clears `transcriptErrors`: a session that crashed,
   * was revived and then ran cleanly must stop showing its old failure. The
   * flag cannot answer that for the *recorded* error, which outlives the
   * live transition — a timestamp can, by saying the crash is older than the
   * last good turn. Empty after a reload, where `lastAt` takes over.
   */
  lastTurnResultAt: Record<string, number>
  /**
   * How many times each session's stored stats have been reported rewritten
   * since this tab subscribed to it. A counter rather than the numbers
   * themselves: the `stats` event says only that the row changed, and the
   * detail panel's stats row re-reads the endpoint when this moves.
   */
  statsRevision: Record<string, number>
  /**
   * The newest page of the shared error log, newest first. Only a page —
   * `errorsUnseen` is therefore NOT derivable from it.
   */
  errors: ErrorRecord[]
  /**
   * Unread errors as the SERVER counts them, across the whole table. Taken
   * from whatever payload last reported it (`listErrors`, an `errors` WS
   * event, a `markErrorsSeen` response) and never recomputed from `errors`.
   */
  errorsUnseen: number
  /**
   * The mobile remote (spec 2026-10-01-settings-mobile-design § 1). Null
   * until `GET /api/remote` lands; nothing renders a pairing state from null.
   * `pendingPair` set is what puts the pairing dialog up, wherever the user is.
   */
  remote: RemoteStatus | null
  /**
   * The question each session is blocked on right now, keyed by session id
   * (spec: 2026-09-20-interactive-decisions-design). A session has at most
   * one — the SDK blocks on the `canUseTool` promise, so there is nothing to
   * queue behind it.
   */
  pendingDecisions: Record<string, PendingDecision>
  /**
   * Answers collected so far, keyed by DECISION id (which is the
   * `AskUserQuestion` tool_use's `toolUseId`). Two jobs in one map:
   *
   * - while the card is pending it holds the partial answers of a 2–4
   *   question card, which is what `activeQuestionIndex` gates the next
   *   question on;
   * - after the POST it is what the card renders its answered form from,
   *   which is how the card flips over "before the next agent token arrives"
   *   (canvas 9d) instead of waiting for the `tool_result` to come back.
   *
   * Kept past `decision_resolved` for exactly that reason, and never
   * persisted: on the next reload the `tool_result` is the answer's home.
   */
  decisionAnswers: Record<string, AnswerMap>
  /**
   * The verdict this tab sent for a `permission` or `plan` decision, keyed by
   * DECISION id — what `decisionAnswers` is for a question, and kept for the
   * same reason: the card flips to its settled form on the click rather than
   * on the round trip. It also holds the refusal's reason, which is the one
   * thing the transcript never gets back (the model sees it; the tool_result
   * the client reads carries only the error flag).
   */
  decisionVerdicts: Record<string, { approved: boolean; message?: string }>
  /**
   * The editor selection each session has dismissed, keyed by SESSION id and
   * holding the dismissed selection's id (spec
   * 2026-09-23-ide-bridge-design § Behaviour).
   *
   * Per session on purpose, even though the selection belongs to the
   * workspace and every session in it sees the same one: × is a statement
   * about *this* conversation — that the selection is not relevant to what is
   * being asked here. Clearing it for the other sessions would make one
   * panel's housekeeping reach into another's.
   *
   * It needs no clearing pass. The id is file + range + text, so the moment
   * the selection changes the stored id stops matching and the lip comes
   * back on its own.
   */
  ideDismissed: Record<string, string>
  /**
   * What is typed in each session's composer and not yet sent, by session
   * id. In the store rather than the detail panel so that switching to
   * another session — to answer its question, say — and back finds the
   * half-written message where it was left. Memory only: a reload loses it.
   * An empty draft is not kept.
   */
  composerDrafts: Record<string, string>
  /**
   * Sessions whose pending rewind this tab has just sent (spec
   * 2026-09-29-rewind-design § Behaviour 7). The server keeps the row pending
   * until the CLI takes the truncating resume, so the session goes on carrying
   * `rewindPending` for a moment after Send; the panel reads this to stop
   * showing the strip and the end marker the moment the text goes out. Cleared
   * when the row arrives without `rewindPending`, on a refusal, or when the
   * send itself fails.
   */
  rewindSending: Record<string, true>
  /**
   * Sessions whose detail panel lives in its own desktop window right now
   * (spec: 2026-09-23-detached-session-windows-design). The desktop main
   * process owns the list and pushes it whole; only the main window ever
   * receives it, so a detached window's own list stays empty.
   */
  detachedIds: string[]
  /**
   * How many sessions the whole index holds — the hole's label subtracts
   * the drawn planets from this (spec 2026-09-18-tag-clusters-design § 4).
   * Seeded by `GET /api/sessions/count` at load, then tracked off the
   * `sessions` WS topic (an upsert of an unknown id is a new row).
   */
  sessionsTotal: number
  /**
   * When each session started leaving the map, as this tab saw it — the
   * moment it stopped holding a place there (`holdsMapPlace`): it ended, or
   * an ended session lost its pin. `absorptionFor` keeps such a session in
   * the scene for `MAP_LEAVE_GRACE_MS` past this so its fade can play where
   * it stands (spec 2026-09-24-sessions-end-only-by-hand-design § 3).
   * Client-side on purpose: the server says a session is ended, not when
   * this tab last drew it. Empty after a reload, where every ended,
   * unpinned session is simply not drawn.
   */
  leavingSince: Record<string, number>
  toast: Toast | null
  ui: OrbitalUiState
  /** The one open subagent panel, or null — see `OpenSubagentState`. */
  subagentPanel: OpenSubagentState | null
  /** The one open task output view, or null — see `OpenTaskOutputState`. */
  taskOutput: OpenTaskOutputState | null
  /**
   * Tasks whose stop was sent and not yet confirmed, keyed
   * `<sessionId>:<taskId>`: the row keeps its place in RUNNING until the SDK
   * says the task ended (spec § 3), and shows the stop as pending meanwhile.
   */
  stoppingTasks: Record<string, true>
  /**
   * Each session's harness if it has one running, keyed by session id.
   * null means no harness, undefined means not yet fetched.
   */
  harnesses: Record<string, SessionHarness | null | undefined>
  /** Each session's harness log, newest first, as last fetched. */
  harnessEvents: Record<string, HarnessEvent[]>
  /** The log has older pages than `harnessEvents` holds (`loadOlderHarnessEvents`). */
  harnessEventsMore: Record<string, boolean>
  /**
   * Each session's removed harness, kept for its records (session stats →
   * Harness), or null; undefined until `loadHarness` has read it.
   */
  harnessRemoved: Record<string, SessionHarness | null | undefined>
  /**
   * The Harness panel in the side slot, which it shares with the subagent
   * panel and the task output view (spec 2026-09-30-session-harness-design § UI).
   */
  /** `full`: opened straight into the full window (⌥-click on the pill, canvas 30h). */
  harnessPanel: { sessionId: string; full?: boolean } | null
  /**
   * Where Settings → Harness templates should start, set by the harness
   * panel's links (canvas 30c "both open Settings → Harness templates · scope
   * pre-set to <project>", 30f "Open template in Settings"). Settings reads
   * and clears it; null when nothing asked.
   */
  harnessTemplatesFocus: HarnessTemplatesFocus | null
}

export interface HarnessTemplatesFocus {
  /** Filter and new-template scope pre-set to this project. */
  project?: { root: string; name: string }
  /** Open the "Draft with the assistant…" popover. */
  draft?: boolean
  /** Open this template in the editor. */
  templateId?: number
}

/**
 * One uploaded attachment as the send path takes it: the stored entry (which is
 * all the server needs — `sendPrompt` posts the refs) plus the provenance only
 * this client knows, which rides along onto the optimistic turn and becomes the
 * transcript caption (spec: 2026-09-20-composer-design § The transcript side).
 */
export interface SentAttachment {
  entry: ImageRefEntry
  name: string
  source: AttachmentSource
}

export interface OrbitalActions {
  loadInitial(): Promise<void>
  /**
   * Seats a full session list as the authoritative snapshot — what
   * `loadInitial` does with its sessions — for a caller that has only the
   * list and the tags: the phone, from its cache or over the tunnel, where
   * `loadInitial`'s settings, rules and errors routes are not allowed (spec
   * 2026-10-02-mobile-app-design § 3).
   */
  seatSessions(sessions: ApiSession[], tags: Tag[]): void
  /**
   * The phone's `loadInitial`: sessions, tags and the model catalog, each a
   * route the tunnel allows. The list leaves the ENDED fold out
   * (`ended: 'exclude'`) unless `endedToo`, which reads it alongside and seats
   * both at once. Resolves to what the Mac said about the fold it left out,
   * or null from a Mac that sent every session anyway.
   */
  loadSessions(opts?: { endedToo?: boolean }): Promise<EndedSummary | null>
  /**
   * Adds sessions to the ones held, without replacing the map the way
   * `seatSessions` does: the phone's ENDED fold, read when it is opened.
   */
  mergeSessions(sessions: ApiSession[]): void
  /**
   * The session's whole history — every subagent and background task it has
   * had, ended included — from `GET /api/sessions/:id`, folded into what the
   * store holds (`withDetailHistory`). The list and its upserts carry only
   * what runs. A session the store does not hold at all (an ended one the
   * phone's list left out, opened from a notification) is added as it comes.
   */
  loadSessionHistory(id: string): Promise<void>
  /** Reads the directory names and the dialog's two fallbacks again (`claudeDirs` above). Best-effort. */
  loadClaudeDirs(): Promise<void>
  /**
   * The catch-up after the socket was away (spec:
   * 2026-09-22-ws-reconnect-resync-design). Nothing is replayed over the WS,
   * so every event published during the outage is only recoverable over REST.
   */
  resyncAfterReconnect(): Promise<void>
  /**
   * One run of the transcript check (spec 2026-09-28-transcript-check-design):
   * compares the open transcript with its file's tail and, when a row has
   * been missing for two checks running, reloads it from the file and logs a
   * `transcript_gap`. Driven by `useTranscriptCheck`.
   */
  checkTranscript(id: string): Promise<void>
  /**
   * Replaces the held transcript with the file's, keeping a turn typed a
   * moment ago that the file has not echoed yet. Nothing happens for a
   * transcript whose history is not seated.
   */
  reloadTranscript(id: string): Promise<void>
  applySessionsEvent(msg: SessionsEvent): void
  /**
   * The socket's way in for the `sessions` topic: events that arrive within
   * one animation frame land in the store as ONE write, where each used to
   * notify every subscriber on its own (fix
   * a-reopened-session-shows-the-transcript-it-was-left-with). Everything
   * else that applies a sessions event wants it applied now, and calls
   * `applySessionsEvent`.
   */
  queueSessionsEvent(msg: SessionsEvent): void
  applySessionEvent(sessionId: string, msg: SessionEvent): void
  applyErrorsEvent(msg: ErrorsEvent): void
  markErrorsSeen(target: number[] | 'all'): Promise<void>
  /** A `status` replaces the whole object; a `pair_request` is left to the `status` after it. */
  applyRemoteEvent(msg: RemoteEvent): void
  /** Stores a status the caller just got from the server. */
  setRemote(status: RemoteStatus): void
  /**
   * Re-reads `GET /api/remote` — on every socket open, and from the pairing
   * dialog when its request may have expired (the server clears an expired
   * request only inside a `status()`, and publishes nothing on expiry).
   * The answer is dropped if a status arrived while it was in flight: that
   * one is newer. Never throws; answers what became of the read, so a caller
   * waiting on the server's answer knows whether it got one.
   */
  refreshRemote(): Promise<'stored' | 'superseded' | 'failed'>
  launchSession(body: {
    cwd: string
    prompt: string
    permissionMode: PermissionMode
    tagId?: number
    model?: string
    /** Image refs the dialog's first turn carries (spec: 2026-09-20-composer-design). */
    attachments?: string[]
    /** The phone asks the route to check the directory first (`api.createSession`). */
    requireDirectory?: boolean
    /** The Claude directory to run under; omitted, the server's default (`api.createSession`). */
    claudeDirId?: number
    /** The `.mcp.json` question's answers (`api.createSession`); omitted, undecided servers stay out. */
    mcpjson?: McpjsonDecisions
  }, images?: readonly SentAttachment[]): Promise<string>
  select(id: string): Promise<void>
  loadOlder(id: string): Promise<ChatMessage[] | null>
  sendPrompt(id: string, text: string, attachments?: readonly SentAttachment[]): Promise<void>
  /**
   * Records one question's answer on the session's pending decision and,
   * once every question has one, POSTs the complete record. The card and the
   * composer share this one door — clicking an option, confirming a
   * multiSelect and typing into the composer differ only in the string they
   * arrive with.
   */
  answerQuestion(sessionId: string, question: string, answer: string): void
  /**
   * Settles the session's pending `permission` or `plan` decision — the
   * verdict path, and a no-op on a question, which is answered in words
   * (spec 2026-09-23-permission-and-plan-decisions-design § Answering).
   */
  resolveDecision(sessionId: string, verdict: { approved: boolean; message?: string }): void
  /**
   * Drops the editor selection from THIS session's composer (the lip's ×).
   * `selectionId` is what the lip was standing over; a later selection has a
   * different one and raises the lip again by itself.
   */
  dismissIdeSelection(sessionId: string, selectionId: string): void
  setComposerDraft(sessionId: string, text: string): void
  setFilterTag(filterTagId: number | 'all'): void
  setSearch(search: string): void
  setSourceFilter(sourceFilter: 'all' | SessionSource): void
  /** Pins (or unpins) a session — a pinned session stays on the map once it has ended. */
  setSessionPinned(id: string, pinned: boolean): Promise<void>
  /**
   * Ends a session dropped on the map's trash (spec
   * 2026-09-24-sessions-end-only-by-hand-design § 3), and takes its pin with
   * it. Optimistic; rolls back and rejects when a request fails, so the caller
   * reports it (and the confirm dialog stays open). `undo` raises the toast
   * whose Undo is `reopenSession`.
   */
  trashSession(id: string, opts: { undo: boolean }): Promise<void>
  /**
   * The trash's Undo: takes the End back (`POST …/reopen`) and, when the drop
   * took a pin, puts the pin back. Optimistic; a failure rolls back and
   * reports through the toast.
   */
  reopenSession(id: string, repin: boolean): Promise<void>
  /**
   * Ends a session Orbital runs (spec 2026-09-23-end-session-design). Nothing
   * is written here: the server publishes the `ended` status on the
   * `sessions` topic like any other. Rejects when the request fails, so the
   * confirm dialog can stay open and report it.
   */
  endSession(id: string): Promise<void>
  /** Moves (or, with null, clears) a tag clump's stored home on the map. */
  setTagAnchor(tagId: number, anchor: { x: number; y: number } | null): Promise<void>
  /** The hole's click: un-collapse the sidebar and scroll it to HISTORY. */
  revealHistory(): void
  setDialog(dialog: OrbitalUiState['dialog']): void
  /**
   * Takes the detached list the desktop app pushed. A selected session that
   * is now in it leaves the docked panel — one place per session.
   */
  setDetached(ids: string[]): void
  /** Opens the file viewer over the selected session. `line` is the `:line`
   * scroll target a path button carried, absent for a bare path; `cwd` the
   * transcript entry's, when the path came from one. */
  openFile(path: string, line?: number | null, cwd?: string): void
  closeFile(): void
  /**
   * Opens a path in the editor covering the selected session's workspace —
   * the modifier's meaning, not the click's (spec
   * 2026-09-23-ide-bridge-design § Talking back to the editor).
   *
   * Answers whether the editor took it, so the pressed control can show its
   * receipt. Never throws and never raises a toast: with no editor there is
   * nothing to report, only nothing to show.
   */
  openInIde(path: string, line?: number | null): Promise<boolean>
  setSidebarCollapsed(sidebarCollapsed: boolean): void
  setWsStatus(wsStatus: string): void
  clearToast(): void
  /**
   * Opens the subagent panel on one agent: fetches its buffer, subscribes to
   * its live topic, and replaces whatever agent was open before — one slot,
   * so the previous subscription is always released first (task 7 brief). A
   * leaked subscription here is a real bug, not a tidiness point.
   *
   * `sessionId` is the PARENT session's id, `subagent` is one entry off that
   * session's own `subagents` array — the moon or the parent transcript's
   * `OPEN →` row hands this straight through, never a copy.
   */
  openSubagent(sessionId: string, subagent: Subagent): Promise<void>
  /** Releases the live subscription (if any) and clears the panel. Safe to
   * call when nothing is open. */
  closeSubagent(): void
  /**
   * Applies one live message off an open agent's `subagent:<sessionId>:<toolUseId>`
   * topic. Exposed as its own action — like `applySessionEvent` — so the
   * dedupe/staleness rules are testable without going through a real socket.
   */
  applySubagentEvent(sessionId: string, toolUseId: string, msg: SubagentEvent): void
  /** Opens a shell's or monitor's output in the side slot, closing whatever held it. */
  openTaskOutput(sessionId: string, taskId: string): Promise<void>
  /** Releases the output subscription and clears the view. Safe when nothing is open. */
  closeTaskOutput(): void
  /** Reads a session's harness and its log into `harnesses` / `harnessEvents`. */
  loadHarness(sessionId: string): Promise<void>
  /** Reads the next older page of the session's harness log, if there is one. */
  loadOlderHarnessEvents(sessionId: string): Promise<void>
  /** Opens the Harness panel on this session, or closes it when it is already open on it. */
  openHarness(sessionId: string, opts?: { full?: boolean }): void
  closeHarness(): void
  /** Opens Settings on Harness templates with `focus` for it to read. */
  openHarnessTemplates(focus: HarnessTemplatesFocus): void
  /** Applies one event off the open view's `task-output:` topic. */
  applyTaskOutputEvent(sessionId: string, taskId: string, msg: TaskOutputEvent): void
  /** Stops a background task or a subagent by its task id. */
  stopTask(sessionId: string, taskId: string): Promise<void>
}

export type OrbitalStore = OrbitalState & OrbitalActions

let localMessageCounter = 0

/**
 * Whether the socket has been seen `closed` since it was last `open`. It is
 * what tells a reconnect apart from the first connection: the page's opening
 * `connecting -> open` is not an outage and must not trigger the catch-up.
 */
let sawClosedSocket = false

/** Per session, the file row the last transcript check found missing. */
const transcriptSuspects = new Map<string, ChatMessage>()
/** Sessions with a transcript check in flight — a slow read must not stack. */
const transcriptChecking = new Set<string>()

/** One page of a session's harness log — the server's ceiling (`MAX_EVENTS_PAGE`). */
const HARNESS_EVENTS_PAGE = 2000
/** Sessions whose older harness log is being read now, so a re-render does not ask twice. */
const harnessEventsPaging = new Set<string>()

/** Generates a client-side id for optimistic messages. Prefixed so it can
 * never collide with a server-issued message id. */
function nextLocalMessageId(): string {
  localMessageCounter += 1
  return `local:${Date.now()}:${localMessageCounter}`
}

/**
 * The user's own turn as the transcript shows it until the transcript file
 * says otherwise. Needed because the Runner never publishes a user's turn:
 * the SDK is not asked to replay stdin, so the only user frames it streams
 * back are tool results. Both ways a turn leaves this tab go through here —
 * `sendPrompt` and the New Session dialog's first prompt in `launchSession`.
 */
function optimisticTurn(text: string, attachments?: readonly SentAttachment[]): ChatMessage {
  const images = attachments?.map((a) => a.entry)
  return {
    id: nextLocalMessageId(),
    role: 'user',
    text,
    timestamp: new Date().toISOString(),
    // Absent, not empty, for a text-only turn: `MessageView` reads
    // `images.length` to decide whether a turn has a thumbnail row, and an
    // empty array on every plain message would be noise in every fixture.
    ...(images && images.length > 0
      ? {
          images,
          imageProvenance: Object.fromEntries(
            attachments!.map((a) => [a.entry.ref, { name: a.name, source: a.source }]),
          ),
        }
      : {}),
  }
}

/**
 * One message's images as a comparable key — sorted, so the order a turn's
 * blocks came back in is not part of the match. Empty string for a turn with
 * no images, which is what makes a text-only echo fail to match a pending turn
 * that carried one.
 */
function imageRefKey(images: readonly ImageRefEntry[] | undefined): string {
  if (!images || images.length === 0) return ''
  return images
    .map((image) => image.ref)
    .slice()
    .sort()
    .join('\0')
}

/**
 * The text typed for a pending rewind's send, by session, until the send is
 * settled. Not store state: nothing renders it; the refusal reads it to put
 * the words back in the composer as an ordinary draft (spec
 * 2026-09-29-rewind-design § Behaviour 8). What was typed, not what was sent —
 * an editor selection riding along is not part of the draft.
 */
const rewindSentText: Record<string, string> = {}

/** A copy of `record` without `key`. */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

/** Whether `message` is a user turn this tab appended optimistically and the
 * transcript file has not echoed back yet. */
export function isPendingTurn(message: ChatMessage): boolean {
  return message.id.startsWith('local:') && message.role === 'user'
}

/**
 * Whether `echo` is the transcript's copy of the optimistic `pending` turn:
 * the same trimmed text AND the same image refs. The refs are part of the
 * match because text alone stopped being distinguishing once a turn could be
 * image-only: two pasted screenshots are two turns with identical (empty)
 * text, and matching on text would have the second echo overwrite the first
 * bubble. The store is content-addressed, so same bytes mean the same ref on
 * both sides — there is nothing to normalise (spec: 2026-09-20-composer-design
 * § Store + wire).
 */
function echoes(echo: ChatMessage, pending: ChatMessage): boolean {
  return (
    echo.role === 'user' &&
    (echo.text ?? '').trim() === (pending.text ?? '').trim() &&
    imageRefKey(echo.images) === imageRefKey(pending.images)
  )
}

/**
 * Non-reactive bookkeeping (not store state — nothing needs to re-render off
 * this changing, only off the `transcriptErrors` flag it feeds) tracking
 * whether the session's current turn has already produced a `turn_result`.
 *
 * Three states, and the third is the one that matters:
 *
 * - `false` — this tab watched the turn start (a `status` event reporting
 *   `working`) and has not seen it resolve. An `idle` now means the process
 *   went away without the turn ever resolving: the SDK process crash error
 *   state. (A crash no longer ends a session — only the user does — so the
 *   session lands `idle`, not `ended`; spec
 *   2026-09-24-sessions-end-only-by-hand-design § 1. An `ended` mid-turn is
 *   the user's End, which is no crash.)
 * - `true` — a `turn_result` arrived. The turn resolved; not a crash.
 * - `undefined` — no entry, because this tab never saw this session start a
 *   turn at all. Its `working` transition happened before the app subscribed
 *   to its `session:<id>` topic (it was already `working` at `loadInitial()`
 *   time). We have no evidence either way, and absence of evidence is not a
 *   crash — so an `idle` for such a session is left alone.
 *
 * Hence the crash check tests for an explicit `false` rather than for
 * falsiness: `!undefined` would accuse a session this tab never watched of a
 * failure that most likely never happened
 * (`docs/fixes/a-session-already-working-at-mount-reads-as-crashed.md`).
 */
const turnResultSeen: Record<string, boolean | undefined> = {}

/**
 * Where the next `delta` of a streaming row should start — the length of
 * everything applied to it so far, by row id. Non-reactive bookkeeping like
 * `turnResultSeen`: nothing renders off it, it only decides whether a delta
 * is new (offset here), a duplicate (behind it) or a mid-stream join (ahead
 * of it, on a row this tab never saw the head of). Dropped when the row is
 * finalised (adr: streamed-text-rides-as-offset-deltas-on-the-rows-id).
 */
const streamEnds: Record<string, number> = {}

/** Lets go of the stream bookkeeping of whatever partial rows `rows` holds. */
function forgetStreamEnds(rows: readonly ChatMessage[]): void {
  for (const m of rows) if (m.partial) delete streamEnds[m.id]
}

/**
 * `sessions`-topic events waiting for the next frame (`queueSessionsEvent`),
 * and the frame and fallback timer that will flush them.
 */
let queuedSessionsEvents: SessionsEvent[] = []
let sessionsFlush: { frame: number; timer: ReturnType<typeof setTimeout> } | null = null

/**
 * How long a queued sessions event may wait when no frame comes — a hidden
 * window draws none. Long enough that a visible window always flushes on its
 * frame first.
 */
const SESSIONS_FLUSH_FALLBACK_MS = 100

/**
 * Unsubscribe functions for the `session:<id>` topics `launchSession` opened
 * before their session existed.
 *
 * App also subscribes to whichever session is selected, and these overlap with
 * that on purpose: `OrbitalSocket.subscribe` is refcounted and carries several
 * handlers per topic, so both live side by side and each releases
 * independently. A message delivered twice is harmless — the transcript
 * reducer dedups by message id, and `status`/`turn_result` are idempotent.
 *
 * Released when the session goes `idle` or `ended` — its first turn is over,
 * and the process that answered it has let go (a sleeping or crashed session
 * reads `idle`, spec 2026-09-24-sessions-end-only-by-hand-design § 1). What
 * follows is sent from the detail panel, whose own subscription carries it.
 */
const launchSubscriptions = new Map<string, () => void>()

function releaseLaunchSubscription(sessionId: string): void {
  const release = launchSubscriptions.get(sessionId)
  if (!release) return
  launchSubscriptions.delete(sessionId)
  release()
}

/**
 * `launchSession`'s subscribe-before-POST for a session another route starts
 * (the harness drafting conversation, `POST /api/harness/interview`). Call it
 * with the browser-minted id before the request; the returned function undoes
 * it when the request fails. Released like a launch's, on `idle` or `ended`.
 */
export function holdLaunchSubscription(sessionId: string): () => void {
  launchSubscriptions.set(
    sessionId,
    getSocket().subscribe(`session:${sessionId}`, (msg: SessionEvent) =>
      useOrbital.getState().applySessionEvent(sessionId, msg),
    ),
  )
  return () => releaseLaunchSubscription(sessionId)
}

/**
 * The live subscription behind the ONE open subagent panel. Unlike
 * `launchSubscriptions` above (keyed per session, because several launches
 * can be in flight at once) this needs no key: `subagentPanel` is a single
 * slot (task 7 brief), so there is never more than one of these live at a
 * time. Set at the top of `openSubagent`, after releasing whatever this held
 * before — releasing first, not last, is what stops a second agent's
 * subscribe from ever overlapping the first's for even a beat, which would
 * let the old topic's messages land in the new agent's list.
 */
let subagentSubscriptionRelease: (() => void) | null = null

function releaseSubagentSubscription(): void {
  if (!subagentSubscriptionRelease) return
  const release = subagentSubscriptionRelease
  subagentSubscriptionRelease = null
  release()
}

/**
 * The live subscription behind the one open task output view — a single
 * slot, released before any new subscribe, like the subagent panel's.
 */
let taskOutputSubscriptionRelease: (() => void) | null = null

function releaseTaskOutputSubscription(): void {
  if (!taskOutputSubscriptionRelease) return
  const release = taskOutputSubscriptionRelease
  taskOutputSubscriptionRelease = null
  release()
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder()

/**
 * Folds one appended chunk into the view. Offsets are the file's BYTES, so
 * a chunk that overlaps what the view holds is cut in bytes before it is
 * decoded. `null` for a chunk that starts past the view's end: bytes in
 * between were never seen, and the caller reads the tail again.
 */
function foldOutputDelta(
  view: OpenTaskOutputState,
  delta: { offset: number; text: string },
): OpenTaskOutputState | null {
  const bytes = utf8Encoder.encode(delta.text)
  const deltaEnd = delta.offset + bytes.length
  if (deltaEnd <= view.end) return view
  if (delta.offset > view.end) return null
  const fresh = delta.offset === view.end ? delta.text : utf8Decoder.decode(bytes.subarray(view.end - delta.offset))
  return { ...view, output: appendOutput(view.output, fresh), end: deltaEnd }
}

/**
 * Marks the named rows as seen (`null` meaning every row), leaving
 * already-stamped rows on their original timestamp — the server's `markSeen`
 * never rewrites `seen_at` either, so re-opening the log must not make the
 * client disagree with it about when a row was first shown.
 */
/**
 * The slice mirrors the server's list, which is an unread inbox — so a row
 * marked seen does not get a stamp here, it leaves. `null` means all of them,
 * matching the `'seen'` event's whole-table shape.
 */
function dropSeen(errors: ErrorRecord[], ids: number[] | null): ErrorRecord[] {
  if (ids === null) return []
  const seen = new Set(ids)
  return errors.filter((error) => !seen.has(error.id))
}

/**
 * Adopts the pending decision a session snapshot carries — the reload path,
 * and the one that puts the question back after a refresh.
 *
 * Deliberately ADD-ONLY: a snapshot whose `pendingDecision` is null does not
 * clear a decision this tab already knows about. An upsert is published for
 * every kind of session activity, and one published by a path that does not
 * refresh the field would otherwise silently un-ask a live question. The
 * three things that legitimately end a decision all say so explicitly —
 * `decision_resolved`, a 404 from the POST, and `loadInitial`'s full
 * snapshot rebuild.
 */
function seedDecision(
  state: Pick<OrbitalState, 'pendingDecisions'>,
  session: ApiSession,
): Partial<OrbitalState> {
  const decision = session.pendingDecision
  if (!decision) return {}
  if (state.pendingDecisions[session.id]?.id === decision.id) return {}
  return { pendingDecisions: { ...state.pendingDecisions, [session.id]: decision } }
}

function sortIdsByLastAtDesc(sessions: Record<string, ApiSession>): string[] {
  return Object.values(sessions)
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
    .map((s) => s.id)
}

const initialUiState: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  wsStatus: 'connecting',
  dialog: null,
  fileViewer: null,
  sidebarCollapsed: false,
}

/** How long the trash's toast (and its Undo) stays up. Canvas 4a: "Undo 10 s". */
export const UNDO_TOAST_MS = 10_000

/**
 * The trailing half of `leavingSince`: stamps the session the moment it
 * stops holding a place on the map, and never otherwise. Covers every way
 * that can happen — a status event, an upsert (another window unpinning),
 * the trash's own optimistic write — through one comparison of before and
 * after rather than a rule per path.
 */
function leavingStamp(
  state: Pick<OrbitalState, 'leavingSince'>,
  before: ApiSession | undefined,
  after: ApiSession,
): Partial<Pick<OrbitalState, 'leavingSince'>> {
  if (!before || !holdsMapPlace(before) || holdsMapPlace(after)) return {}
  return { leavingSince: { ...state.leavingSince, [after.id]: Date.now() } }
}

/** One session's optimistic write, as a `set` updater's result — a no-op for an id no longer held. */
function withSessionPatch(
  state: Pick<OrbitalState, 'sessions' | 'leavingSince'>,
  id: string,
  fields: Partial<ApiSession>,
): Partial<Pick<OrbitalState, 'sessions' | 'leavingSince'>> {
  const current = state.sessions[id]
  if (!current) return {}
  const next = { ...current, ...fields }
  return { sessions: { ...state.sessions, [id]: next }, ...leavingStamp(state, current, next) }
}

/**
 * How many messages a transcript fetch asks for; undefined leaves it to the
 * server's default, as the desktop always has. The phone sets
 * `TRANSCRIPT_PAGE_SIZE` (spec 2026-10-02-mobile-app-design § 5): one
 * answer must fit one relay frame.
 */
let transcriptPageSize: number | undefined

export function configureTranscriptPages(size: number | undefined): void {
  transcriptPageSize = size
}

/** One page of a transcript: the newest, or the one before `before`. */
function messagesPage(id: string, before?: string): Promise<ChatMessage[]> {
  if (before === undefined) {
    return transcriptPageSize === undefined ? api.getMessages(id) : api.getMessages(id, { limit: transcriptPageSize })
  }
  return api.getMessages(id, transcriptPageSize === undefined ? { before } : { before, limit: transcriptPageSize })
}

export const useOrbital = create<OrbitalStore>()((set, get) => ({
  sessions: {},
  order: [],
  tags: [],
  rules: [],
  models: [],
  contextWindows: {},
  claudeDirs: [],
  defaultClaudeDir: null,
  lastClaudeDir: null,
  settings: {},
  transcripts: {},
  historyLoaded: {},
  transcriptErrors: {},
  lastTurnResultAt: {},
  statsRevision: {},
  errors: [],
  errorsUnseen: 0,
  remote: null,
  pendingDecisions: {},
  decisionAnswers: {},
  decisionVerdicts: {},
  ideDismissed: {},
  composerDrafts: {},
  rewindSending: {},
  detachedIds: [],
  sessionsTotal: 0,
  leavingSince: {},
  toast: null,
  ui: initialUiState,
  subagentPanel: null,
  taskOutput: null,
  stoppingTasks: {},
  harnesses: {},
  harnessEvents: {},
  harnessEventsMore: {},
  harnessRemoved: {},
  harnessPanel: null,
  harnessTemplatesFocus: null,

  async loadInitial() {
    // In parallel with the rest; its keys are its own.
    const dirs = get().loadClaudeDirs()
    const [sessions, tags, rules, settings, modelsPayload, errorPage, sessionsTotal] =
      await Promise.all([
        api.listSessions(),
        api.listTags(),
        api.listTagRules(),
        api.getSettings(),
        // Best-effort: a failed probe with nothing cached yields [], and every
        // surface that reads the catalog has an empty state for exactly that.
        api.listModels().catch(() => ({ models: [] as OrbitalModel[], contextWindows: {} })),
        // Also best-effort, and for a sharper reason than the catalog's: this
        // is the error surface. It failing must not be the thing that stops
        // the app from mounting and showing the other errors.
        api.listErrors({ limit: ERROR_PAGE_SIZE }).catch(() => null),
        // Best-effort too: the hole's label reading 0 sessions is a cosmetic
        // failure, not a reason to keep the map from mounting.
        api.sessionCount().catch(() => 0),
      ])

    const sessionsMap: Record<string, ApiSession> = {}
    // The one AUTHORITATIVE rebuild of the pending map: this is a full
    // snapshot of the index, so a decision that was settled while this tab
    // was gone is correctly absent afterwards. Every other seeding path only
    // ever adds (see `seedDecision`).
    const pendingDecisions: Record<string, PendingDecision> = {}
    for (const session of sessions) {
      sessionsMap[session.id] = session
      if (session.pendingDecision) pendingDecisions[session.id] = session.pendingDecision
    }

    // Anything still queued goes in first and the snapshot overwrites it —
    // the order it had when every event landed on arrival. Applied after,
    // an event older than the snapshot would undo part of it.
    flushSessionsEvents()
    set((state) => ({
      sessions: sessionsMap,
      order: sortIdsByLastAtDesc(sessionsMap),
      pendingDecisions,
      tags,
      rules,
      settings,
      models: modelsPayload.models,
      contextWindows: modelsPayload.contextWindows,
      errors: errorPage?.errors ?? [],
      errorsUnseen: errorPage?.unseen ?? 0,
      sessionsTotal,
      // Seeded, not defaulted: this is a `ui` field the server owns a value
      // for, and reading it here is what makes it survive a reload.
      ui: {
        ...state.ui,
        sidebarCollapsed: settings.sidebar_collapsed === 'true',
      },
    }))
    await dirs
  },

  seatSessions(list, tags) {
    const sessionsMap: Record<string, ApiSession> = {}
    const pendingDecisions: Record<string, PendingDecision> = {}
    const held = get().sessions
    for (const listed of list) {
      const session = withHeldHistory(held[listed.id], listed)
      sessionsMap[session.id] = session
      if (session.pendingDecision) pendingDecisions[session.id] = session.pendingDecision
    }
    // The open session stays even when the list leaves it out: the phone's
    // list does not carry the ENDED fold, and an ended session can be open.
    const selectedId = get().ui.selectedId
    const selected = selectedId ? held[selectedId] : undefined
    if (selected && !(selected.id in sessionsMap)) {
      sessionsMap[selected.id] = selected
      if (selected.pendingDecision) pendingDecisions[selected.id] = selected.pendingDecision
    }
    // As in `loadInitial`: anything queued goes in first, the snapshot over it.
    flushSessionsEvents()
    set({ sessions: sessionsMap, order: sortIdsByLastAtDesc(sessionsMap), pendingDecisions, tags })
  },

  async loadSessions(opts = {}) {
    const dirs = get().loadClaudeDirs()
    const [page, ended, tags, modelsPayload] = await Promise.all([
      api.listSessionPage({ ended: 'exclude' }),
      opts.endedToo ? api.listSessionPage({ ended: 'only' }) : null,
      api.listTags(),
      api.listModels().catch(() => ({ models: [] as OrbitalModel[], contextWindows: {} })),
    ])
    // A Mac that ignores `ended` answers both with every session; the map keeps one of each.
    get().seatSessions(ended ? [...page.sessions, ...ended.sessions] : page.sessions, tags)
    set({ models: modelsPayload.models, contextWindows: modelsPayload.contextWindows })
    await dirs
    return page.ended ?? null
  },

  mergeSessions(list) {
    if (list.length === 0) return
    flushSessionsEvents()
    set((state) => {
      const sessions = { ...state.sessions }
      const pendingDecisions = { ...state.pendingDecisions }
      for (const listed of list) {
        sessions[listed.id] = withHeldHistory(state.sessions[listed.id], listed)
        if (listed.pendingDecision) pendingDecisions[listed.id] = listed.pendingDecision
      }
      return { sessions, order: sortIdsByLastAtDesc(sessions), pendingDecisions }
    })
  },

  async loadSessionHistory(id) {
    try {
      const { session } = await api.getSession(id)
      if (!(id in get().sessions)) {
        // Not held at all: added the way any session first heard of is.
        get().applySessionsEvent({ event: 'upsert', session })
        return
      }
      set((state) => {
        const current = state.sessions[id]
        if (!current) return {}
        return { sessions: { ...state.sessions, [id]: withDetailHistory(current, session) } }
      })
    } catch {
      // What the list carries stays; the next selection asks again.
    }
  },

  async loadClaudeDirs() {
    try {
      const defaults = await api.sessionDefaults()
      // A Mac from before the feature sends none of the three: one directory, no labels.
      set({
        claudeDirs: defaults?.claudeDirs ?? [],
        defaultClaudeDir: defaults?.defaultClaudeDir ?? null,
        lastClaudeDir: defaults?.lastClaudeDir ?? null,
      })
    } catch {
      // Labels and the dialog's choice wait for the next read; nothing else depends on them.
    }
  },

  async resyncAfterReconnect() {
    try {
      // The full snapshot already covers everything the `sessions` and
      // `errors` topics carried while the socket was down.
      await get().loadInitial()

      // The transcript caches are REPLACED, not merged: `select`'s merge
      // prepends the messages it has not seen, which is exactly the wrong
      // place for a tail missed during the outage. A cache rebuilt from REST
      // cannot be mis-ordered. Pages pulled in by `loadOlder` are lost with
      // it, at the cost of scrolling up through them again.
      const selectedId = get().ui.selectedId
      // The snapshot carries only what runs, so the open session's ended
      // subagents and tasks are read again (and the session itself, when the
      // snapshot's page does not reach it).
      if (selectedId) await get().loadSessionHistory(selectedId)
      // Fetched before the swap, so the open transcript never flashes empty.
      const fetched = selectedId ? await messagesPage(selectedId) : null

      set(
        selectedId && fetched
          ? { transcripts: { [selectedId]: fetched }, historyLoaded: { [selectedId]: true } }
          : { transcripts: {}, historyLoaded: {} },
      )

      // The subagent panel needs the same treatment, and for a sharper
      // reason than the session transcript above: `OrbitalSocket.onopen`
      // re-subscribes every live topic, `subagent:…` included, so the
      // SUBSCRIPTION comes back by itself and the panel quietly resumes
      // appending — with every message published during the outage missing
      // from the middle of the transcript and nothing in the UI saying so.
      // A silent hole is exactly what spec § 10 exists to forbid; the
      // server's ring buffer still holds those messages, so re-running the
      // open is all it takes to close it.
      //
      // `openSubagent` rather than a bare refetch, because it is the one
      // path that does all four things this needs: releases and re-takes
      // the subscription, rebuilds the message list from the buffer, and —
      // on a 404 — writes `found: false`, which is what finally makes
      // STREAM LOST reachable at all. A server restart repopulates
      // `sessions` with `subagents: []` and never touches `ui.selectedId`,
      // so the close guard below does not fire and nothing else in the
      // client would ever have noticed; the panel would keep showing a
      // pre-restart transcript as if it were live.
      //
      // The cost, accepted: the body blanks for one fetch, where the
      // session transcript above fetches before it swaps. The panel is
      // already showing a transcript known to be incomplete, and the swap
      // is bounded by one request.
      const panel = get().subagentPanel
      if (panel) await get().openSubagent(panel.sessionId, panel.subagent)
      // The output view the same way: the re-subscribed topic would carry on
      // past a hole, so the tail is read again.
      const output = get().taskOutput
      if (output) await get().openTaskOutput(output.sessionId, output.taskId)
    } catch {
      // A failed catch-up leaves the caches as they were; the next reconnect,
      // or a manual reload, tries again.
    }
  },

  async reloadTranscript(id) {
    if (!get().historyLoaded[id]) return
    const fetched = await messagesPage(id)
    set((state) => {
      // Left while the fetch was out: the next open fetches anyway.
      if (!state.historyLoaded[id]) return {}
      // The file is the whole truth except for a turn typed a moment ago
      // that it has not echoed yet — the same carry-over `select()` makes.
      const current = state.transcripts[id] ?? []
      const pending = current.filter(
        (m) => isPendingTurn(m) && !fetched.some((f) => echoes(f, m)),
      )
      return { transcripts: { ...state.transcripts, [id]: [...fetched, ...pending] } }
    })
  },

  async checkTranscript(id) {
    // Nothing to compare before the history is seated; `select()` owns that.
    if (!get().historyLoaded[id] || transcriptChecking.has(id)) return
    transcriptChecking.add(id)
    try {
      const tail = await api.getMessages(id, { limit: TRANSCRIPT_CHECK_PAGE })
      const held = get().transcripts[id]
      if (!held || !get().historyLoaded[id]) return
      const step = transcriptCheckStep(held, tail, transcriptSuspects.get(id) ?? null)
      const missing = transcriptSuspects.get(id)
      if (step.suspect) transcriptSuspects.set(id, step.suspect)
      else transcriptSuspects.delete(id)
      if (!step.reload || !missing) return

      // Read before the reload, which is what would change them.
      const socket = getSocket().diagnostics(`session:${id}`)
      const heldCount = held.length
      await get().reloadTranscript(id)

      void api
        .reportErrorToServer({
          kind: 'transcript_gap',
          sessionId: id,
          message: 'The open transcript was missing a message its file had, and was reloaded',
          context: {
            missing: { id: missing.id, role: missing.role, timestamp: missing.timestamp ?? null },
            heldCount,
            sessionStatus: get().sessions[id]?.status ?? null,
            windowFocused: document.hasFocus(),
            socket,
          },
        })
        .catch((err) => console.error('orbital: failed to record a transcript gap', err))
    } catch {
      // A failed read is not a gap; the next check asks again.
    } finally {
      transcriptChecking.delete(id)
    }
  },

  applySessionsEvent(msg) {
    // A direct update is newer than anything the socket queued before it, so
    // the queue goes first — flushed after, an older upsert of the same row
    // would overwrite it.
    flushSessionsEvents()
    applySessionsEvents([msg])
  },

  queueSessionsEvent(msg) {
    queuedSessionsEvents.push(msg)
    if (sessionsFlush) return
    // Whichever comes first. A frame is the point — nothing is drawn between
    // two events inside one — but a hidden window gets no frames at all, and
    // the queue must not grow for as long as it stays hidden.
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(flushSessionsEvents) : 0
    const timer = setTimeout(flushSessionsEvents, SESSIONS_FLUSH_FALLBACK_MS)
    sessionsFlush = { frame, timer }
  },

  applySessionEvent(sessionId, msg) {
    // The two topics are one stream on the server; this keeps them one here.
    flushSessionsEvents()
    const state = get()

    // A transcript row for a session that is neither shown nor held has
    // nowhere to go. `launchSession`'s subscription outlives the selection
    // until the first turn settles, and `dropTranscript` has already let go
    // of the rows; seating new ones here would put them after the history
    // `select()` fetches on the way back — under runner ids the file does
    // not share, so each reply from the time away would show twice. The file
    // carries them. A fresh launch is not caught by this: its optimistic
    // prompt creates the entry before anything is delivered.
    if (
      (msg.event === 'message' || msg.event === 'delta') &&
      state.ui.selectedId !== sessionId &&
      !(sessionId in state.transcripts)
    ) {
      return
    }

    if (msg.event === 'message') {
      const existing = state.transcripts[sessionId] ?? []
      const heldIdx = existing.findIndex((m) => m.id === msg.message.id)
      if (heldIdx >= 0) {
        // A row already held under this id is either the streamed twin of
        // this block — replaced in place, same position, same key — or the
        // same message delivered twice, which stays deduped.
        if (!existing[heldIdx].partial) return
        delete streamEnds[msg.message.id]
        const updated = existing.slice()
        updated[heldIdx] = msg.message
        set({ transcripts: { ...state.transcripts, [sessionId]: updated } })
        return
      }

      // The server echo of a user message we already appended optimistically
      // (see `sendPrompt`) arrives with its own, server-issued id — dedup by
      // id above can't catch it. Replace the matching pending `local:`
      // message in place (same trimmed text AND the same image refs) instead
      // of appending, so the transcript doesn't show two copies of the same
      // user bubble.
      if (msg.message.role === 'user') {
        const echo = msg.message
        const pendingIdx = existing.findIndex((m) => isPendingTurn(m) && echoes(echo, m))
        if (pendingIdx >= 0) {
          const updated = existing.slice()
          // The echo wins on everything the server owns, but the captions are
          // local-only: an SDK image block carries no name, so dropping them
          // here would blank every caption the moment the echo landed.
          const provenance = existing[pendingIdx].imageProvenance
          updated[pendingIdx] = provenance
            ? { ...msg.message, imageProvenance: provenance }
            : msg.message
          set({ transcripts: { ...state.transcripts, [sessionId]: updated } })
          return
        }
        // The echo of a harness message already seated by `harness_message`:
        // same entry, so it takes that row's place and keeps its mark.
        const harnessIdx = echo.uuid ? existing.findIndex((m) => m.uuid === echo.uuid && m.harnessMessage) : -1
        if (harnessIdx >= 0) {
          const updated = existing.slice()
          updated[harnessIdx] = { ...echo, harnessMessage: existing[harnessIdx].harnessMessage }
          set({ transcripts: { ...state.transcripts, [sessionId]: updated } })
          return
        }
      }

      set({
        transcripts: {
          ...state.transcripts,
          [sessionId]: [...existing, msg.message],
        },
      })
      return
    }

    if (msg.event === 'harness_message') {
      // Held or shown only, as `message` is: the file marks the row on the next read.
      if (state.ui.selectedId !== sessionId && !(sessionId in state.transcripts)) return
      const { uuid, kind, step, text, at } = msg.message
      const mark = { kind, step }
      const existing = state.transcripts[sessionId] ?? []
      const heldIdx = existing.findIndex((m) => m.uuid === uuid)
      const updated = existing.slice()
      if (heldIdx >= 0) updated[heldIdx] = { ...existing[heldIdx], harnessMessage: mark }
      else updated.push({ id: `harness:${uuid}`, role: 'user', uuid, text, timestamp: new Date(at).toISOString(), harnessMessage: mark })
      set({ transcripts: { ...state.transcripts, [sessionId]: updated } })
      return
    }

    if (msg.event === 'delta') {
      const existing = state.transcripts[sessionId] ?? []
      const idx = existing.findIndex((m) => m.id === msg.id)
      const end = streamEnds[msg.id]
      if (idx < 0) {
        // A row this tab has not seen: the block's first delta, or a join
        // mid-stream (offset ahead of zero), in which case the row starts
        // at the tail it can see and the complete block fills in the rest.
        streamEnds[msg.id] = msg.offset + msg.text.length
        const row: ChatMessage = {
          id: msg.id,
          role: msg.role,
          text: msg.text,
          timestamp: new Date().toISOString(),
          partial: true,
          ...(msg.model ? { model: msg.model } : {}),
        }
        set({ transcripts: { ...state.transcripts, [sessionId]: [...existing, row] } })
        return
      }
      const row = existing[idx]
      // Behind the row: the same delta delivered twice. Not a partial row:
      // the block has already landed complete, and nothing may grow it.
      if (!row.partial || end === undefined || msg.offset < end) return
      streamEnds[msg.id] = msg.offset + msg.text.length
      const updated = existing.slice()
      updated[idx] = { ...row, text: (row.text ?? '') + msg.text }
      set({ transcripts: { ...state.transcripts, [sessionId]: updated } })
      return
    }

    if (msg.event === 'status') {
      const session = state.sessions[sessionId]
      if (!session) return
      const previousStatus = session.status

      if (msg.status === 'working') {
        turnResultSeen[sessionId] = false
      }

      // The launch's subscription is done once the session settles: see
      // `launchSubscriptions`. Harmless if there is none — every session that
      // was not launched from this tab.
      if (msg.status === 'ended' || msg.status === 'idle') releaseLaunchSubscription(sessionId)

      // SDK process crash: a turn started (`working`) and the process let go
      // (`idle`) without ever producing a `turn_result` in between. Explicitly
      // `false`, never merely falsy — `undefined` means this tab never
      // watched the turn start and so has nothing to accuse it of.
      const crashed =
        msg.status === 'idle' &&
        previousStatus === 'working' &&
        turnResultSeen[sessionId] === false

      const next = { ...session, status: msg.status }
      set({
        sessions: { ...state.sessions, [sessionId]: next },
        ...leavingStamp(state, session, next),
        ...(crashed ? { transcriptErrors: { ...state.transcriptErrors, [sessionId]: true } } : {}),
      })
      return
    }

    if (msg.event === 'transcript_reset') {
      get().reloadTranscript(sessionId).catch((err) => {
        console.error('orbital: failed to reload a transcript after its branch changed', err)
      })
      return
    }

    if (msg.event === 'rewind_refused') {
      // The CLI turned the truncating resume down (spec
      // 2026-09-29-rewind-design § Behaviour 8): nothing was sent, so the
      // optimistic turn goes and its words go back into the composer as an
      // ordinary draft; the strip goes with the pending row. The hidden
      // messages come back with the `transcript_reset` that follows, which is
      // why the turn has to go first — a reload keeps an un-echoed turn.
      const held = state.transcripts[sessionId]
      const lastLocal = held ? [...held].reverse().find(isPendingTurn) : undefined
      const draft = rewindSentText[sessionId] ?? lastLocal?.text
      delete rewindSentText[sessionId]
      const rewindSending = { ...state.rewindSending }
      delete rewindSending[sessionId]
      const session = state.sessions[sessionId]
      set({
        rewindSending,
        ...(held ? { transcripts: { ...state.transcripts, [sessionId]: held.filter((m) => !isPendingTurn(m)) } } : {}),
        ...(session ? { sessions: { ...state.sessions, [sessionId]: { ...session, rewindPending: null } } } : {}),
        toast: {
          kind: 'rewind_refused',
          message: REWIND_REFUSED_TOAST,
          action: { label: 'Details', run: () => get().setDialog('errors') },
        },
      })
      if (draft !== undefined) get().setComposerDraft(sessionId, draft)
      return
    }

    if (msg.event === 'stats') {
      set({
        statsRevision: {
          ...state.statsRevision,
          [sessionId]: (state.statsRevision[sessionId] ?? 0) + 1,
        },
      })
      return
    }

    if (msg.event === 'decision_pending') {
      set({
        pendingDecisions: { ...state.pendingDecisions, [sessionId]: msg.decision },
      })
      return
    }

    if (msg.event === 'decision_resolved') {
      // Whoever settled it — this tab, the other window, an interrupt — the
      // card locks. Guarded on the id so a late broadcast for a decision
      // already superseded by a newer one cannot unlock the new one.
      const current = state.pendingDecisions[sessionId]
      if (!current || current.id !== msg.decisionId) return
      const pendingDecisions = { ...state.pendingDecisions }
      delete pendingDecisions[sessionId]
      // `decisionAnswers[decisionId]` deliberately STAYS: it is what the card
      // renders its answered form from until the `tool_result` arrives.
      set({ pendingDecisions })
      return
    }

    if (msg.event === 'turn_result') {
      turnResultSeen[sessionId] = true
      // A turn_result means the session's current turn completed normally,
      // clearing any earlier crash flag — otherwise a session that crashed
      // once and was later successfully revived/continued would keep
      // showing Transcript's error row forever, even after a subsequent
      // clean turn (and clean end) had already happened.
      const transcriptErrors = state.transcriptErrors[sessionId]
        ? { ...state.transcriptErrors, [sessionId]: false }
        : state.transcriptErrors
      // A row still partial when the turn ends keeps its streamed text as
      // final: the complete block never claimed it, and the file has the
      // same words (spec: 2026-09-24-streaming-output-design § 1).
      const held = state.transcripts[sessionId]
      const transcripts = held?.some((m) => m.partial)
        ? {
            ...state.transcripts,
            [sessionId]: held.map((m) => {
              if (!m.partial) return m
              delete streamEnds[m.id]
              const { partial: _partial, ...final } = m
              return final
            }),
          }
        : state.transcripts
      set({
        transcripts,
        transcriptErrors,
        // Same clearing, for the recorded error. The flag above cannot cover
        // it: the record is a database row that outlives this transition, so
        // what it needs is a moment to be compared against, not a reset.
        lastTurnResultAt: { ...state.lastTurnResultAt, [sessionId]: Date.now() },
      })
      return
    }

    if (msg.event === 'harness') {
      set({ harnesses: { ...state.harnesses, [sessionId]: msg.harness } })
      // The log only rides the REST read; an open panel reads it again, and so
      // does a transcript on screen, whose dashed ◆ rows come from it.
      if (state.harnessPanel?.sessionId === sessionId || state.ui.selectedId === sessionId || sessionId in state.transcripts) {
        void get().loadHarness(sessionId)
      }
      return
    }
  },

  applyErrorsEvent(msg) {
    const state = get()

    if (msg.event === 'error') {
      // Deduped on id: a reconnect can replay, and the browser's own POST
      // resolves with the same row the WS is about to deliver.
      const errors = state.errors.some((e) => e.id === msg.error.id)
        ? state.errors.map((e) => (e.id === msg.error.id ? msg.error : e))
        : [msg.error, ...state.errors]
      set({
        errors,
        errorsUnseen: msg.unseen,
        // Every arriving record raises the one toast. It overwrites whatever
        // was showing, which is exactly why dismissing a toast must never
        // count as having read the row — only the log does that.
        toast: { kind: 'error', message: msg.error.message, source: 'log' },
      })
      return
    }

    if (msg.event === 'seen') {
      set({ errors: dropSeen(state.errors, msg.ids), errorsUnseen: msg.unseen })
    }
  },

  /**
   * Marks rows read, which removes them from the inbox — the user's explicit
   * act, never something the UI does on their behalf. The rows stay in the
   * server's table. Silent on failure: a log the user is already looking at
   * should not raise an error toast about its own bookkeeping, and reporting
   * it would feed the very list it failed to mark.
   */
  async markErrorsSeen(target) {
    if (target !== 'all' && target.length === 0) return
    try {
      const result = await api.markErrorsSeen(target)
      set((state) => ({
        errors: dropSeen(state.errors, target === 'all' ? null : target),
        errorsUnseen: result?.unseen ?? 0,
      }))
    } catch (err) {
      console.error('orbital: failed to mark errors seen', err)
    }
  },

  applyRemoteEvent(msg) {
    if (msg.event !== 'status') return
    // The hub merges its `topic` in; the store keeps only the status fields.
    const { event: _event, topic: _topic, ...status } = msg as typeof msg & { topic?: string }
    set({ remote: status })
  },

  setRemote(status) {
    set({ remote: status })
  },

  async refreshRemote() {
    const before = get().remote
    try {
      const status = await api.getRemote()
      if (!status) return 'failed'
      if (get().remote !== before) return 'superseded'
      set({ remote: status })
      return 'stored'
    } catch (err) {
      console.warn('orbital: failed to read the mobile remote status', err)
      return 'failed'
    }
  },

  async launchSession(body, images) {
    // The id is minted HERE, not by the server, so that this tab can be
    // listening to `session:<id>` before the request that starts the session
    // goes out. `Runner.start()` returns without waiting for the CLI
    // ([[runner-pins-the-session-id]]) and publishes onto that topic as soon
    // as it has anything, while `Hub.publish` keeps no backlog — so anything
    // said before the subscribe was simply lost. Now there is nothing to
    // lose: the window never opens.
    const sessionId = crypto.randomUUID()

    // Imperative on purpose. Setting state and letting App's effect subscribe
    // would put a React commit between here and the request, which is the
    // same "usually fast enough" this change exists to stop relying on.
    const release = getSocket().subscribe(`session:${sessionId}`, (msg: SessionEvent) =>
      get().applySessionEvent(sessionId, msg),
    )
    launchSubscriptions.set(sessionId, release)

    // The first prompt, shown the way `sendPrompt` shows every later one. The
    // Runner publishes no user turn, and `select`'s REST read right after the
    // launch finds no transcript file yet, so without this the prompt the
    // session was started with appeared only once the file was re-read — on a
    // reload. Appended before the request, not after: the session's first
    // reply can land while the request is still in flight, and the prompt
    // has to sit above it.
    if (body.prompt || images?.length) {
      const turn = optimisticTurn(body.prompt, images)
      set((state) => ({
        transcripts: { ...state.transcripts, [sessionId]: [turn, ...(state.transcripts[sessionId] ?? [])] },
      }))
    }

    let started: string
    try {
      started = await api.createSession({ ...body, sessionId })
    } catch (err) {
      releaseLaunchSubscription(sessionId)
      set((state) => {
        const { [sessionId]: _dropped, ...rest } = state.transcripts
        return { transcripts: rest }
      })
      throw err
    }

    // The server echoes the id back, and it should be the one we sent — it
    // either takes ours or refuses the request. If it ever isn't, we are
    // subscribed to a topic nothing will publish on, which is the exact
    // failure this whole change is about, so move rather than assume.
    if (started !== sessionId) {
      releaseLaunchSubscription(sessionId)
      set((state) => {
        const { [sessionId]: held, ...rest } = state.transcripts
        return held ? { transcripts: { ...rest, [started]: held } } : {}
      })
      launchSubscriptions.set(
        started,
        getSocket().subscribe(`session:${started}`, (msg: SessionEvent) =>
          get().applySessionEvent(started, msg),
        ),
      )
    }
    return started
  },

  async select(id) {
    // Every selection lands here — map, sidebar, ⌘K, a notification click and
    // the `?session=` restore — so this is the one place a detached session
    // is sent to its own window instead of the docked panel (spec:
    // 2026-09-23-detached-session-windows-design § Selecting a detached
    // session). A detached window's own list is always empty, so it never
    // redirects to itself.
    if (get().detachedIds.includes(id)) {
      focusSession(id)
      return
    }

    // Selecting a session is the other moment its snapshot is consulted: a
    // tab that loaded before the question was asked, or that never had this
    // session's topic open, learns about it from the row itself.
    const selected = get().sessions[id]
    if (selected) set((state) => seedDecision(state, selected))

    set((state) => ({
      ui: {
        ...state.ui,
        selectedId: id,
        // The viewer belongs to the selected session — moving to another
        // session closes it; re-selecting the same one leaves it alone.
        fileViewer: state.ui.selectedId === id ? state.ui.fileViewer : null,
      },
    }))

    // Re-selecting the session already open: its subscription never lapsed,
    // so the transcript held is complete. A session coming back after it was
    // left has no history here — the store subscription at the bottom of
    // this file dropped it on the way out — so it always fetches: nothing
    // listened on `session:<id>` while it was away, and every reply since is
    // only in the file (fix
    // a-reply-is-in-the-transcript-file-but-not-in-the-open-panel).
    if (get().historyLoaded[id]) return

    // Its subagents and tasks too: the list carries only the running ones.
    void get().loadSessionHistory(id)
    try {
      const fetched = await messagesPage(id)
      set((state) => {
        // Left again while the fetch was in flight: seating the history now
        // would mark a session nobody listens to as loaded, and the next
        // return would show it as it stood here.
        if (state.ui.selectedId !== id) return {}
        // The file's history goes in front of whatever the subscription
        // delivered before the fetch resolved.
        const existing = state.transcripts[id] ?? []
        const existingIds = new Set(existing.map((m) => m.id))
        const toPrepend = fetched.filter((m) => !existingIds.has(m.id))
        return {
          transcripts: { ...state.transcripts, [id]: [...toPrepend, ...existing] },
          historyLoaded: { ...state.historyLoaded, [id]: true },
        }
      })
    } catch {
      // Leave historyLoaded unset so a future select() can retry.
    }
  },

  /**
   * Fetches the page of messages just before the oldest one currently held
   * for `id` and prepends it (deduped by id, same pattern as `select`).
   *
   * Resolves to what was actually prepended, so the transcript's infinite
   * scroll can tell "nothing older" (an empty array — stop asking) apart from
   * a failed fetch (`null` — worth asking again the next time the reader
   * scrolls up). A page that came back holding only messages already here
   * counts as empty: asking again with the same cursor would get the same
   * page, forever.
   */
  async loadOlder(id) {
    const existing = get().transcripts[id] ?? []
    const firstId = existing[0]?.id
    if (!firstId) return []

    let fetched: ChatMessage[]
    try {
      fetched = await messagesPage(id, firstId)
    } catch {
      return null
    }
    let prepended: ChatMessage[] = []
    set((state) => {
      // Left while the page was in flight, and `dropTranscript` let go of the
      // rest. Seating the page alone would give the next `select()` a
      // transcript to prepend the newest history in front of.
      if (!(id in state.transcripts)) return {}
      const current = state.transcripts[id]
      const currentIds = new Set(current.map((m) => m.id))
      prepended = fetched.filter((m) => !currentIds.has(m.id))
      return {
        transcripts: {
          ...state.transcripts,
          [id]: [...prepended, ...current],
        },
      }
    })
    return prepended
  },

  async sendPrompt(id, text, attachments) {
    // Composer text settles a parked decision instead of starting a turn, and
    // what it MEANS depends on the kind:
    //
    // - `question` — the typed words ARE the free-form answer (spec
    //   2026-09-20 § State and lifecycle);
    // - `permission`/`plan` — they are the CLI's own "no, and tell Claude what
    //   to do differently": a refusal with a reason in it, never an approval
    //   (spec 2026-09-23 § Answering).
    //
    // Empty text is neither, so an image-only turn still goes out the normal
    // way.
    const decision = get().pendingDecisions[id]
    if (decision && text.trim()) {
      if (decision.kind === 'question') {
        const open = openQuestion(
          decision.input.questions,
          get().decisionAnswers[decision.id] ?? {},
        )
        if (open) {
          get().answerQuestion(id, open.question, text)
          return
        }
      } else {
        get().resolveDecision(id, { approved: false, message: text })
        return
      }
    }

    // The editor selection rides along, and it rides along with EVERY prompt
    // while it stands — the terminal's behaviour, and the only one the
    // protocol supports: there is no editor revision in the payload, so an
    // edit that leaves the same range selected is indistinguishable from no
    // change and a send-once rule would silently skip it (spec
    // 2026-09-23-ide-bridge-design § Behaviour). It is dropped for THIS
    // session only, by the lip's ×. With no selection standing — none made,
    // or this one dismissed — the file the editor has open rides instead, by
    // path only, in the CLI's own sentence.
    //
    // Deliberately after the decision branch above: an answer to a question,
    // or the reason on a refused permission, is words meant for the ask — not
    // a new turn, and nothing rides on it.
    const session = get().sessions[id]
    const selection = session?.ide?.selection ?? null
    const cwd = session?.cwd ?? ''
    const outgoing =
      isAttachable(selection) && get().ideDismissed[id] !== selectionId(selection)
        ? promptWithSelection(text, cwd, selection)
        : selection
          ? promptWithOpenFile(text, cwd, selection.filePath)
          : text

    const images = attachments?.map((a) => a.entry)
    // What was SENT, not what was typed: the echo that comes back off the
    // transcript carries the block too, and an optimistic turn that showed
    // less would be replaced by a longer one a moment later.
    const optimisticMessage = optimisticTurn(outgoing, attachments)

    // A pending rewind is sent by the ordinary send (spec
    // 2026-09-29-rewind-design § Behaviour 7): from here the strip and the end
    // marker go, and the typed text is kept in case the CLI refuses.
    const sendsRewind = Boolean(session?.rewindPending) && !get().rewindSending[id]
    if (sendsRewind) rewindSentText[id] = text

    // A session waiting for a limit to reset does not send: the server queues
    // the message for the reset and republishes the wait, whose `queued` the
    // transcript lists (spec 2026-10-03-usage-limits-design § 1). An
    // optimistic turn would show it as sent.
    const queues = Boolean(session?.limitWait)

    set((state) => ({
      ...(queues
        ? {}
        : {
            transcripts: {
              ...state.transcripts,
              [id]: [...(state.transcripts[id] ?? []), optimisticMessage],
            },
          }),
      // The refusal toast lasts until the next send (canvas 27c).
      ...(state.toast?.kind === 'rewind_refused' ? { toast: null } : {}),
      ...(sendsRewind ? { rewindSending: { ...state.rewindSending, [id]: true as const } } : {}),
    }))

    try {
      // Two-argument call for a text-only turn, deliberately: a trailing
      // `undefined` is a different call as far as every existing assertion in
      // the suite is concerned, and a plain turn's wire shape has not changed.
      const result =
        images && images.length > 0
          ? await api.sendMessage(
              id,
              outgoing,
              images.map((image) => image.ref),
            )
          : await api.sendMessage(id, outgoing)
      // The entry uuid the turn is written under: what makes this optimistic
      // copy pickable for a rewind before the file is read again.
      const uuid = result?.uuid
      if (uuid) {
        set((state) => {
          const held = state.transcripts[id]
          const idx = held?.findIndex((m) => m.id === optimisticMessage.id) ?? -1
          if (!held || idx < 0) return {}
          const updated = held.slice()
          updated[idx] = { ...held[idx], uuid }
          return { transcripts: { ...state.transcripts, [id]: updated } }
        })
      }
    } catch (err) {
      if (sendsRewind) {
        // Nothing went out, so the rewind is still pending on the server.
        delete rewindSentText[id]
        set((state) => {
          const rewindSending = { ...state.rewindSending }
          delete rewindSending[id]
          return { rewindSending }
        })
      }
      if (err instanceof ApiError && err.status === 409) {
        set({
          toast: {
            kind: 'error',
            message: err.message || 'Session is live in a terminal',
          },
        })
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to send message'
      set({ toast: { kind: 'error', message } })
    }
  },

  answerQuestion(sessionId, question, answer) {
    const decision = get().pendingDecisions[sessionId]
    // Words only answer a question. A verdict decision parked on the same
    // session goes through `resolveDecision`, and posting answers at it would
    // be a 400 from the server.
    if (decision?.kind !== 'question') return

    const before = get().decisionAnswers[decision.id]
    const answers: AnswerMap = {
      ...(before ?? {}),
      [question]: answer,
    }
    set((state) => ({
      decisionAnswers: { ...state.decisionAnswers, [decision.id]: answers },
    }))

    // A 2–4 question card sends once, when the last question closes — until
    // then the partial record above is all that exists, and it is what gates
    // the next question open.
    const complete = completedAnswers(decision.input.questions, answers)
    if (!complete) return

    api.answerDecision(sessionId, decision.id, complete).catch((err) => {
      // 404 is not a failure: someone else answered first, or the decision
      // was settled by an interrupt or the session ending. The card is
      // already showing the answer it sent; all that is left is to stop
      // treating the question as open (spec § State and lifecycle: "first
      // answer wins; the loser's POST gets 404").
      if (err instanceof ApiError && err.status === 404) {
        get().applySessionEvent(sessionId, {
          event: 'decision_resolved',
          decisionId: decision.id,
        })
        return
      }
      // The answer did not land (a tunnel that dropped mid-POST, a 5xx):
      // the answer is taken back, so the card's last question is live again
      // and the composer offers it — unless something newer replaced the
      // record meanwhile.
      set((state) => {
        if (state.decisionAnswers[decision.id] !== answers) return {}
        const decisionAnswers = { ...state.decisionAnswers }
        if (before) decisionAnswers[decision.id] = before
        else delete decisionAnswers[decision.id]
        return { decisionAnswers }
      })
      const message = err instanceof Error ? err.message : 'Failed to send the answer'
      set({ toast: { kind: 'error', message } })
    })
  },

  resolveDecision(sessionId, verdict) {
    const decision = get().pendingDecisions[sessionId]
    if (!decision || decision.kind === 'question') return

    // Recorded before the POST for the same reason the question card records
    // its answers: the card flips to its settled form on the click, and the
    // refusal's reason has nowhere else to live — the tool_result that comes
    // back carries only the error flag.
    set((state) => ({
      decisionVerdicts: { ...state.decisionVerdicts, [decision.id]: verdict },
    }))

    api.resolveDecision(sessionId, decision.id, verdict).catch((err) => {
      // 404 is not a failure: someone else answered first, or the decision was
      // settled by an interrupt or the session ending. The card already shows
      // the verdict it sent; all that is left is to stop treating the ask as
      // open — the same rule the question path follows.
      if (err instanceof ApiError && err.status === 404) {
        get().applySessionEvent(sessionId, {
          event: 'decision_resolved',
          decisionId: decision.id,
        })
        return
      }
      // The verdict did not land: take it back, so the card is live again —
      // unless something newer replaced it meanwhile (as `answerQuestion`).
      set((state) => {
        if (state.decisionVerdicts[decision.id] !== verdict) return {}
        const decisionVerdicts = { ...state.decisionVerdicts }
        delete decisionVerdicts[decision.id]
        return { decisionVerdicts }
      })
      const message = err instanceof Error ? err.message : 'Failed to send the answer'
      set({ toast: { kind: 'error', message } })
    })
  },

  dismissIdeSelection(sessionId, selectionId) {
    set((state) => ({ ideDismissed: { ...state.ideDismissed, [sessionId]: selectionId } }))
  },

  setComposerDraft(sessionId, text) {
    set((state) => {
      const composerDrafts = { ...state.composerDrafts }
      if (text) composerDrafts[sessionId] = text
      else delete composerDrafts[sessionId]
      return { composerDrafts }
    })
  },

  setFilterTag(filterTagId) {
    set((state) => ({ ui: { ...state.ui, filterTagId } }))
  },

  setSearch(search) {
    set((state) => ({ ui: { ...state.ui, search } }))
  },

  setSourceFilter(sourceFilter) {
    set((state) => ({ ui: { ...state.ui, sourceFilter } }))
  },

  /**
   * Pins (or unpins) a session — a pinned session stays on the map once it
   * has ended (spec 2026-09-20-pinned-sessions-design, spec
   * 2026-09-24-sessions-end-only-by-hand-design § 3). Optimistic: the toggle
   * lives in two surfaces that have to agree within a frame, and a round trip
   * between the click and the row moving into PINNED would read as a stuck
   * control. A failed save puts the pin back and reports. No undo toast:
   * unpinning is the same one click that pinned. Unpinning an ended session
   * takes it off the map, with the same fade as any other leaving body.
   *
   * Both stamps go through `withViewTransition` so the sidebar row slides
   * between PINNED and its old section instead of teleporting. It sits here
   * rather than in the two buttons because there are three ways in — the
   * sidebar row's pin, the detail panel's, and the trash toast's undo — and a
   * row that animates from one of them and jumps from another would read as a
   * bug. The rollback is wrapped too: a failed save sends the row back, which
   * is the same move in reverse.
   */
  async setSessionPinned(id, pinned) {
    const session = get().sessions[id]
    if (!session) return
    const previous = session.pinnedAt ?? null
    const stamp = (pinnedAt: number | null) =>
      withViewTransition(() => set((state) => withSessionPatch(state, id, { pinnedAt })))
    stamp(pinned ? Date.now() : null)
    try {
      await api.setSessionPinned(id, pinned)
    } catch (err) {
      stamp(previous)
      const message = err instanceof Error ? err.message : 'Failed to save the pin'
      set({ toast: { kind: 'error', message } })
    }
  },

  async endSession(id) {
    await api.endSession(id)
  },

  /**
   * Optimistic: the status is what starts the planet's fade, and waiting a
   * round trip before letting go of the body would make the drop feel stuck.
   * The End carries the unpin, one request and one write on the server: sent
   * apart, the End's upsert came back ended-but-still-pinned, the planet
   * faded back in, and the unpin's upsert started the fade over. A failure
   * rolls back both, since neither happened.
   *
   * A session that had already ended (one still fading out as it is
   * dropped) is not ended again: the drop is then just the unpin, and
   * its Undo just the re-pin.
   *
   * With `undo`, success raises the toast; it expires after `UNDO_TOAST_MS`
   * (the session itself stays one click away in the sidebar's HISTORY, so the
   * undo is a convenience, not the only way back).
   */
  async trashSession(id, { undo }) {
    const session = get().sessions[id]
    if (!session) return
    const previousStatus = session.status
    const previousPin = session.pinnedAt ?? null
    const wasPinned = previousPin != null
    const alreadyEnded = previousStatus === 'ended'
    const write = (fields: Partial<ApiSession>) => {
      const apply = () => set((state) => withSessionPatch(state, id, fields))
      // Only a drop that takes a pin moves a sidebar row — ending an
      // unpinned session changes the map and its status dot, and the row
      // stays in its section. So the view transition is spent on the case
      // that has something to animate.
      if (wasPinned) withViewTransition(apply)
      else apply()
    }
    write({ status: 'ended', pinnedAt: null })
    if (!alreadyEnded) {
      try {
        await api.endSession(id, { unpin: wasPinned })
      } catch (err) {
        write({ status: previousStatus, pinnedAt: previousPin })
        throw err
      }
    } else if (wasPinned) {
      try {
        await api.setSessionPinned(id, false)
      } catch (err) {
        write({ pinnedAt: previousPin })
        throw err
      }
    }
    if (!undo) return
    const title = session.title || 'Session'
    const toast: Toast = {
      kind: 'info',
      message: alreadyEnded
        ? `${title} unpinned — still in the sidebar's history`
        : wasPinned
          ? `${title} ended · pin removed`
          : `${title} ended`,
      action: {
        label: 'Undo',
        run: () =>
          void (alreadyEnded
            ? get().setSessionPinned(id, true)
            : get().reopenSession(id, wasPinned)),
      },
    }
    set({ toast })
    setTimeout(() => {
      // Only expire OUR toast: something newer showing must stay.
      if (get().toast === toast) set({ toast: null })
    }, UNDO_TOAST_MS)
  },

  async reopenSession(id, repin) {
    const session = get().sessions[id]
    if (!session) return
    const previousStatus = session.status
    // `idle`, because that is what the server reads for an Orbital session
    // with no process and no `ended_at` — its upsert will say the same.
    set((state) => withSessionPatch(state, id, { status: 'idle' }))
    try {
      await api.reopenSession(id)
    } catch (err) {
      set((state) => withSessionPatch(state, id, { status: previousStatus }))
      const message = err instanceof Error ? err.message : 'Failed to reopen the session'
      set({ toast: { kind: 'error', message } })
      return
    }
    if (repin) await get().setSessionPinned(id, true)
  },

  /**
   * Moves a tag clump's home to wherever the user dropped its dragged body
   * (tag clusters follow-up; `rehomeTarget` decides when a drop qualifies).
   * Optimistic like the dismissal: the springs start pulling the clump to
   * its new home immediately, and a failed save puts the old home back and
   * reports. `null` clears the stored home back to the automatic layout.
   */
  async setTagAnchor(tagId, anchor) {
    const tag = get().tags.find((t) => t.id === tagId)
    if (!tag) return
    const previous = { anchor_x: tag.anchor_x ?? null, anchor_y: tag.anchor_y ?? null }
    const next = { anchor_x: anchor?.x ?? null, anchor_y: anchor?.y ?? null }
    const apply = (values: { anchor_x: number | null; anchor_y: number | null }) =>
      set((state) => ({
        tags: state.tags.map((t) => (t.id === tagId ? { ...t, ...values } : t)),
      }))
    apply(next)
    try {
      await api.patchTag(tagId, next)
    } catch (err) {
      apply(previous)
      const message = err instanceof Error ? err.message : 'Failed to save the cluster home'
      set({ toast: { kind: 'error', message } })
    }
  },

  revealHistory() {
    // The un-collapse goes through the persisting setter on purpose: the
    // click is the user opening the sidebar, same as the rail's own button.
    get().setSidebarCollapsed(false)
    set((state) => ({
      ui: { ...state.ui, historyRevealNonce: (state.ui.historyRevealNonce ?? 0) + 1 },
    }))
  },

  setDialog(dialog) {
    set((state) => ({ ui: { ...state.ui, dialog } }))
  },

  setDetached(ids) {
    set((state) => {
      const selectedId = state.ui.selectedId
      if (!selectedId || !ids.includes(selectedId)) return { detachedIds: ids }
      // Detaching closes the docked panel (spec:
      // 2026-09-23-detached-session-windows-design § Detaching). The viewer
      // goes with it — it belongs to the session that just left.
      return { detachedIds: ids, ui: { ...state.ui, selectedId: null, fileViewer: null } }
    })
  },

  openFile(path, line, cwd) {
    set((state) => ({ ui: { ...state.ui, fileViewer: { path, line: line ?? null, ...(cwd ? { cwd } : {}) } } }))
  },

  closeFile() {
    set((state) => ({ ui: { ...state.ui, fileViewer: null } }))
  },

  async openInIde(path, line) {
    const id = get().ui.selectedId
    if (!id) return false
    try {
      return await api.ideOpenFile(id, path, line ?? null)
    } catch {
      // Silence is the contract for everything IDE (adr
      // `orbital-speaks-to-the-ide-itself`). The gesture only ever appears
      // when a session reports an editor, so a failure here means the editor
      // went away between the hover and the press — which is not news.
      return false
    }
  },

  // Same optimistic shape as `setHideEnded`: the rail collapses now, the
  // save follows, and a failed save puts it back rather than leaving the
  // sidebar in a state the server never took.
  setSidebarCollapsed(sidebarCollapsed) {
    const previous = get().ui.sidebarCollapsed
    if (previous === sidebarCollapsed) return
    set((state) => ({
      ui: { ...state.ui, sidebarCollapsed },
      settings: { ...state.settings, sidebar_collapsed: String(sidebarCollapsed) },
    }))
    api.patchSettings({ sidebar_collapsed: String(sidebarCollapsed) }).catch((err) => {
      const message = err instanceof Error ? err.message : 'Failed to save the sidebar state'
      set((state) => ({
        ui: { ...state.ui, sidebarCollapsed: previous },
        settings: { ...state.settings, sidebar_collapsed: String(previous) },
        toast: { kind: 'error', message },
      }))
    })
  },

  setWsStatus(wsStatus) {
    set((state) => ({ ui: { ...state.ui, wsStatus } }))
    if (wsStatus === 'closed') {
      sawClosedSocket = true
      return
    }
    if (wsStatus === 'open' && sawClosedSocket) {
      sawClosedSocket = false
      // Deliberately not awaited: the banner goes away with the status above,
      // and the catch-up lands whenever the fetches do.
      void get().resyncAfterReconnect()
    }
  },

  clearToast() {
    set({ toast: null })
  },

  async openSubagent(sessionId, subagent) {
    // One slot: an open task output view gives way.
    get().closeTaskOutput()
    get().closeHarness()
    // Release first, not last: the old subscription must be gone before the
    // new one is even requested, or the two topics could both be live for a
    // beat and the outgoing agent's messages would land in the incoming
    // agent's list (task 7 brief: "A leaked subscription here is a real
    // bug, not a tidiness point").
    releaseSubagentSubscription()

    // The parent session becomes the selected one, first (spec § 8's
    // lifecycle: the agent panel sits BESIDE its parent's detail panel, and
    // "Another planet selected | Subagent panel closes — it belonged to the
    // old session" only makes sense if the two were ever the same session).
    //
    // The `OPEN →` path satisfies this trivially — that row only exists
    // inside the parent's own open transcript. The MAP path did not:
    // `SpaceMap` called `openSubagent` alone, so a moon click could dock an
    // agent panel with nothing selected at all (`mapInsets.right` and
    // `overlayRightPx` are both gated on `selectedId` and would ignore it)
    // or beside a DIFFERENT session's detail panel. The close guard at the
    // bottom of this file fires on `ui.selectedId` CHANGING, so it can
    // narrow an inconsistency that appears later but can never repair one
    // that exists the moment the panel opens.
    //
    // Not awaited: `select()` writes `ui.selectedId` synchronously and only
    // then awaits its history fetch, and the panel must seat in the same
    // frame as the click. Skipped when it is already the selected session,
    // so clicking a second moon on the same planet does not re-run the
    // parent's own bookkeeping.
    if (get().ui.selectedId !== sessionId) void get().select(sessionId)

    // Seats the header/badge immediately, before either the subscribe or the
    // fetch — the swap has to read as "now showing the new agent" in the
    // same frame as the click, not a beat later once the network responds.
    // The body starts empty; the fetch below fills it in, or (on a 404)
    // turns this into STREAM LOST. `subagent` is stored by reference
    // (never copied) because every async continuation below re-checks
    // identity against this exact object to tell a stale response apart
    // from a fresh one. The outgoing list's partial rows go with it, and
    // their stream bookkeeping with them (see `closeSubagent`).
    forgetStreamEnds(get().subagentPanel?.messages ?? [])
    set({
      subagentPanel: { sessionId, subagent, messages: [], droppedCount: 0, found: true },
    })

    const toolUseId = subagent.toolUseId
    if (!toolUseId) {
      // Spec § 5: a moon (or row) whose `SubagentInfo` never got a
      // `toolUseId` from `task_started` cannot be joined to any buffer —
      // callers are expected not to reach here (such an agent takes no
      // pointer and no tab stop), but if one does there is nothing to fetch
      // or subscribe to. STREAM LOST is the honest reading: no transcript,
      // and no reason to expect one to arrive.
      set((state) =>
        state.subagentPanel?.subagent === subagent
          ? { subagentPanel: { ...state.subagentPanel, found: false } }
          : {}
      )
      return
    }

    // Subscribed BEFORE the fetch goes out, same reasoning as
    // `launchSession`'s subscribe-before-POST: a live message published in
    // the gap between the fetch resolving and the subscribe existing would
    // otherwise be lost with nothing to notice it ever happened.
    subagentSubscriptionRelease = getSocket().subscribe(
      `subagent:${sessionId}:${toolUseId}`,
      (msg: SubagentEvent) => get().applySubagentEvent(sessionId, toolUseId, msg),
    )

    try {
      const { messages, droppedCount } = await api.subagentMessages(sessionId, toolUseId)
      const current = get().subagentPanel
      // A second `openSubagent` (or a `closeSubagent`) may have run while
      // this was in flight — identity is the object reference set above, so
      // a stale response landing after the swap can never resurrect a panel
      // the user already left.
      if (!current || current.subagent !== subagent) return
      const fetchedIds = new Set(messages.map((m) => m.id))
      // Anything a live WS message already appended DURING the fetch (see
      // `applySubagentEvent`) and that the fetched snapshot does not itself
      // contain arrived strictly after that snapshot was taken, so it is
      // folded in after it — the same merge `select()` uses for its own
      // history fetch, applied here instead of an outright replace so a
      // fast live message can never be dropped on the floor by its own
      // fetch's response landing a moment later.
      const alreadyLive = current.messages.filter((m) => !fetchedIds.has(m.id))
      set({
        subagentPanel: {
          ...current,
          messages: [...messages, ...alreadyLive],
          droppedCount,
          found: true,
        },
      })
    } catch (err) {
      const current = get().subagentPanel
      if (!current || current.subagent !== subagent) return
      if (err instanceof ApiError && err.status === 404) {
        // The distinction the whole design hinges on (task 7 brief): the
        // server no longer knows this agent at all — its buffer died with a
        // restart — as opposed to a 200 with an empty list, which means the
        // agent is known and simply hasn't said anything yet. Collapsing
        // the two would tell the user the agent did nothing, which here
        // would be a lie.
        forgetStreamEnds(current.messages)
        set({ subagentPanel: { ...current, messages: [], droppedCount: 0, found: false } })
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to load the subagent transcript'
      set({ toast: { kind: 'error', message } })
    }
  },

  closeSubagent() {
    releaseSubagentSubscription()
    // Nothing on the subagent topic finalises a partial row, so its entry
    // would otherwise outlive the panel.
    forgetStreamEnds(get().subagentPanel?.messages ?? [])
    set({ subagentPanel: null })
  },

  applySubagentEvent(sessionId, toolUseId, msg) {
    const panel = get().subagentPanel
    // Guards identity the same way `openSubagent`'s own continuations do —
    // belt-and-suspenders, since `releaseSubagentSubscription` already runs
    // synchronously before a new subscribe, so a handler for a topic this
    // panel no longer owns should never fire at all.
    if (!panel || panel.sessionId !== sessionId || panel.subagent.toolUseId !== toolUseId) return
    const droppedCount = msg.droppedCount ?? panel.droppedCount

    // The same rules as `applySessionEvent`'s `delta`, over the panel's list
    // instead of a session transcript, and sharing `streamEnds` with it — row
    // ids are minted by one server counter, so the two never collide.
    if (msg.event === 'delta') {
      const idx = panel.messages.findIndex((m) => m.id === msg.id)
      if (idx < 0) {
        streamEnds[msg.id] = msg.offset + msg.text.length
        const row: ChatMessage = {
          id: msg.id,
          role: msg.role,
          text: msg.text,
          timestamp: new Date().toISOString(),
          partial: true,
          ...(msg.model ? { model: msg.model } : {}),
        }
        // Held against the cap like a complete message. The block that
        // replaces it takes its slot rather than adding one, so the list is
        // ahead of the server's buffer only by the rows still being written.
        const appended = [...panel.messages, row]
        const messages =
          appended.length > MAX_SUBAGENT_MESSAGES
            ? appended.slice(appended.length - MAX_SUBAGENT_MESSAGES)
            : appended
        set({ subagentPanel: { ...panel, messages, droppedCount } })
        return
      }
      const row = panel.messages[idx]
      const end = streamEnds[msg.id]
      if (!row.partial || end === undefined || msg.offset < end) return
      streamEnds[msg.id] = msg.offset + msg.text.length
      const messages = panel.messages.slice()
      messages[idx] = { ...row, text: (row.text ?? '') + msg.text }
      set({ subagentPanel: { ...panel, messages, droppedCount } })
      return
    }

    const heldIdx = panel.messages.findIndex((m) => m.id === msg.message.id)
    if (heldIdx >= 0) {
      // The streamed twin of this block is replaced in place; a message
      // delivered twice stays deduped.
      if (!panel.messages[heldIdx].partial) return
      delete streamEnds[msg.message.id]
      const messages = panel.messages.slice()
      messages[heldIdx] = msg.message
      set({ subagentPanel: { ...panel, messages, droppedCount } })
      return
    }
    // Capped at the SERVER's own cap, and evicted from the front the same
    // way. The list started as a copy of the server's buffer (the fetch in
    // `openSubagent`) and grows by exactly the appends the server makes, so
    // the two stay in lockstep — which is why `droppedCount` is TAKEN from
    // the payload rather than counted here: the server owns the number, and
    // two independent counters that could ever disagree is how the
    // TRUNCATED chip would come to claim "buffer 3,412 steps" about a ring
    // buffer that cannot hold more than `MAX_SUBAGENT_MESSAGES`.
    const appended = [...panel.messages, msg.message]
    const messages =
      appended.length > MAX_SUBAGENT_MESSAGES
        ? appended.slice(appended.length - MAX_SUBAGENT_MESSAGES)
        : appended
    set({
      subagentPanel: {
        ...panel,
        messages,
        droppedCount,
      },
    })
  },

  async openTaskOutput(sessionId, taskId) {
    // One slot: the subagent panel and this view take turns in it.
    get().closeSubagent()
    get().closeHarness()
    releaseTaskOutputSubscription()
    if (get().ui.selectedId !== sessionId) void get().select(sessionId)

    set({ taskOutput: { sessionId, taskId, phase: 'loading', output: EMPTY_OUTPUT, end: 0, pending: [] } })

    // Subscribed before the fetch, like `openSubagent`: bytes appended in
    // the gap wait in `pending` and are folded in after the tail.
    taskOutputSubscriptionRelease = getSocket().subscribe(
      `task-output:${sessionId}:${taskId}`,
      (msg: TaskOutputEvent) => get().applyTaskOutputEvent(sessionId, taskId, msg),
    )

    try {
      const tail = await api.taskOutput(sessionId, taskId)
      const current = get().taskOutput
      // Another open, a close or a hole's reopen may have run meanwhile.
      if (!current || current.sessionId !== sessionId || current.taskId !== taskId || current.phase !== 'loading') return
      let next: OpenTaskOutputState = { ...current, phase: 'ready', output: appendOutput(EMPTY_OUTPUT, tail.text), end: tail.end, pending: [] }
      for (const delta of current.pending) next = foldOutputDelta(next, delta) ?? next
      set({ taskOutput: next })
    } catch (err) {
      const current = get().taskOutput
      if (!current || current.sessionId !== sessionId || current.taskId !== taskId) return
      if (err instanceof ApiError && (err.status === 410 || err.status === 404)) {
        set({ taskOutput: { ...current, phase: 'gone', pending: [] } })
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to load the task output'
      set({ toast: { kind: 'error', message } })
    }
  },

  closeTaskOutput() {
    releaseTaskOutputSubscription()
    if (get().taskOutput) set({ taskOutput: null })
  },

  async loadHarness(sessionId) {
    try {
      // The whole log: the panel folds it into the steps' records (canvas 30g).
      const { harness, removed, events } = await api.getSessionHarness(sessionId, { limit: HARNESS_EVENTS_PAGE })
      set((state) => ({
        harnesses: { ...state.harnesses, [sessionId]: harness },
        harnessRemoved: { ...state.harnessRemoved, [sessionId]: removed },
        harnessEvents: { ...state.harnessEvents, [sessionId]: events },
        harnessEventsMore: { ...state.harnessEventsMore, [sessionId]: events.length >= HARNESS_EVENTS_PAGE },
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load the harness'
      set({ toast: { kind: 'error', message } })
    }
  },

  async loadOlderHarnessEvents(sessionId) {
    const held = get().harnessEvents[sessionId]
    if (!held || !get().harnessEventsMore[sessionId] || harnessEventsPaging.has(sessionId)) return
    // Newest first, so the last one held is the oldest; ids are insertion order.
    const before = held.length > 0 ? held[held.length - 1].id : undefined
    harnessEventsPaging.add(sessionId)
    try {
      const { events } = await api.getSessionHarness(sessionId, { limit: HARNESS_EVENTS_PAGE, before })
      set((state) => {
        const current = state.harnessEvents[sessionId] ?? []
        const seen = new Set(current.map((e) => e.id))
        return {
          harnessEvents: { ...state.harnessEvents, [sessionId]: [...current, ...events.filter((e) => !seen.has(e.id))] },
          harnessEventsMore: { ...state.harnessEventsMore, [sessionId]: events.length >= HARNESS_EVENTS_PAGE },
        }
      })
    } catch {
      // The transcript goes without the older rows; the next scroll asks again.
    } finally {
      harnessEventsPaging.delete(sessionId)
    }
  },

  openHarness(sessionId, opts) {
    // The pill, the strip button and ⌘⇧H toggle it, like the other side-slot
    // panels (spec 2026-10-02-harness-redesign-design § Agreed).
    if (get().harnessPanel?.sessionId === sessionId) {
      get().closeHarness()
      return
    }
    get().closeSubagent()
    get().closeTaskOutput()
    if (get().ui.selectedId !== sessionId) void get().select(sessionId)
    set({ harnessPanel: opts?.full ? { sessionId, full: true } : { sessionId } })
    void get().loadHarness(sessionId)
  },

  closeHarness() {
    if (get().harnessPanel) set({ harnessPanel: null })
  },

  openHarnessTemplates(focus) {
    // In memory only: Settings opens on its last section, and this visit's is Harness templates.
    set((state) => ({
      harnessTemplatesFocus: focus,
      settings: { ...state.settings, settings_last_section: 'harness' },
      ui: { ...state.ui, dialog: 'settings' },
    }))
  },

  applyTaskOutputEvent(sessionId, taskId, msg) {
    const view = get().taskOutput
    if (!view || view.sessionId !== sessionId || view.taskId !== taskId) return
    if (msg.event === 'gone') {
      // What was already read stays readable; the view only says so once
      // there is nothing at all to show.
      if (view.phase === 'loading') set({ taskOutput: { ...view, phase: 'gone', pending: [] } })
      return
    }
    if (view.phase === 'loading') {
      set({ taskOutput: { ...view, pending: [...view.pending, { offset: msg.offset, text: msg.text }] } })
      return
    }
    if (view.phase !== 'ready') return
    const next = foldOutputDelta(view, msg)
    if (next) {
      set({ taskOutput: next })
      return
    }
    // A hole: bytes went by that this view never saw (a dropped socket, a
    // slow subscribe). Reading the tail again is the whole repair.
    void get().openTaskOutput(sessionId, taskId)
  },

  async stopTask(sessionId, taskId) {
    const key = `${sessionId}:${taskId}`
    set((state) => ({ stoppingTasks: { ...state.stoppingTasks, [key]: true } }))
    try {
      await api.stopTask(sessionId, taskId)
    } catch (err) {
      set((state) => {
        const { [key]: _dropped, ...rest } = state.stoppingTasks
        return { stoppingTasks: rest }
      })
      // 409: it ended on its own while the click was on its way — nothing to report.
      if (err instanceof ApiError && err.status === 409) return
      const message = err instanceof Error ? err.message : 'Failed to stop the task'
      set({ toast: { kind: 'error', message } })
    }
  },
}))

/**
 * Closes the subagent panel whenever the selected session stops being its
 * parent — either it was deselected, or another planet was selected (task 7
 * brief: "The panel must close when its parent session is deselected or
 * another planet is selected. Wire that to the existing selection action
 * rather than adding a watcher effect.").
 *
 * `ui.selectedId` is written from FIVE places in this codebase — `select()`
 * below, the detail panel's own × , the map's empty-space click, App's
 * Escape handler, and `sessionUrl`'s stale-deep-link cleanup — and none of
 * the other four go through `select()` at all; they zero it with a raw
 * `setState`. A store subscription on the field itself is therefore the one
 * seam that sees every one of them without adding a watcher effect to each
 * call site (or a React effect at all — this is registered once, for the
 * module's lifetime, not per component mount).
 */
useOrbital.subscribe((state, prevState) => {
  if (state.ui.selectedId === prevState.ui.selectedId) return
  const panel = state.subagentPanel
  if (panel && panel.sessionId !== state.ui.selectedId) useOrbital.getState().closeSubagent()
  const output = state.taskOutput
  if (output && output.sessionId !== state.ui.selectedId) useOrbital.getState().closeTaskOutput()
  const harness = state.harnessPanel
  if (harness && harness.sessionId !== state.ui.selectedId) useOrbital.getState().closeHarness()
  const left = prevState.ui.selectedId
  if (left) dropTranscript(left)
})

/**
 * What one `sessions`-topic event changes, computed against `state` — which,
 * for a batch, is the store as the events before it in the batch left it.
 * Null when it changes nothing. Anything that must run once the change is in
 * the store is pushed to `after`.
 */
function sessionsEventPatch(
  state: OrbitalStore,
  msg: SessionsEvent,
  after: (() => void)[],
): Partial<OrbitalState> | null {
  if (msg.event === 'upsert') {
    const isNew = !(msg.session.id in state.sessions)
    const held = state.sessions[msg.session.id]
    // The selected session shows its whole history, and how a subagent or a
    // task ended is not in the upsert that drops it.
    if (state.ui.selectedId === msg.session.id && historyEndedOutOfList(held, msg.session)) {
      const id = msg.session.id
      after.push(() => void useOrbital.getState().loadSessionHistory(id))
    }
    const sessions = { ...state.sessions, [msg.session.id]: withHeldHistory(held, msg.session) }
    // A sent rewind is settled once the row stops carrying it — the CLI took
    // the truncating resume (or a refusal took it back).
    const rewindSettled = !msg.session.rewindPending && state.rewindSending[msg.session.id]
    if (rewindSettled) delete rewindSentText[msg.session.id]
    return {
      ...(rewindSettled ? { rewindSending: withoutKey(state.rewindSending, msg.session.id) } : {}),
      sessions,
      order: sortIdsByLastAtDesc(sessions),
      ...leavingStamp(state, state.sessions[msg.session.id], msg.session),
      ...seedDecision(state, msg.session),
      // An upsert of an unknown id is a new index row, so the hole's total
      // moves with it. A re-upsert of a known session is just a change.
      ...(isNew ? { sessionsTotal: state.sessionsTotal + 1 } : {}),
    }
  }

  if (msg.event === 'status') {
    const existing = state.sessions[msg.sessionId]
    if (!existing) {
      // Unknown session: refetch it from the API rather than dropping
      // the event, since we don't have a row to merge the status into.
      after.push(() => {
        api
          .getSession(msg.sessionId)
          .then(({ session }) => {
            useOrbital.getState().applySessionsEvent({ event: 'upsert', session })
          })
          .catch(() => {
            // Session may have been deleted server-side between the event
            // and the refetch; nothing sensible to do here.
          })
      })
      return null
    }
    const next = { ...existing, status: msg.status }
    return {
      sessions: { ...state.sessions, [msg.sessionId]: next },
      ...leavingStamp(state, existing, next),
    }
  }

  if (msg.event === 'remove') {
    if (!(msg.sessionId in state.sessions)) return null
    const sessions = { ...state.sessions }
    delete sessions[msg.sessionId]
    const composerDrafts = { ...state.composerDrafts }
    delete composerDrafts[msg.sessionId]
    // An open agent panel goes with its parent. The close guard at the
    // bottom of this file only watches `ui.selectedId`, and a removal does
    // not necessarily move it — a session removed while some OTHER planet
    // is selected, or while the same one stays selected as a now-missing
    // id, both leave `selectedId` exactly where it was. The panel would
    // then keep rendering: header with no parent name (the session is
    // gone from `sessions`), a transcript of an agent belonging to
    // nothing, and — because the server drops both subagent stores at the
    // same moment (`server/src/index.ts`, `onStatus` / `ended`) — no way
    // to refetch it either.
    after.push(() => {
      const store = useOrbital.getState()
      if (store.subagentPanel?.sessionId === msg.sessionId) store.closeSubagent()
      if (store.taskOutput?.sessionId === msg.sessionId) store.closeTaskOutput()
      if (store.harnessPanel?.sessionId === msg.sessionId) store.closeHarness()
    })
    return {
      sessions,
      composerDrafts,
      order: state.order.filter((id) => id !== msg.sessionId),
      sessionsTotal: Math.max(0, state.sessionsTotal - 1),
    }
  }

  return null
}

/** Applies `msgs` in order, as one store write. */
function applySessionsEvents(msgs: SessionsEvent[]) {
  const after: (() => void)[] = []
  let state = useOrbital.getState()
  let patch: Partial<OrbitalState> | null = null
  for (const msg of msgs) {
    const next = sessionsEventPatch(state, msg, after)
    if (!next) continue
    state = { ...state, ...next }
    patch = { ...(patch ?? {}), ...next }
  }
  if (patch) useOrbital.setState(patch)
  for (const run of after) run()
}

/**
 * Applies whatever `queueSessionsEvent` is holding, now. Also called ahead
 * of anything whose correctness depends on the sessions topic being caught
 * up: a `session:<id>` event (its `status` handler reads the row, and the
 * server published the row's upsert first) and the snapshot `loadInitial`
 * seats (an event queued before it is older than it).
 */
function flushSessionsEvents() {
  if (sessionsFlush) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(sessionsFlush.frame)
    clearTimeout(sessionsFlush.timer)
    sessionsFlush = null
  }
  if (queuedSessionsEvents.length === 0) return
  const msgs = queuedSessionsEvents
  queuedSessionsEvents = []
  applySessionsEvents(msgs)
}

/**
 * Forgets the transcript of a session the selection just left (fix
 * a-reopened-session-shows-the-transcript-it-was-left-with). Its
 * `session:<id>` subscription lapses with the selection, so what is held
 * would only go stale, and `select()` refetches it from the file on the
 * way back anyway. Same seam as the panel guard above, for the same reason:
 * it sees every writer of `ui.selectedId`.
 *
 * An optimistic `local:` turn goes with it; the file's echo of it is what
 * the refetch finds. A session still shown in the subagent panel keeps its
 * transcript — the panel reads its parent's rows.
 */
function dropTranscript(id: string) {
  const state = useOrbital.getState()
  if (state.ui.selectedId === id || state.subagentPanel?.sessionId === id) return
  if (!(id in state.transcripts) && !(id in state.historyLoaded)) return
  forgetStreamEnds(state.transcripts[id] ?? [])
  const { [id]: _transcript, ...transcripts } = state.transcripts
  const { [id]: _loaded, ...historyLoaded } = state.historyLoaded
  useOrbital.setState({ transcripts, historyLoaded })
}

// ---------------------------------------------------------------------------
// Pure selector helpers (exported directly for testing). Do NOT call these
// as `useOrbital(visibleSessions)` / `useOrbital(statusCounts)` directly —
// both allocate a brand new array/object on every call, so under zustand
// 5's default `Object.is` equality the component never stops re-rendering
// ("Maximum update depth exceeded": new result -> "state changed" -> re-run
// selector -> new result -> ...). Either wrap the selector with
// `useShallow` from `zustand/react/shallow` (shallow-compares the returned
// array/object instead of reference-comparing it), or — for anything
// derived further (e.g. the space map's scene model) — select the
// individual primitive/reference slices these functions read and recompute
// the derived value yourself in `useMemo` keyed on those slices. See
// `map/useSceneModel.ts` for a worked example of the latter.
// ---------------------------------------------------------------------------

/**
 * The failure the transcript should be showing for a session, or `undefined`
 * when it should be showing none.
 *
 * A recorded error is a row in a table, not a live flag, so it does not go
 * away on its own — and a session that crashed, was revived and then ran
 * cleanly must stop wearing its old crash, which is the exact rule
 * `turn_result` already applies to `transcriptErrors`. Two things can say the
 * failure is history, and either is enough:
 *
 * - this tab watched a turn complete after it (`lastTurnResultAt`), which is
 *   immediate but only knows what it has seen;
 * - the session has been active since (`lastAt`), which survives a reload but
 *   trails the indexer by a moment.
 *
 * Neither alone is sufficient: the first is empty after a reload, the second
 * lags right after a revive. Together they cover both.
 *
 * A failed compaction is not the session failing: its own mark in the
 * transcript already says so, with the error quoted, and a second red line
 * under it would repeat it as if the session had crashed.
 *
 * `errors` is newest-first, so the first match is the latest. Safe to call
 * straight from a `useOrbital` selector: it returns an element of the array,
 * not a new object, so the reference is stable until the log itself changes.
 */
export function recordedFailureFor(
  state: Pick<OrbitalState, 'errors' | 'sessions' | 'lastTurnResultAt'>,
  sessionId: string,
): ErrorRecord | undefined {
  const latest = state.errors.find(
    (error) => error.sessionId === sessionId && error.kind !== 'compaction_failed',
  )
  if (!latest) return undefined
  const turnAt = state.lastTurnResultAt[sessionId]
  if (turnAt != null && turnAt > latest.at) return undefined
  const lastAt = state.sessions[sessionId]?.lastAt
  if (lastAt != null && lastAt > latest.at) return undefined
  return latest
}

/**
 * Whether a session matches the sidebar's search box — the one predicate the
 * sidebar's lists and the map's muting both read, so the two cannot disagree
 * about what matches. Case-insensitive substring over the title and the
 * working directory; an empty (or all-whitespace) query matches everything.
 */
export function matchesSearch(session: ApiSession, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return session.title.toLowerCase().includes(q) || session.cwd.toLowerCase().includes(q)
}

/**
 * Whether a session passes both sidebar filters, the tag chip and the search
 * box — the one predicate the sidebar's lists and the map's muting both read.
 */
export function matchesSidebarFilters(
  session: ApiSession,
  ui: Pick<OrbitalUiState, 'filterTagId' | 'search'>
): boolean {
  const tagOk = ui.filterTagId === 'all' || session.tagIds.includes(ui.filterTagId)
  return tagOk && matchesSearch(session, ui.search)
}

function newestFirst(sessions: Record<string, ApiSession>): ApiSession[] {
  return Object.values(sessions).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
}

/**
 * What the sidebar lists: the tag filter and the search, newest first. The
 * map does NOT derive from this — it keeps non-matching sessions in place and
 * mutes them (see `mapSessions`, ADR `search-mutes-planets-instead-of-hiding-them`).
 */
export function visibleSessions(state: Pick<OrbitalState, 'sessions' | 'ui'>): ApiSession[] {
  return listableSessions(state).filter((s) => matchesSidebarFilters(s, state.ui))
}

/**
 * Every session a list may show, newest first: all but a harness drafting
 * conversation, which is listed nowhere — not in the sidebar, history,
 * search or the example-session picker (`isListable`). The map still draws
 * one while it runs (`mapSessions`).
 */
export function listableSessions(state: Pick<OrbitalState, 'sessions'>): ApiSession[] {
  return newestFirst(state.sessions).filter(isListable)
}

/**
 * How long a session that stopped holding its place stays in the scene,
 * counted from `leavingSince`: long enough for the planet's own fade
 * (`ENDED_HIDE_MS`) to play out where it stands, with room to spare so a
 * hitched frame never cuts it short.
 */
export const MAP_LEAVE_GRACE_MS = 2 * ENDED_HIDE_MS

/**
 * Whether a session has a place on the map: anything not ended (spec
 * 2026-09-24-sessions-end-only-by-hand-design § 3). An ended session is over
 * by the user's own hand — or, for a terminal one, because its CLI went away
 * — so there is nothing left to watch. A pin does not keep it there: an
 * ended pinned session lives in the sidebar's PINNED only.
 */
export function holdsMapPlace(session: ApiSession): boolean {
  return session.status !== 'ended'
}

/**
 * Where a session stands with the map:
 *
 * - `none` — it holds its place (`holdsMapPlace`); drawn normally.
 * - `leaving` — it just stopped holding it, `leavingSince` ago, within
 *   `MAP_LEAVE_GRACE_MS`; still in the scene, drawn fading out in place.
 * - `gone` — not on the map. Still whole in the sidebar and search.
 *
 * No `leavingSince` means this tab never saw the session leave (it was
 * already ended at load): gone outright, since animating ancient history off
 * the map on every load would be noise. A `leavingSince` newer than `nowMs`
 * reads as `leaving` — the scene's clock is only re-read on a tick, and a
 * session that left after it must still get its fade.
 */
export function absorptionFor(
  session: ApiSession,
  nowMs: number,
  leavingSince: number | undefined,
): 'none' | 'leaving' | 'gone' {
  if (holdsMapPlace(session)) return 'none'
  if (leavingSince != null && nowMs - leavingSince < MAP_LEAVE_GRACE_MS) return 'leaving'
  return 'gone'
}

/**
 * What dropping a session's body on the map's trash does (spec
 * 2026-09-24-sessions-end-only-by-hand-design § 3):
 *
 * - `end` — an Orbital session with nothing in flight: ended at once, with an
 *   Undo. That includes a pinned ended one, whose drop is then just the unpin.
 * - `confirm` — an Orbital session mid-turn or waiting on the user: the End
 *   session dialog asks first, and Cancel leaves it running.
 * - `refuse` — a terminal session, whatever its status: Orbital does not own
 *   the process, so the trash will not pretend to end it.
 */
export type TrashDrop = 'end' | 'confirm' | 'refuse'

export function trashDropFor(source: SessionSource, status: SessionStatus): TrashDrop {
  if (source !== 'web') return 'refuse'
  return status === 'working' || status === 'needs_input' ? 'confirm' : 'end'
}

/** The Appearance slider's range (canvas 5a: 0.70×–1.60×, step 0.05). */
export const PLANET_SCALE_MIN = 0.7
export const PLANET_SCALE_MAX = 1.6

/**
 * `planet_scale` as the map consumes it: the stored multiplier parsed and
 * clamped to the slider's own range, falling back to 1 (the default) for a
 * missing or unparsable value. Applied to drawn body scale — layout and
 * cluster spacing never see it (spec: 2026-09-18-planet-size-design). The
 * one exception is the step between moon orbits, which widens with the
 * moons it separates (adr: orbit-step-clears-the-moon-at-any-planet-size).
 */
export function parsePlanetScale(settings: Record<string, string>): number {
  const raw = Number(settings.planet_scale)
  if (!Number.isFinite(raw)) return 1
  return Math.min(PLANET_SCALE_MAX, Math.max(PLANET_SCALE_MIN, raw))
}

/** The export's detail-panel width (canvas 1b) — the default and the handle's double-click reset. */
export const DETAIL_PANEL_DEFAULT_PX = 450
/** Below this the header's action row and the composer's stop fitting. */
export const DETAIL_PANEL_MIN_PX = 360
/** Ceiling as a share of the viewport, so the map stays usable beside the panel. */
const DETAIL_PANEL_MAX_VIEWPORT_SHARE = 0.6

/**
 * Clamps a candidate width to [360, 60% of the viewport]. The floor wins
 * when the two conflict on a very narrow window — a panel under 360px stops
 * fitting its own header. Shared by the parse below and the drag handle's
 * live math.
 */
export function clampDetailPanelWidth(width: number, viewportWidth: number): number {
  const ceiling = viewportWidth * DETAIL_PANEL_MAX_VIEWPORT_SHARE
  return Math.max(DETAIL_PANEL_MIN_PX, Math.min(ceiling, width))
}

/**
 * `detail_panel_width` as the layout consumes it: parsed, falling back to
 * the export's 450 for a missing or unparsable value, then clamped.
 */
export function parseDetailPanelWidth(
  settings: Record<string, string>,
  viewportWidth: number,
): number {
  const raw = Number(settings.detail_panel_width)
  return clampDetailPanelWidth(Number.isFinite(raw) ? raw : DETAIL_PANEL_DEFAULT_PX, viewportWidth)
}

/** The subagent panel's own width recipe (canvas 11b) — default and
 * minimum, the same role `DETAIL_PANEL_DEFAULT_PX`/`DETAIL_PANEL_MIN_PX`
 * play for the detail panel. Unlike the detail panel there is no drag
 * handle or persisted setting for this width yet (task 8 brief: placing the
 * panel, not extending it) — every caller hands `resolvePanelPairWidths`
 * this constant as its `subagentWidthPx` — but the pairing math below takes
 * it as a value rather than inlining the constant so it is exercised the
 * same way a future resizable width would be. */
export const SUBAGENT_PANEL_DEFAULT_PX = 380
/** Below this the header's chip row and the elapsed reading stop fitting. */
export const SUBAGENT_PANEL_MIN_PX = 320

/** The two docked panels together, as a share of the viewport, once the
 * subagent panel is open (spec § 8 "Layout"; task 8 brief's resolution
 * order). Independent of `DETAIL_PANEL_MAX_VIEWPORT_SHARE` — that ceiling
 * governs the detail panel ALONE and stays exactly as it is (task 8 brief,
 * requirement 1: the single-panel case must not regress), while this one
 * only ever applies once a second panel exists to share the budget with. */
const PANEL_PAIR_MAX_VIEWPORT_SHARE = 0.75

/**
 * The gutter between the detail and subagent panels, and — everywhere else
 * a docked panel is drawn — the same panel's own edge inset (`App.tsx`'s
 * wrapper offsets, `SpaceMap.tsx`'s follow inset and right-anchored
 * overlays). One canvas value, "the 16px gutter is the same as every other
 * gutter" (`Feature - Subagent panel` 11b/11d), so it is exported here
 * rather than re-declared privately at each call site the way it was
 * before fix round 1: `resolvePanelPairWidths` below now has to reason
 * about this same 16px too (see its own comment), and a private copy that
 * could silently drift from what the DOM actually renders would make the
 * ceiling a statement about the wrong number.
 */
export const PANEL_GUTTER_PX = 16

/** `resolvePanelPairWidths`'s return: the two panels' resolved CSS px
 * widths, after the detail-yields-first ceiling has been applied. */
export interface PanelPairWidths {
  detailWidthPx: number
  subagentWidthPx: number
}

/**
 * Resolves the detail and subagent panel widths against the 75% pair
 * ceiling, once the subagent panel is open (spec § 8 "Layout"; task 8
 * brief's numbered resolution order, reproduced here step for step):
 *
 * 1. (Handled by the caller, not this function — see below.) With no
 *    subagent panel open, `clampDetailPanelWidth` alone governs the detail
 *    panel; this function is never called, and today's 60%-share behaviour
 *    is exactly what runs. Generalising THIS function to also cover that
 *    case is exactly the regression the brief warns against.
 * 2. `subagentWidthPx` is floored at `SUBAGENT_PANEL_MIN_PX` — a caller
 *    that ever lets the subagent panel shrink below its own minimum (there
 *    is no such caller yet; see `SUBAGENT_PANEL_DEFAULT_PX`'s comment)
 *    cannot borrow room from going smaller than the panel can actually
 *    render.
 * 3. If the pair — PLUS the `PANEL_GUTTER_PX` between them — already fits
 *    the 75% ceiling, both widths pass through untouched: a wide viewport
 *    never shrinks either panel just because a second one exists. The
 *    ceiling check is gutter-INCLUSIVE (fix round 1 — see the ADR
 *    `panel-pair-ceiling-includes-the-gutter`): the 16px between the two
 *    panels is space they occupy just as much as either panel's own width
 *    is, so a ceiling that pretended it were free would understate how
 *    much of the viewport the pair actually takes.
 * 4. Otherwise the DETAIL panel yields first, down to its own 360px floor
 *    (`DETAIL_PANEL_MIN_PX`): the reader opened the agent, so the parent is
 *    what gives way. The gutter is subtracted out of the ceiling before the
 *    detail panel's share is computed, for the same reason step 3 adds it
 *    into the check.
 * 5. If the detail panel is already pinned at 360 and the pair — gutter
 *    included — still exceeds the ceiling, the subagent panel starts
 *    shrinking too, down to its own 320px floor.
 * 6. Below roughly 1010px of viewport both floors together (plus the
 *    gutter) still exceed 75% — this function returns 360/320 anyway and
 *    lets the pair exceed the ceiling, exactly as the brief's "Deferred"
 *    section says to: the sub-1010px second layout mode (the agent panel
 *    taking the session panel's slot) is explicitly out of scope for this
 *    branch.
 */
export function resolvePanelPairWidths(
  detailWidthPx: number,
  subagentWidthPx: number,
  viewportWidth: number
): PanelPairWidths {
  const subagent = Math.max(SUBAGENT_PANEL_MIN_PX, subagentWidthPx)
  const ceiling = viewportWidth * PANEL_PAIR_MAX_VIEWPORT_SHARE
  if (detailWidthPx + PANEL_GUTTER_PX + subagent <= ceiling) {
    return { detailWidthPx, subagentWidthPx: subagent }
  }
  const shrunkDetail = Math.max(DETAIL_PANEL_MIN_PX, ceiling - PANEL_GUTTER_PX - subagent)
  if (shrunkDetail + PANEL_GUTTER_PX + subagent <= ceiling) {
    return { detailWidthPx: shrunkDetail, subagentWidthPx: subagent }
  }
  const shrunkSubagent = Math.max(SUBAGENT_PANEL_MIN_PX, ceiling - PANEL_GUTTER_PX - DETAIL_PANEL_MIN_PX)
  return { detailWidthPx: DETAIL_PANEL_MIN_PX, subagentWidthPx: shrunkSubagent }
}

/**
 * How wide a detached window must be to hold both panels at their minimums.
 * Narrower, opening the subagent panel grows the window; this wide or wider,
 * the panel opens inside it (spec: 2026-09-23-detached-session-windows-design
 * § The subagent panel in the window). The two sit flush, so no gutter.
 */
export const WINDOW_PANEL_PAIR_MIN_PX = DETAIL_PANEL_MIN_PX + SUBAGENT_PANEL_MIN_PX

/**
 * The detail and subagent panels side by side in a detached window, flush,
 * splitting the window's whole width between them (spec:
 * 2026-09-23-detached-session-windows-design § The subagent panel in the
 * window). `resolvePanelPairWidths`' order, without its viewport ceiling:
 * there is no map to keep usable, the window is the two panels.
 *
 * The subagent panel takes `SUBAGENT_PANEL_DEFAULT_PX` and the detail panel
 * the rest. When the rest would be under `DETAIL_PANEL_MIN_PX`, the detail
 * panel yields first — it stops at its minimum and the subagent panel takes
 * what is left, down to `SUBAGENT_PANEL_MIN_PX`. A window narrower than
 * `WINDOW_PANEL_PAIR_MIN_PX` (only while it is still growing to make room)
 * gets both minimums, and the overflow is clipped on the right.
 */
export function resolveWindowPanelWidths(windowWidthPx: number): PanelPairWidths {
  const subagent = Math.max(SUBAGENT_PANEL_MIN_PX, SUBAGENT_PANEL_DEFAULT_PX)
  if (windowWidthPx - subagent >= DETAIL_PANEL_MIN_PX) {
    return { detailWidthPx: windowWidthPx - subagent, subagentWidthPx: subagent }
  }
  return {
    detailWidthPx: DETAIL_PANEL_MIN_PX,
    subagentWidthPx: Math.max(SUBAGENT_PANEL_MIN_PX, windowWidthPx - DETAIL_PANEL_MIN_PX),
  }
}

/** The export's sidebar width (canvas 1a) — the default and the handle's double-click reset. */
export const SIDEBAR_DEFAULT_PX = 300
/** Below this the session rows' meta line and the footer's pill stop fitting. */
export const SIDEBAR_MIN_PX = 280
/** Ceiling as a share of the viewport. Lower than the detail panel's: the
 * sidebar is a list, not a reading surface, and both can be open at once. */
const SIDEBAR_MAX_VIEWPORT_SHARE = 0.45

/**
 * Clamps a candidate sidebar width to [280, 45% of the viewport]. The floor
 * wins when the two conflict on a very narrow window, exactly as
 * `clampDetailPanelWidth` resolves the same conflict.
 */
export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const ceiling = viewportWidth * SIDEBAR_MAX_VIEWPORT_SHARE
  return Math.max(SIDEBAR_MIN_PX, Math.min(ceiling, width))
}

/**
 * `sidebar_width` as the layout consumes it: parsed, falling back to the
 * export's 300 for a missing or unparsable value, then clamped.
 */
export function parseSidebarWidth(settings: Record<string, string>, viewportWidth: number): number {
  const raw = Number(settings.sidebar_width)
  return clampSidebarWidth(Number.isFinite(raw) ? raw : SIDEBAR_DEFAULT_PX, viewportWidth)
}

/** The context-threshold number inputs' range (canvas 1h: `min="1" max="99"`). */
export const CONTEXT_THRESHOLD_MIN = 1
export const CONTEXT_THRESHOLD_MAX = 99
/** Canvas 1h defaults, and what a garbage or inverted pair falls back to. */
export const DEFAULT_CONTEXT_THRESHOLD_WARN = 50
export const DEFAULT_CONTEXT_THRESHOLD_CRITICAL = 80

/**
 * The pair itself is declared in `lib/usage.ts`, beside the level function
 * that consumes it: the map's `Planet` reads thresholds without wanting the
 * store, and re-exporting the type here keeps every existing
 * `import { ... } from '../store/store'` working.
 */
export type { ContextThresholds }

/**
 * `context_threshold_warn`/`context_threshold_critical` as the arc and the
 * detail panel's context bar consume them (spec `context-fill-arc`): each
 * clamped to [1, 99], and if the pair comes out inverted (`warn >= critical`)
 * — including two garbage values that both fell back to the same default —
 * BOTH fall back to the canvas defaults rather than drawing a threshold order
 * that makes no sense on the arc.
 */
export function parseContextThresholds(settings: Record<string, string>): ContextThresholds {
  const fallback: ContextThresholds = {
    warn: DEFAULT_CONTEXT_THRESHOLD_WARN,
    critical: DEFAULT_CONTEXT_THRESHOLD_CRITICAL,
  }
  const rawWarn = Number(settings.context_threshold_warn)
  const rawCritical = Number(settings.context_threshold_critical)
  if (!Number.isFinite(rawWarn) || !Number.isFinite(rawCritical)) return fallback
  const warn = Math.min(CONTEXT_THRESHOLD_MAX, Math.max(CONTEXT_THRESHOLD_MIN, rawWarn))
  const critical = Math.min(CONTEXT_THRESHOLD_MAX, Math.max(CONTEXT_THRESHOLD_MIN, rawCritical))
  if (warn >= critical) return fallback
  return { warn, critical }
}

/** `map_show_context` — the arc/ticks/badge master switch. Default-on, same
 * convention as `map_show_model` (`sceneModel.ts`). */
export function showContext(settings: Record<string, string>): boolean {
  return settings.map_show_context !== 'false'
}

/** `map_show_compact_badge` — only effective while `showContext` is also on
 * (spec `context-fill-arc`); callers gate on both. Default-on convention. */
export function showCompactBadge(settings: Record<string, string>): boolean {
  return settings.map_show_compact_badge !== 'false'
}

/**
 * `transcript_edit_diffs` — whether an editing tool's row arrives open
 * (canvas `Feature - Transcript blocks` 20f). Default-off convention, unlike
 * the map switches above: the shipped value is `collapsed`, so only the exact
 * word turns it on and an unreadable value leaves the transcript as it was.
 */
export function editDiffsExpanded(settings: Record<string, string>): boolean {
  return settings.transcript_edit_diffs === 'expanded'
}

/**
 * `transcript_expand_diff_on_permission` — whether an edit the session is
 * blocked on opens regardless of the setting above. Default-on convention.
 */
export function expandDiffOnPermission(settings: Record<string, string>): boolean {
  return settings.transcript_expand_diff_on_permission !== 'false'
}

/** How a guarded approval is given. `hold` is the canvas gesture and the
 * shipped value; see the key's comment in `server/src/db/database.ts`. */
export type GuardGesture = 'hold' | 'confirm' | 'single'

/**
 * `permission_guard_gesture`, for the asks the CLI flagged `defaultToNo`.
 * Anything unreadable falls back to the guarded default rather than to the
 * unguarded one — a broken value must not quietly remove a safety.
 */
export function guardGesture(settings: Record<string, string>): GuardGesture {
  const value = settings.permission_guard_gesture
  return value === 'confirm' || value === 'single' ? value : 'hold'
}

/**
 * How the detail header carries session stats (canvas `Feature - Header
 * gauges` 11c):
 *
 * - `bar` — the strip under the context gauge, busy time and cost on it.
 * - `button` — no strip; stats joins the header's icon row and every number
 *   lives in the dialog behind it.
 */
export type HeaderSessionStats = 'bar' | 'button'

/** `header_session_stats`. The bar is the default, so only the literal
 * `button` turns the strip off — an unreadable value draws the readout. */
export function headerSessionStats(settings: Record<string, string>): HeaderSessionStats {
  return settings.header_session_stats === 'button' ? 'button' : 'bar'
}

/** `header_pull_request`, default off: only the literal `true` turns it on (spec 2026-09-30-branch-pr-and-line-changes-design § Settings). */
export function headerPullRequest(settings: Record<string, string>): boolean {
  return settings.header_pull_request === 'true'
}

/** `header_line_changes`, default off: an unknown value reads as off. */
export function headerLineChanges(settings: Record<string, string>): LinesMode {
  const value = settings.header_line_changes
  return value === 'branch' || value === 'split' ? value : 'off'
}

/** `map_show_trash`, default on: only the literal `false` hides the trash and its drop-to-end gesture. */
export function showTrash(settings: Record<string, string>): boolean {
  return settings.map_show_trash !== 'false'
}

/** `end_closes_panel`, default on: only the literal `false` keeps the panel open on the ended session. */
export function endClosesPanel(settings: Record<string, string>): boolean {
  return settings.end_closes_panel !== 'false'
}

/**
 * `map_state_pills` (Settings → Appearance → MAP, ADR
 * state-labels-are-dots-first-on-the-map). Dot-first is the default, so only
 * the literal `label` spells the words out — an unreadable value draws dots.
 */
export function mapStatePills(settings: Record<string, string>): MapStatePills {
  return settings.map_state_pills === 'label' ? 'label' : 'dot'
}

/** Map theme: Planets (default), Archipelago, or Desk renderer. */
export type MapTheme = 'planets' | 'archipelago' | 'desk'

/**
 * Which map renderer to use. Defaults to Planets. The theme changes only
 * the map surface; the sidebar, detail panel, subagent panel and every
 * dialog stay the same.
 */
export function mapTheme(settings: Record<string, string>): MapTheme {
  const value = settings.map_theme
  if (value === 'archipelago' || value === 'desk') return value
  return 'planets'
}

/**
 * What the space map draws: every session minus the ones the origin filter
 * excludes, minus every session that has left the map (`absorptionFor`). The
 * sidebar's tag filter and search are deliberately NOT applied: narrowing
 * must not reflow the layout, so a non-matching session stays on the map and
 * `buildSceneModel` mutes it (ADR `search-mutes-planets-instead-of-hiding-them`).
 * A session that is `leaving` is still returned — the scene keeps it, fading,
 * until its grace runs out. Nothing is dropped by age — an idle session that
 * has sat untouched for a month is still one the user has not ended.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so this stays pure
 * and `buildSceneModel` keeps its "same state in, same model out" contract.
 */
export function mapSessions(state: OrbitalState, nowMs: number): ApiSession[] {
  // The origin filter lives here rather than in `visibleSessions` so it can
  // narrow the map and the sidebar's ACTIVE list while leaving HISTORY whole
  // — see the ADR `origin-filter-scopes-to-map-and-active`. The map applies
  // it to ended planets too: it filters everything it draws, or the control
  // means nothing here.
  const origin = state.ui.sourceFilter
  const all = newestFirst(state.sessions)
  const list = origin === 'all' ? all : all.filter((session) => session.source === origin)

  return list.filter(
    (session) => absorptionFor(session, nowMs, state.leavingSince[session.id]) !== 'gone',
  )
}

export function statusCounts(state: OrbitalState, nowMs: number): Record<SessionStatus, number> {
  const counts: Record<SessionStatus, number> = {
    working: 0,
    idle: 0,
    needs_input: 0,
    ended: 0,
  }
  // Aggregates over mapSessions (post origin filter and post absorption),
  // since the aggregate describes what's currently on the map — but only the
  // planets matching the tag filter and the search. A muted planet is there
  // to hold its place, not to be counted, and the sidebar's lists already
  // leave it out.
  for (const session of mapSessions(state, nowMs)) {
    if (matchesSidebarFilters(session, state.ui)) counts[session.status] += 1
  }
  return counts
}
