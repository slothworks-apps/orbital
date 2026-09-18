import { create } from 'zustand'
import { api, ApiError } from '../lib/api'
import { getSocket } from '../lib/socket'
import type {
  ApiSession,
  ChatMessage,
  ErrorRecord,
  OrbitalModel,
  PermissionMode,
  SessionSource,
  SessionStatus,
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
  | { event: 'turn_result'; usage: unknown }

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
  | { event: 'cleared'; unseen: number }

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
}

/** How many of the newest error rows the log holds at a time. */
export const ERROR_PAGE_SIZE = 50

export interface OrbitalState {
  sessions: Record<string, ApiSession>
  order: string[]
  tags: Tag[]
  rules: TagRule[]
  models: OrbitalModel[]
  settings: Record<string, string>
  transcripts: Record<string, ChatMessage[]>
  usage: Record<string, unknown>
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
   * How many sessions the whole index holds — the hole's label subtracts
   * the drawn planets from this (spec 2026-09-18-tag-clusters-design § 4).
   * Seeded by `GET /api/sessions/count` at load, then tracked off the
   * `sessions` WS topic (an upsert of an unknown id is a new row).
   */
  sessionsTotal: number
  toast: Toast | null
  ui: OrbitalUiState
}

export interface OrbitalActions {
  loadInitial(): Promise<void>
  applySessionsEvent(msg: SessionsEvent): void
  applySessionEvent(sessionId: string, msg: SessionEvent): void
  applyErrorsEvent(msg: ErrorsEvent): void
  markErrorsSeen(target: number[] | 'all'): Promise<void>
  clearErrorLog(): Promise<void>
  launchSession(body: {
    cwd: string
    prompt: string
    permissionMode: PermissionMode
    tagId?: number
    model?: string
  }): Promise<string>
  select(id: string): Promise<void>
  loadOlder(id: string): Promise<ChatMessage[]>
  sendPrompt(id: string, text: string): Promise<void>
  setFilterTag(filterTagId: number | 'all'): void
  setSearch(search: string): void
  setSourceFilter(sourceFilter: 'all' | SessionSource): void
  setSessionDismissed(id: string, dismissed: boolean): Promise<void>
  /** Moves (or, with null, clears) a tag clump's stored home on the map. */
  setTagAnchor(tagId: number, anchor: { x: number; y: number } | null): Promise<void>
  /** The hole's click: un-collapse the sidebar and scroll it to HISTORY. */
  revealHistory(): void
  setDialog(dialog: OrbitalUiState['dialog']): void
  setSidebarCollapsed(sidebarCollapsed: boolean): void
  setWsStatus(wsStatus: string): void
  clearToast(): void
}

export type OrbitalStore = OrbitalState & OrbitalActions

let localMessageCounter = 0

/** Generates a client-side id for optimistic messages. Prefixed so it can
 * never collide with a server-issued message id. */
