import { create } from 'zustand'
import { api, ApiError } from '../lib/api'
import { getSocket } from '../lib/socket'
import { completedAnswers, openQuestion, type AnswerMap } from '../lib/questionCard'
import { isAttachable, promptWithSelection, selectionId } from '../lib/ideSelection'
import { withViewTransition } from '../lib/viewTransition'
import { focusSession } from '../lib/desktop'
import { MAX_SUBAGENT_MESSAGES } from '../lib/types'
import type { ContextThresholds } from '../lib/usage'
import type {
  ApiSession,
  AttachmentSource,
  ChatMessage,
  ErrorRecord,
  ImageRefEntry,
  OrbitalModel,
  PendingDecision,
  PermissionMode,
  SessionSource,
  SessionStatus,
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
 * Events delivered on the `subagent:<sessionId>:<toolUseId>` topic — one
 * `message` per live append to that agent's buffer, mirroring `session:<id>`'s
 * own event exactly (spec: 2026-09-22-subagent-transcript-panel-design.md
 * § 9). Nothing else rides this topic: the panel is frozen by its
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
export type SubagentEvent = {
  event: 'message'
  message: ChatMessage
  droppedCount?: number
}

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

export interface Toast {
  kind: 'error' | 'info'
  message: string
  /**
   * One optional action button ("Undo" on an absorption toast). `run` is
   * called on click; the toast is cleared by the caller of `run`, not here.
   */
  action?: { label: string; run: () => void }
}

export interface OrbitalUiState {
  selectedId: string | null
  filterTagId: number | 'all'
  search: string
  sourceFilter: 'all' | SessionSource
  wsStatus: string
  dialog: null | 'new' | 'clear' | 'stop' | 'settings' | 'errors'
  /**
   * The file the read-only viewer is showing over the app, or null when it
   * is closed (spec: 2026-09-19-file-viewer-design). Plain synchronous UI
   * state like `selectedId` — never persisted; the URL mirror in
   * `lib/sessionUrl.ts` is what survives a reload. The viewer always
   * belongs to the selected session, so `select()`ing a different session
   * closes it.
   */
  fileViewer: { path: string; line: number | null } | null
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
  settings: Record<string, string>
  transcripts: Record<string, ChatMessage[]>
  /** Tracks which sessions have had their initial message history fetched, so
   * `select()` only ever fetches once per session regardless of how many
   * live messages have already arrived over the WS for that session. */
  historyLoaded: Record<string, boolean>
  /** Sessions that transitioned `working` -> `ended` on the `session:<id>`
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
  toast: Toast | null
  ui: OrbitalUiState
  /** The one open subagent panel, or null — see `OpenSubagentState`. */
  subagentPanel: OpenSubagentState | null
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
   * The catch-up after the socket was away (spec:
   * 2026-09-22-ws-reconnect-resync-design). Nothing is replayed over the WS,
   * so every event published during the outage is only recoverable over REST.
   */
  resyncAfterReconnect(): Promise<void>
  applySessionsEvent(msg: SessionsEvent): void
  applySessionEvent(sessionId: string, msg: SessionEvent): void
  applyErrorsEvent(msg: ErrorsEvent): void
  markErrorsSeen(target: number[] | 'all'): Promise<void>
  launchSession(body: {
    cwd: string
    prompt: string
    permissionMode: PermissionMode
    tagId?: number
    model?: string
    /** Image refs the dialog's first turn carries (spec: 2026-09-20-composer-design). */
    attachments?: string[]
  }): Promise<string>
  select(id: string): Promise<void>
  loadOlder(id: string): Promise<ChatMessage[]>
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
  setFilterTag(filterTagId: number | 'all'): void
  setSearch(search: string): void
  setSourceFilter(sourceFilter: 'all' | SessionSource): void
  setSessionDismissed(id: string, dismissed: boolean): Promise<void>
  /** Pins (or unpins) a session — the manual exemption from the release timer. */
  setSessionPinned(id: string, pinned: boolean): Promise<void>
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
   * scroll target a path button carried, absent for a bare path. */
  openFile(path: string, line?: number | null): void
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
   * Dismisses one ended moon (spec § 4/9, task 9 brief). Fires the request
   * and returns — no optimistic local removal. The route is idempotent and
   * 204s, and the server republishes the session on success, which is what
   * actually removes the moon: through the normal `sessions` topic, the
   * SAME path every other session mutation already takes, rather than a
   * second, parallel "remove this one locally" code path that could disagree
   * with the republish arriving a moment later.
   */
  dismissSubagent(sessionId: string, agentId: string): Promise<void>
  /**
   * Applies one live message off an open agent's `subagent:<sessionId>:<toolUseId>`
   * topic. Exposed as its own action — like `applySessionEvent` — so the
   * dedupe/staleness rules are testable without going through a real socket.
   */
  applySubagentEvent(sessionId: string, toolUseId: string, msg: SubagentEvent): void
}

export type OrbitalStore = OrbitalState & OrbitalActions

let localMessageCounter = 0

/**
 * Whether the socket has been seen `closed` since it was last `open`. It is
 * what tells a reconnect apart from the first connection: the page's opening
 * `connecting -> open` is not an outage and must not trigger the catch-up.
 */
let sawClosedSocket = false

/** Generates a client-side id for optimistic messages. Prefixed so it can
 * never collide with a server-issued message id. */
function nextLocalMessageId(): string {
  localMessageCounter += 1
  return `local:${Date.now()}:${localMessageCounter}`
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
 * Non-reactive bookkeeping (not store state — nothing needs to re-render off
 * this changing, only off the `transcriptErrors` flag it feeds) tracking
 * whether the session's current turn has already produced a `turn_result`.
 *
 * Three states, and the third is the one that matters:
 *
 * - `false` — this tab watched the turn start (a `status` event reporting
 *   `working`) and has not seen it resolve. An `ended` now means the turn
 *   ended without ever resolving: the SDK process crash error state.
 * - `true` — a `turn_result` arrived. The turn resolved; not a crash.
 * - `undefined` — no entry, because this tab never saw this session start a
 *   turn at all. Its `working` transition happened before the app subscribed
 *   to its `session:<id>` topic (it was already `working` at `loadInitial()`
 *   time). We have no evidence either way, and absence of evidence is not a
 *   crash — so an `ended` for such a session is left alone.
 *
 * Hence the crash check tests for an explicit `false` rather than for
 * falsiness: `!undefined` would accuse a session this tab never watched of a
 * failure that most likely never happened
 * (`docs/fixes/a-session-already-working-at-mount-reads-as-crashed.md`).
 */
const turnResultSeen: Record<string, boolean | undefined> = {}

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
 * Released when the session ends, which is the one moment after which the
 * topic can say nothing further.
 */
const launchSubscriptions = new Map<string, () => void>()

function releaseLaunchSubscription(sessionId: string): void {
  const release = launchSubscriptions.get(sessionId)
  if (!release) return
  launchSubscriptions.delete(sessionId)
  release()
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

/** How long the absorption toast (and its Undo) stays up. Canvas 4a: "Undo 10 s". */
export const UNDO_TOAST_MS = 10_000

export const useOrbital = create<OrbitalStore>()((set, get) => ({
  sessions: {},
  order: [],
  tags: [],
  rules: [],
  models: [],
  contextWindows: {},
  settings: {},
  transcripts: {},
  historyLoaded: {},
  transcriptErrors: {},
  lastTurnResultAt: {},
  statsRevision: {},
  errors: [],
  errorsUnseen: 0,
  pendingDecisions: {},
  decisionAnswers: {},
  decisionVerdicts: {},
  ideDismissed: {},
  detachedIds: [],
  sessionsTotal: 0,
  toast: null,
  ui: initialUiState,
  subagentPanel: null,

  async loadInitial() {
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
      // it, at the cost of one click.
      const selectedId = get().ui.selectedId
      // Fetched before the swap, so the open transcript never flashes empty.
      const fetched = selectedId ? await api.getMessages(selectedId) : null

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
    } catch {
      // A failed catch-up leaves the caches as they were; the next reconnect,
      // or a manual reload, tries again.
    }
  },

  applySessionsEvent(msg) {
    const state = get()

    if (msg.event === 'upsert') {
      const isNew = !(msg.session.id in state.sessions)
      const sessions = { ...state.sessions, [msg.session.id]: msg.session }
      set({
        sessions,
        order: sortIdsByLastAtDesc(sessions),
        ...seedDecision(state, msg.session),
        // An upsert of an unknown id is a new index row, so the hole's total
        // moves with it. A re-upsert of a known session is just a change.
        ...(isNew ? { sessionsTotal: state.sessionsTotal + 1 } : {}),
      })
      return
    }

    if (msg.event === 'status') {
      const existing = state.sessions[msg.sessionId]
      if (!existing) {
        // Unknown session: refetch it from the API rather than dropping
        // the event, since we don't have a row to merge the status into.
        api
          .getSession(msg.sessionId)
          .then(({ session }) => {
            get().applySessionsEvent({ event: 'upsert', session })
          })
          .catch(() => {
            // Session may have been deleted server-side between the event
            // and the refetch; nothing sensible to do here.
          })
        return
      }
      const sessions = {
        ...state.sessions,
        [msg.sessionId]: { ...existing, status: msg.status },
      }
      set({ sessions })
      return
    }

    if (msg.event === 'remove') {
      if (!(msg.sessionId in state.sessions)) return
      const sessions = { ...state.sessions }
      delete sessions[msg.sessionId]
      set({
        sessions,
        order: state.order.filter((id) => id !== msg.sessionId),
        sessionsTotal: Math.max(0, state.sessionsTotal - 1),
      })
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
      if (get().subagentPanel?.sessionId === msg.sessionId) get().closeSubagent()
    }
  },

  applySessionEvent(sessionId, msg) {
    const state = get()

    if (msg.event === 'message') {
      const existing = state.transcripts[sessionId] ?? []
      if (existing.some((m) => m.id === msg.message.id)) return

      // The server echo of a user message we already appended optimistically
      // (see `sendPrompt`) arrives with its own, server-issued id — dedup by
      // id above can't catch it. Replace the matching pending `local:`
      // message in place (same trimmed text AND the same image refs) instead
      // of appending, so the transcript doesn't show two copies of the same
      // user bubble.
      //
      // The refs are part of the match because text alone stopped being
      // distinguishing once a turn could be image-only: two pasted screenshots
      // are two turns with identical (empty) text, and matching on text would
      // have the second echo overwrite the first bubble. The store is
      // content-addressed, so same bytes mean the same ref on both sides —
      // there is nothing to normalise (spec: 2026-09-20-composer-design
      // § Store + wire).
      if (msg.message.role === 'user') {
        const incomingText = (msg.message.text ?? '').trim()
        const incomingRefs = imageRefKey(msg.message.images)
        const pendingIdx = existing.findIndex(
          (m) =>
            m.id.startsWith('local:') &&
            m.role === 'user' &&
            (m.text ?? '').trim() === incomingText &&
            imageRefKey(m.images) === incomingRefs,
        )
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
      }

      set({
        transcripts: {
          ...state.transcripts,
          [sessionId]: [...existing, msg.message],
        },
      })
      return
    }

    if (msg.event === 'status') {
      const session = state.sessions[sessionId]
      if (!session) return
      const previousStatus = session.status

      if (msg.status === 'working') {
        turnResultSeen[sessionId] = false
      }

      // An ended session's topic has nothing left to say, so the subscription
      // `launchSession` opened ahead of the request is done. Harmless if there
      // is none — every session that was not launched from this tab.
      if (msg.status === 'ended') releaseLaunchSubscription(sessionId)

      // SDK process crash: a turn started (`working`) and the session ended
      // without ever producing a `turn_result` in between. Explicitly
      // `false`, never merely falsy — `undefined` means this tab never
      // watched the turn start and so has nothing to accuse it of.
      const crashed =
        msg.status === 'ended' &&
        previousStatus === 'working' &&
        turnResultSeen[sessionId] === false

      set({
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, status: msg.status },
        },
        ...(crashed ? { transcriptErrors: { ...state.transcriptErrors, [sessionId]: true } } : {}),
      })
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
      set({
        transcriptErrors,
        // Same clearing, for the recorded error. The flag above cannot cover
        // it: the record is a database row that outlives this transition, so
        // what it needs is a moment to be compared against, not a reset.
        lastTurnResultAt: { ...state.lastTurnResultAt, [sessionId]: Date.now() },
      })
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
        toast: { kind: 'error', message: msg.error.message },
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

  async launchSession(body) {
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

    let started: string
    try {
      started = await api.createSession({ ...body, sessionId })
    } catch (err) {
      releaseLaunchSubscription(sessionId)
      throw err
    }

    // The server echoes the id back, and it should be the one we sent — it
    // either takes ours or refuses the request. If it ever isn't, we are
    // subscribed to a topic nothing will publish on, which is the exact
    // failure this whole change is about, so move rather than assume.
    if (started !== sessionId) {
      releaseLaunchSubscription(sessionId)
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

    if (get().historyLoaded[id]) return

    try {
      const fetched = await api.getMessages(id)
      set((state) => {
        const existing = state.transcripts[id] ?? []
        const existingIds = new Set(existing.map((m) => m.id))
        const toPrepend = fetched.filter((m) => !existingIds.has(m.id))
        return {
          transcripts: {
            ...state.transcripts,
            [id]: [...toPrepend, ...existing],
          },
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
   * Returns the fetched page so callers (Transcript's "load older" button)
   * can tell an empty response apart from one still in flight — there was
   * no existing store action for this, so it's added here per task 11.
   */
  async loadOlder(id) {
    const existing = get().transcripts[id] ?? []
    const firstId = existing[0]?.id
    if (!firstId) return []

    try {
      const fetched = await api.getMessages(id, { before: firstId })
      set((state) => {
        const current = state.transcripts[id] ?? []
        const currentIds = new Set(current.map((m) => m.id))
        const toPrepend = fetched.filter((m) => !currentIds.has(m.id))
        return {
          transcripts: {
            ...state.transcripts,
            [id]: [...toPrepend, ...current],
          },
        }
      })
      return fetched
    } catch {
      return []
    }
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
    // session only, by the lip's ×.
    //
    // Deliberately after the decision branch above: an answer to a question,
    // or the reason on a refused permission, is words meant for the ask — not
    // a new turn, and nothing rides on it.
    const session = get().sessions[id]
    const selection = session?.ide?.selection ?? null
    const outgoing =
      isAttachable(selection) && get().ideDismissed[id] !== selectionId(selection)
        ? promptWithSelection(text, session?.cwd ?? '', selection)
        : text

    const images = attachments?.map((a) => a.entry)
    const optimisticMessage: ChatMessage = {
      id: nextLocalMessageId(),
      role: 'user',
      // What was SENT, not what was typed: the echo that comes back off the
      // transcript carries the block too, and an optimistic turn that showed
      // less would be replaced by a longer one a moment later.
      text: outgoing,
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

    set((state) => ({
      transcripts: {
        ...state.transcripts,
        [id]: [...(state.transcripts[id] ?? []), optimisticMessage],
      },
    }))

    try {
      // Two-argument call for a text-only turn, deliberately: a trailing
      // `undefined` is a different call as far as every existing assertion in
      // the suite is concerned, and a plain turn's wire shape has not changed.
      if (images && images.length > 0) {
        await api.sendMessage(
          id,
          outgoing,
          images.map((image) => image.ref),
        )
      } else {
        await api.sendMessage(id, outgoing)
      }
    } catch (err) {
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

    const answers: AnswerMap = {
      ...(get().decisionAnswers[decision.id] ?? {}),
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
      const message = err instanceof Error ? err.message : 'Failed to send the answer'
      set({ toast: { kind: 'error', message } })
    })
  },

  dismissIdeSelection(sessionId, selectionId) {
    set((state) => ({ ideDismissed: { ...state.ideDismissed, [sessionId]: selectionId } }))
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
   * Stamps (or, for the undo, clears) a session's map-only dismissal — the
   * hole's absorption (spec 2026-09-18-tag-clusters-design § 5). Optimistic:
   * the stamp is what starts the fall animation, and waiting a round trip
   * before letting go of the body would make the drop feel stuck. A failed
   * save puts the stamp back and reports.
   *
   * A successful dismissal raises the undo toast; the toast expires after
   * `UNDO_TOAST_MS` (the session itself stays one click away in the
   * sidebar's HISTORY, so the undo is a convenience, not the only way back).
   */
  async setSessionDismissed(id, dismissed) {
    const session = get().sessions[id]
    if (!session) return
    const previous = { mapDismissedAt: session.mapDismissedAt, pinnedAt: session.pinnedAt ?? null }
    const wasPinned = previous.pinnedAt != null
    const stamp = (fields: { mapDismissedAt: number | null; pinnedAt: number | null }) => {
      const write = () =>
        set((state) => {
          const current = state.sessions[id]
          if (!current) return {}
          return { sessions: { ...state.sessions, [id]: { ...current, ...fields } } }
        })
      // A dismissal only moves a sidebar row when it takes a pin with it —
      // absorbing an unpinned session changes the map, and the row stays
      // where it is. So the view transition is spent on the case that has
      // something to animate, and the rest of the map's traffic is untouched.
      if (wasPinned) withViewTransition(write)
      else write()
    }
    // The manual gesture wins: the server clears `pinned_at` as it stamps a
    // dismissal, so the optimistic state has to clear it too or the row
    // would sit in PINNED while its planet falls (spec § Rules).
    stamp(
      dismissed
        ? { mapDismissedAt: Date.now(), pinnedAt: null }
        : { mapDismissedAt: null, pinnedAt: previous.pinnedAt },
    )
    try {
      await api.setSessionDismissed(id, dismissed)
    } catch (err) {
      stamp(previous)
      const message = err instanceof Error ? err.message : 'Failed to save the dismissal'
      set({ toast: { kind: 'error', message } })
      return
    }
    if (!dismissed) return
    const title = session.title || 'Session'
    const toast: Toast = {
      kind: 'info',
      message: wasPinned
        ? `${title} absorbed · pin removed`
        : `${title} absorbed — still in the sidebar's history`,
      action: {
        label: 'Undo',
        // Re-pinning is the whole undo for a pinned session: the `pinned`
        // route clears `map_dismissed_at`, so one call brings back both the
        // pin and the planet (4d `drag.toast`).
        run: () =>
          void (wasPinned
            ? get().setSessionPinned(id, true)
            : get().setSessionDismissed(id, false)),
      },
    }
    set({ toast })
    setTimeout(() => {
      // Only expire OUR toast: something newer showing must stay.
      if (get().toast === toast) set({ toast: null })
    }, UNDO_TOAST_MS)
  },

  /**
   * Pins (or unpins) a session — the manual exemption from the map's release
   * timer (spec 2026-09-20-pinned-sessions-design). Optimistic like the
   * dismissal: the toggle lives in two surfaces that have to agree within a
   * frame, and a round trip between the click and the row moving into PINNED
   * would read as a stuck control. A failed save puts both fields back and
   * reports.
   *
   * Pinning clears `mapDismissedAt` locally because the server clears it too
   * — that is what pulls an absorbed session back onto the map. No undo
   * toast: unpinning is the same one click that pinned.
   *
   * Both stamps go through `withViewTransition` so the sidebar row slides
   * between PINNED and its old section instead of teleporting. It sits here
   * rather than in the two buttons because there are three ways in — the
   * sidebar row's pin, the detail panel's, and the absorption toast's undo —
   * and a row that animates from one of them and jumps from another would
   * read as a bug. The rollback is wrapped too: a failed save sends the row
   * back, which is the same move in reverse.
   */
  async setSessionPinned(id, pinned) {
    const session = get().sessions[id]
    if (!session) return
    const previous = { pinnedAt: session.pinnedAt ?? null, mapDismissedAt: session.mapDismissedAt }
    const stamp = (fields: { pinnedAt: number | null; mapDismissedAt: number | null }) =>
      withViewTransition(() =>
        set((state) => {
          const current = state.sessions[id]
          if (!current) return {}
          return { sessions: { ...state.sessions, [id]: { ...current, ...fields } } }
        }),
      )
    stamp(
      pinned
        ? { pinnedAt: Date.now(), mapDismissedAt: null }
        : { pinnedAt: null, mapDismissedAt: previous.mapDismissedAt },
    )
    try {
      await api.setSessionPinned(id, pinned)
    } catch (err) {
      stamp(previous)
      const message = err instanceof Error ? err.message : 'Failed to save the pin'
      set({ toast: { kind: 'error', message } })
    }
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

  openFile(path, line) {
    set((state) => ({ ui: { ...state.ui, fileViewer: { path, line: line ?? null } } }))
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
    // from a fresh one.
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
        set({ subagentPanel: { ...current, messages: [], droppedCount: 0, found: false } })
        return
      }
      const message = err instanceof Error ? err.message : 'Failed to load the subagent transcript'
      set({ toast: { kind: 'error', message } })
    }
  },

  closeSubagent() {
    releaseSubagentSubscription()
    set({ subagentPanel: null })
  },

  async dismissSubagent(sessionId, agentId) {
    try {
      await api.dismissSubagent(sessionId, agentId)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to dismiss the subagent'
      set({ toast: { kind: 'error', message } })
    }
  },

  applySubagentEvent(sessionId, toolUseId, msg) {
    const panel = get().subagentPanel
    // Guards identity the same way `openSubagent`'s own continuations do —
    // belt-and-suspenders, since `releaseSubagentSubscription` already runs
    // synchronously before a new subscribe, so a handler for a topic this
    // panel no longer owns should never fire at all.
    if (!panel || panel.sessionId !== sessionId || panel.subagent.toolUseId !== toolUseId) return
    if (panel.messages.some((m) => m.id === msg.message.id)) return
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
        droppedCount: msg.droppedCount ?? panel.droppedCount,
      },
    })
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
})

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
 * The most recent recorded error for one session, or `undefined`.
 *
 * `errors` is newest-first, so the first match is the latest. Safe to call
 * straight from a `useOrbital` selector: it returns an element of the array,
 * not a new object, so the reference is stable until the log itself changes.
 */
export function latestErrorForSession(
  errors: ErrorRecord[],
  sessionId: string,
): ErrorRecord | undefined {
  return errors.find((error) => error.sessionId === sessionId)
}

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
 */
export function recordedFailureFor(
  state: Pick<OrbitalState, 'errors' | 'sessions' | 'lastTurnResultAt'>,
  sessionId: string,
): ErrorRecord | undefined {
  const latest = latestErrorForSession(state.errors, sessionId)
  if (!latest) return undefined
  const turnAt = state.lastTurnResultAt[sessionId]
  if (turnAt != null && turnAt > latest.at) return undefined
  const lastAt = state.sessions[sessionId]?.lastAt
  if (lastAt != null && lastAt > latest.at) return undefined
  return latest
}

export function visibleSessions(state: OrbitalState): ApiSession[] {
  let list = Object.values(state.sessions)

  if (state.ui.filterTagId !== 'all') {
    const tagId = state.ui.filterTagId
    list = list.filter((s) => s.tagIds.includes(tagId))
  }

  const query = state.ui.search.trim().toLowerCase()
  if (query) {
    list = list.filter(
      (s) => s.title.toLowerCase().includes(query) || s.cwd.toLowerCase().includes(query),
    )
  }

  return list.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
}

/** Sentinel for the release delay's "Never" preset: bonds are never cut by time. */
export const RELEASE_NEVER = 'never'
/** Used when `map_release_ended_after_minutes` is missing or unparseable. Canvas 4b: "after 2 h". */
const DEFAULT_RELEASE_AFTER_MINUTES = 120
const MS_PER_MINUTE = 60_000
/**
 * How long past its release a session stays in the scene as a falling body
 * before it is dropped outright. The slow ambient fall is ~8s (canvas 4a);
 * anything that releases while the map is closed simply never plays it.
 */
export const RELEASE_FALL_GRACE_MS = 15_000

/**
 * The delay after which an `ended` session's tag bond is cut and it falls
 * into the hole, in milliseconds — or `null` for "never" (spec
 * 2026-09-18-tag-clusters-design § 5-6).
 *
 * Stored server-side as `map_release_ended_after_minutes` but applied here:
 * the release decides what this client draws, not what the API returns.
 * Keeping it off the query is what leaves the sidebar's HISTORY list
 * complete and its `offset: visible.length` paging arithmetic intact.
 */
export function releaseDelayMs(settings: Record<string, string>): number | null {
  const raw = settings.map_release_ended_after_minutes
  if (raw === RELEASE_NEVER) return null
  const minutes = Number(raw)
  if (!Number.isFinite(minutes) || minutes <= 0)
    return DEFAULT_RELEASE_AFTER_MINUTES * MS_PER_MINUTE
  return minutes * MS_PER_MINUTE
}

/**
 * Where a session stands with the hole:
 *
 * - `none` — bonded (or live); drawn normally.
 * - `releasing` — its bond was just cut (manually, or the release delay
 *   elapsed); still in the scene so the fall can play.
 * - `absorbed` — gone from the map. Still whole in the sidebar and search.
 *
 * A `working`/`needs_input` session is always `none`: the map never lies
 * about what is running, whatever a stale dismissal stamp says (the server
 * clears stamps on activity, this is the client-side belt to that brace).
 * An ended session with no `lastAt` is `absorbed` outright — there is no
 * moment to measure a fall from, and animating ancient history out of the
 * map on every load would be noise.
 *
 * A pinned session is `none` however long it has been ended: the pin is the
 * manual exemption from the release timer (spec
 * 2026-09-20-pinned-sessions-design). It is checked AFTER `mapDismissedAt`
 * and not before, because the manual gesture wins — the server clears the
 * pin when it stamps a dismissal, so a row carrying both is mid-flight and
 * the stamp is the newer word.
 */
export function absorptionFor(
  session: ApiSession,
  settings: Record<string, string>,
  nowMs: number,
): 'none' | 'releasing' | 'absorbed' {
  if (session.status === 'working' || session.status === 'needs_input') return 'none'
  if (session.mapDismissedAt != null) {
    return nowMs - session.mapDismissedAt < RELEASE_FALL_GRACE_MS ? 'releasing' : 'absorbed'
  }
  if (session.pinnedAt != null) return 'none'
  if (session.status !== 'ended') return 'none'
  const delay = releaseDelayMs(settings)
  if (delay === null) return 'none'
  if (session.lastAt == null) return 'absorbed'
  const releasedForMs = nowMs - (session.lastAt + delay)
  if (releasedForMs < 0) return 'none'
  return releasedForMs < RELEASE_FALL_GRACE_MS ? 'releasing' : 'absorbed'
}

/** The Appearance slider's range (canvas 5a: 0.70×–1.60×, step 0.05). */
export const PLANET_SCALE_MIN = 0.7
export const PLANET_SCALE_MAX = 1.6

/**
 * `planet_scale` as the map consumes it: the stored multiplier parsed and
 * clamped to the slider's own range, falling back to 1 (the default) for a
 * missing or unparsable value. Applied to drawn body scale only — layout,
 * orbits and cluster spacing never see it (spec:
 * 2026-09-18-planet-size-design).
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

/**
 * What the space map draws: `visibleSessions` minus the sessions the origin
 * filter excludes, minus everything the hole has absorbed (`absorptionFor`).
 * A session that is `releasing` is still returned — the scene keeps it as a
 * falling body until its grace runs out. Live sessions are never dropped by
 * time — an idle terminal session that has sat untouched for a month is
 * still a real process.
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
  const list =
    origin === 'all'
      ? visibleSessions(state)
      : visibleSessions(state).filter((session) => session.source === origin)

  return list.filter((session) => absorptionFor(session, state.settings, nowMs) !== 'absorbed')
}

export function statusCounts(state: OrbitalState, nowMs: number): Record<SessionStatus, number> {
  const counts: Record<SessionStatus, number> = {
    working: 0,
    idle: 0,
    needs_input: 0,
    ended: 0,
  }
  // Aggregates over mapSessions (post tag/search/source filters and post
  // absorption), since the aggregate describes what's currently on the map.
  for (const session of mapSessions(state, nowMs)) {
    counts[session.status] += 1
  }
  return counts
}
