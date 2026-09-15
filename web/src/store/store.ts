import { create } from 'zustand'
import { api, ApiError } from '../lib/api'
import type {
  ApiSession,
  ChatMessage,
  Subagent,
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
  | { event: 'subagent'; subagent: Subagent }
  | { event: 'turn_result'; usage: unknown }

export interface Toast {
  kind: 'error' | 'info'
  message: string
}

export interface OrbitalUiState {
  selectedId: string | null
  filterTagId: number | 'all'
  search: string
  sourceFilter: 'all' | SessionSource
  wsStatus: string
  dialog: null | 'new' | 'clear' | 'stop'
}

export interface OrbitalState {
  sessions: Record<string, ApiSession>
  order: string[]
  tags: Tag[]
  rules: TagRule[]
  settings: Record<string, string>
  transcripts: Record<string, ChatMessage[]>
  subagents: Record<string, Subagent[]>
  usage: Record<string, unknown>
  /** Tracks which sessions have had their initial message history fetched, so
   * `select()` only ever fetches once per session regardless of how many
   * live messages have already arrived over the WS for that session. */
  historyLoaded: Record<string, boolean>
  toast: Toast | null
  ui: OrbitalUiState
}

export interface OrbitalActions {
  loadInitial(): Promise<void>
  applySessionsEvent(msg: SessionsEvent): void
  applySessionEvent(sessionId: string, msg: SessionEvent): void
  select(id: string): Promise<void>
  sendPrompt(id: string, text: string): Promise<void>
  setFilterTag(filterTagId: number | 'all'): void
  setSearch(search: string): void
  setSourceFilter(sourceFilter: 'all' | SessionSource): void
  setDialog(dialog: OrbitalUiState['dialog']): void
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
}

export const useOrbital = create<OrbitalStore>()((set, get) => ({
  sessions: {},
  order: [],
  tags: [],
  rules: [],
  settings: {},
  transcripts: {},
  subagents: {},
  usage: {},
  historyLoaded: {},
  toast: null,
  ui: initialUiState,

  async loadInitial() {
    const [sessions, tags, rules, settings] = await Promise.all([
      api.listSessions(),
      api.listTags(),
      api.listTagRules(),
      api.getSettings(),
    ])

    const sessionsMap: Record<string, ApiSession> = {}
    for (const session of sessions) {
      sessionsMap[session.id] = session
    }

    set({
      sessions: sessionsMap,
      order: sortIdsByLastAtDesc(sessionsMap),
      tags,
      rules,
      settings,
    })
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
      set({
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, status: msg.status },
        },
      })
      return
    }

    if (msg.event === 'subagent') {
      const existing = state.subagents[sessionId] ?? []
      const idx = existing.findIndex((a) => a.id === msg.subagent.id)
      const updated =
        idx >= 0
          ? existing.map((a, i) => (i === idx ? msg.subagent : a))
          : [...existing, msg.subagent]
      set({ subagents: { ...state.subagents, [sessionId]: updated } })
      return
    }

    if (msg.event === 'turn_result') {
      set({ usage: { ...state.usage, [sessionId]: msg.usage } })
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

  setDialog(dialog) {
    set((state) => ({ ui: { ...state.ui, dialog } }))
  },

  setWsStatus(wsStatus) {
    set((state) => ({ ui: { ...state.ui, wsStatus } }))
  },

  clearToast() {
    set({ toast: null })
  },
}))

// ---------------------------------------------------------------------------
// Pure selector helpers (exported directly for testing; also usable inline
// in components via `useOrbital(visibleSessions)`).
// ---------------------------------------------------------------------------

export function visibleSessions(state: OrbitalState): ApiSession[] {
  let list = Object.values(state.sessions)

  if (state.ui.filterTagId !== 'all') {
    const tagId = state.ui.filterTagId
    list = list.filter((s) => s.tagIds.includes(tagId))
  }

  if (state.ui.sourceFilter !== 'all') {
    list = list.filter((s) => s.source === state.ui.sourceFilter)
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

export function statusCounts(
  state: OrbitalState
): Record<SessionStatus, number> {
  const counts: Record<SessionStatus, number> = {
    working: 0,
    idle: 0,
    needs_input: 0,
    ended: 0,
  }
  // Aggregates over visibleSessions (post tag/search/source filters), since
  // the aggregate is meant to describe what's currently rendered on the map.
  for (const session of visibleSessions(state)) {
    counts[session.status] += 1
  }
  return counts
}