function nextLocalMessageId(): string {
  localMessageCounter += 1
  return `local:${Date.now()}:${localMessageCounter}`
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
 * Marks the named rows as seen (`null` meaning every row), leaving
 * already-stamped rows on their original timestamp — the server's `markSeen`
 * never rewrites `seen_at` either, so re-opening the log must not make the
 * client disagree with it about when a row was first shown.
 */
function stampSeen(errors: ErrorRecord[], ids: number[] | null): ErrorRecord[] {
  const at = Date.now()
  const wanted = ids === null ? null : new Set(ids)
  return errors.map((error) =>
    error.seenAt === null && (wanted === null || wanted.has(error.id))
      ? { ...error, seenAt: at }
      : error,
  )
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
  settings: {},
  transcripts: {},
  usage: {},
  historyLoaded: {},
  transcriptErrors: {},
  lastTurnResultAt: {},
  errors: [],
  errorsUnseen: 0,
  sessionsTotal: 0,
  toast: null,
  ui: initialUiState,

  async loadInitial() {
    const [sessions, tags, rules, settings, models, errorPage, sessionsTotal] = await Promise.all([
      api.listSessions(),
      api.listTags(),
      api.listTagRules(),
      api.getSettings(),
      // Best-effort: a failed probe with nothing cached yields [], and every
      // surface that reads the catalog has an empty state for exactly that.
      api.listModels().catch(() => [] as OrbitalModel[]),
      // Also best-effort, and for a sharper reason than the catalog's: this
      // is the error surface. It failing must not be the thing that stops
      // the app from mounting and showing the other errors.
      api.listErrors({ limit: ERROR_PAGE_SIZE }).catch(() => null),
      // Best-effort too: the hole's label reading 0 sessions is a cosmetic
      // failure, not a reason to keep the map from mounting.
      api.sessionCount().catch(() => 0),
    ])

    const sessionsMap: Record<string, ApiSession> = {}
    for (const session of sessions) {
      sessionsMap[session.id] = session
    }

    set((state) => ({
      sessions: sessionsMap,
      order: sortIdsByLastAtDesc(sessionsMap),
      tags,
      rules,
      settings,
      models,
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

  applySessionsEvent(msg) {
    const state = get()

    if (msg.event === 'upsert') {
      const isNew = !(msg.session.id in state.sessions)
      const sessions = { ...state.sessions, [msg.session.id]: msg.session }
      set({
        sessions,
        order: sortIdsByLastAtDesc(sessions),
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
      // message in place (same trimmed text) instead of appending, so the
      // transcript doesn't show two copies of the same user bubble.
      if (msg.message.role === 'user') {
        const incomingText = (msg.message.text ?? '').trim()
        const pendingIdx = existing.findIndex(
          (m) =>
            m.id.startsWith('local:') &&
            m.role === 'user' &&
            (m.text ?? '').trim() === incomingText,
        )
        if (pendingIdx >= 0) {
          const updated = existing.slice()
          updated[pendingIdx] = msg.message
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
        ...(crashed
          ? { transcriptErrors: { ...state.transcriptErrors, [sessionId]: true } }
          : {}),
      })
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
        usage: { ...state.usage, [sessionId]: msg.usage },
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
      set({ errors: stampSeen(state.errors, msg.ids), errorsUnseen: msg.unseen })
      return
    }

    if (msg.event === 'cleared') {
      set({ errors: [], errorsUnseen: msg.unseen ?? 0 })
    }
  },

  /**
   * Stamps `seen_at` on the rows the log has shown. The only thing that
   * lowers the unseen count. Silent on failure: a log the user is already
   * looking at should not raise an error toast about its own bookkeeping,
   * and reporting it would feed the very list it failed to mark.
   */
  async markErrorsSeen(target) {
    if (target !== 'all' && target.length === 0) return
    try {
      const result = await api.markErrorsSeen(target)
      set((state) => ({
        errors: stampSeen(state.errors, target === 'all' ? null : target),
        errorsUnseen: result?.unseen ?? 0,
      }))
    } catch (err) {
      console.error('orbital: failed to mark errors seen', err)
    }
  },

  async clearErrorLog() {
    try {
      await api.clearErrors()
      set({ errors: [], errorsUnseen: 0 })
    } catch (err) {
      console.error('orbital: failed to clear the error log', err)
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
    set((state) => ({ ui: { ...state.ui, selectedId: id } }))

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

  async sendPrompt(id, text) {
    const optimisticMessage: ChatMessage = {
      id: nextLocalMessageId(),
      role: 'user',
      text,
      timestamp: new Date().toISOString(),
    }

    set((state) => ({
      transcripts: {
        ...state.transcripts,
        [id]: [...(state.transcripts[id] ?? []), optimisticMessage],
      },
    }))

    try {
      await api.sendMessage(id, text)
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
    const previous = session.mapDismissedAt
    const stamp = (value: number | null) =>
      set((state) => {
        const current = state.sessions[id]
        if (!current) return {}
        return {
          sessions: { ...state.sessions, [id]: { ...current, mapDismissedAt: value } },
        }
      })
    stamp(dismissed ? Date.now() : null)
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
      message: `${title} absorbed — still in the sidebar's history`,
      action: { label: 'Undo', run: () => void get().setSessionDismissed(id, false) },
    }
    set({ toast })
    setTimeout(() => {
      // Only expire OUR toast: something newer showing must stay.
      if (get().toast === toast) set({ toast: null })
    }, UNDO_TOAST_MS)
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
  },

  clearToast() {
    set({ toast: null })
  },
}))

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
      (s) =>
        s.title.toLowerCase().includes(query) ||
        s.cwd.toLowerCase().includes(query)
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
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_RELEASE_AFTER_MINUTES * MS_PER_MINUTE
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
 */
export function absorptionFor(
  session: ApiSession,
  settings: Record<string, string>,
  nowMs: number
): 'none' | 'releasing' | 'absorbed' {
  if (session.status === 'working' || session.status === 'needs_input') return 'none'
  if (session.mapDismissedAt != null) {
    return nowMs - session.mapDismissedAt < RELEASE_FALL_GRACE_MS ? 'releasing' : 'absorbed'
  }
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
/** Below this the header's three-column usage grid and the composer's action row stop fitting. */
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
  viewportWidth: number
): number {
  const raw = Number(settings.detail_panel_width)
  return clampDetailPanelWidth(Number.isFinite(raw) ? raw : DETAIL_PANEL_DEFAULT_PX, viewportWidth)
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

export function statusCounts(
  state: OrbitalState,
  nowMs: number
): Record<SessionStatus, number> {
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
