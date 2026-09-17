import { create } from 'zustand'
import { api, ApiError } from '../lib/api'
import type {
  ApiSession,
  ChatMessage,
  ErrorRecord,
  OrbitalModel,
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
}

export interface OrbitalUiState {
  selectedId: string | null
  filterTagId: number | 'all'
  search: string
  sourceFilter: 'all' | SessionSource
  /**
   * Map-only suppression of `ended` planets (canvas 2a/2b). Deliberately NOT
   * part of `mapSessions`: the planets stay in the scene model so `Planet`
   * can fade them out, and so toggling never reflows the golden-angle
   * layout. The sidebar's HISTORY list ignores this entirely — hence the
   * "MAP ONLY · HISTORY LIST UNCHANGED" caption the artboard shows while it
   * is on.
   *
   * Persisted as the `map_hide_ended` setting — it survives a reload, and
   * `loadInitial` seeds this from the server.
   */
  hideEnded: boolean
  wsStatus: string
  dialog: null | 'new' | 'clear' | 'stop' | 'settings' | 'errors'
  /** Sidebar collapsed to its narrow rail (Panel's `collapsed` prop). See Sidebar.tsx (task 10). */
  sidebarCollapsed: boolean
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
  select(id: string): Promise<void>
  loadOlder(id: string): Promise<ChatMessage[]>
  sendPrompt(id: string, text: string): Promise<void>
  setFilterTag(filterTagId: number | 'all'): void
  setSearch(search: string): void
  setSourceFilter(sourceFilter: 'all' | SessionSource): void
  setHideEnded(hideEnded: boolean): void
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
 * Reset to `false` when a session's `status` event reports `working`
 * (a new turn starting), set `true` when a `turn_result` event arrives.
 * If `status` then reports `ended` while this is still `false`, the turn
 * ended without ever resolving — the SDK process crash error state.
 *
 * Caveat: a session whose `working` transition happened before this app
 * subscribed to its `session:<id>` topic (e.g. it was already `working` at
 * `loadInitial()` time) has no entry here yet, so an `ended` arriving for it
 * reads as "crashed" even if the turn actually completed normally off-screen.
 * Acceptable for this minimal v1 implementation — noted per the task brief.
 */
const turnResultSeen: Record<string, boolean> = {}

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
  hideEnded: false,
  wsStatus: 'connecting',
  dialog: null,
  sidebarCollapsed: false,
}

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
  toast: null,
  ui: initialUiState,

  async loadInitial() {
    const [sessions, tags, rules, settings, models, errorPage] = await Promise.all([
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
      // Seeded, not defaulted: the ENDED toggle is the one `ui` field the
      // server owns a value for, and reading it here is what makes the
      // toggle survive a reload.
      ui: { ...state.ui, hideEnded: settings.map_hide_ended === 'true' },
    }))
  },

  applySessionsEvent(msg) {
    const state = get()

    if (msg.event === 'upsert') {
      const sessions = { ...state.sessions, [msg.session.id]: msg.session }
      set({ sessions, order: sortIdsByLastAtDesc(sessions) })
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

      // SDK process crash: a turn started (`working`) and the session ended
      // without ever producing a `turn_result` in between.
      const crashed =
        msg.status === 'ended' && previousStatus === 'working' && !turnResultSeen[sessionId]

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
   * Flips the map's ENDED suppression and saves it. Optimistic on purpose:
   * the flip drives a half-second fade on every ended planet, and waiting
   * for a round trip before starting it would make the button feel stuck.
   * A failed save puts the toggle back rather than leaving the map showing
   * a preference the server never took.
   */
  setHideEnded(hideEnded) {
    const previous = get().ui.hideEnded
    if (previous === hideEnded) return
    set((state) => ({
      ui: { ...state.ui, hideEnded },
      settings: { ...state.settings, map_hide_ended: String(hideEnded) },
    }))
    api.patchSettings({ map_hide_ended: String(hideEnded) }).catch((err) => {
      const message = err instanceof Error ? err.message : 'Failed to save the ENDED toggle'
      set((state) => ({
        ui: { ...state.ui, hideEnded: previous },
        settings: { ...state.settings, map_hide_ended: String(previous) },
        toast: { kind: 'error', message },
      }))
    })
  },

  setDialog(dialog) {
    set((state) => ({ ui: { ...state.ui, dialog } }))
  },

  setSidebarCollapsed(sidebarCollapsed) {
    set((state) => ({ ui: { ...state.ui, sidebarCollapsed } }))
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

/** Sentinel for the map cutoff's "Never" preset: no age cutoff at all. */
export const ENDED_AGE_NEVER = 'never'
/** Used when `map_ended_max_age_days` is missing or unparseable. */
const DEFAULT_ENDED_MAX_AGE_DAYS = 1
const MS_PER_DAY = 86_400_000

/**
 * The map's `ended` age cutoff in milliseconds, or `null` for "never".
 *
 * Stored server-side as `map_ended_max_age_days` but applied here: the
 * cutoff decides what this client draws, not what the API returns. Keeping
 * it off the query is what leaves the sidebar's HISTORY list complete and
 * its `offset: visible.length` paging arithmetic intact.
 */
export function endedMaxAgeMs(settings: Record<string, string>): number | null {
  const raw = settings.map_ended_max_age_days
  if (raw === ENDED_AGE_NEVER) return null
  const days = Number(raw)
  if (!Number.isFinite(days) || days <= 0) return DEFAULT_ENDED_MAX_AGE_DAYS * MS_PER_DAY
  return days * MS_PER_DAY
}

/**
 * What the space map draws: `visibleSessions` minus the sessions the origin
 * filter excludes, minus `ended` sessions older than the cutoff. Live sessions
 * are never dropped by age — an idle terminal session that has sat untouched
 * for a month is still a real process.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so this stays pure
 * and `buildSceneModel` keeps its "same state in, same model out" contract.
 *
 * Note what is NOT here: `ui.hideEnded`. That is a per-planet render flag,
 * so hidden planets can fade out (canvas 2a animates opacity and scale over
 * .5s) and so toggling it never renumbers the golden-angle spiral and
 * teleports every other planet — the same hazard `withStableSessionOrder`
 * guards against in `sceneModel.ts`.
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

  const maxAgeMs = endedMaxAgeMs(state.settings)
  if (maxAgeMs === null) return list
  const oldest = nowMs - maxAgeMs
  // A missing `lastAt` reads as older than any cutoff: there is no evidence
  // of activity to place it inside one.
  return list.filter(
    (session) => session.status !== 'ended' || (session.lastAt ?? 0) >= oldest
  )
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
  // Aggregates over mapSessions (post tag/search/source filters and post age
  // cutoff), since the aggregate describes what's currently on the map. It is
  // deliberately blind to `hideEnded`: canvas 2b wants the ENDED count to
  // keep counting while suppressed — "it is what you click to bring them
  // back" — so a zero there would leave nothing to press.
  for (const session of mapSessions(state, nowMs)) {
    counts[session.status] += 1
  }
  return counts
}
