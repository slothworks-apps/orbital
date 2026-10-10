import { create } from 'zustand'
import { api, ApiError } from '../lib/api'
import { reportError } from '../lib/errors'
import { useOrbital } from '../store/store'
import { activeAfterClose, tabRunning } from './tabs'
import type { TerminalControl, TerminalInfo } from './types'

/**
 * The user's own shells, per session (spec 2026-10-05-embedded-terminal-design
 * § Web), kept out of the main store the way the MCP and compaction dialogs
 * are: nothing but the terminal's own parts read it. Each window has its own
 * copy, rebuilt from the server whenever a session is opened.
 *
 * A shell outlives everything here except a close: hiding the terminal,
 * switching session and closing the panel only change what is drawn. The one
 * place that ends a shell is `close`, behind × and ⌘W.
 */
export interface TerminalsState {
  /** Each session's tabs, in the order they were opened. */
  tabs: Record<string, TerminalInfo[]>
  /** Each session's active tab. */
  active: Record<string, string>
  /** Whether each session's terminal is shown — it comes back with the session. */
  shown: Record<string, boolean>
  /** Each tab's columns and rows, as its view last fitted them (the strip's readout). */
  sizes: Record<string, { cols: number; rows: number }>
  /**
   * When each exited tab's shell was seen to end, for its closing line. Only
   * an exit this window saw: one that happened before it loaded the tab has
   * no time unless the server says (`TerminalInfo.exitedAt`).
   */
  exitedAt: Record<string, number>
  /** The busy tab whose close question is up, if any (48d). */
  confirmClose: string | null
  /** A terminal's input has focus — its keys are its own (spec § Web). */
  focused: boolean
  /** Asks a tab's view to take focus once it is on screen. `seq` makes each ask land. */
  focusRequest: { id: string; seq: number } | null
  /** A session whose new shell is on its way, so a second press does not start two. */
  opening: Record<string, boolean>
  /** Sessions whose terminals have been listed, so the way in does not flicker from strip to chip. */
  loaded: Record<string, true>

  load(sessionId: string): Promise<void>
  open(sessionId: string): Promise<string | null>
  toggle(sessionId: string): Promise<void>
  setShown(sessionId: string, shown: boolean): void
  pick(sessionId: string, id: string): void
  requestClose(id: string): void
  cancelClose(): void
  close(id: string): Promise<void>
  restart(id: string): Promise<void>
  applyControl(id: string, control: TerminalControl): void
  forget(id: string): void
  setSize(id: string, cols: number, rows: number): void
  setFocused(focused: boolean): void
  requestFocus(id: string): void
}

/** The session a tab belongs to, and the tab itself. */
export function findTab(
  state: Pick<TerminalsState, 'tabs'>,
  id: string,
): { sessionId: string; tab: TerminalInfo } | null {
  for (const [sessionId, tabs] of Object.entries(state.tabs)) {
    const tab = tabs.find((t) => t.id === id)
    if (tab) return { sessionId, tab }
  }
  return null
}

function withTab(
  tabs: Record<string, TerminalInfo[]>,
  sessionId: string,
  id: string,
  patch: Partial<TerminalInfo>,
): Record<string, TerminalInfo[]> {
  const list = tabs[sessionId]
  if (!list) return tabs
  return { ...tabs, [sessionId]: list.map((t) => (t.id === id ? { ...t, ...patch } : t)) }
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const { [key]: _dropped, ...rest } = record
  return rest
}

/** The size to start a new shell at: the session's active view's, so it opens already fitted. */
function sizeFor(state: TerminalsState, sessionId: string): { cols: number; rows: number } | undefined {
  const active = state.active[sessionId]
  return active ? state.sizes[active] : undefined
}

let focusSeq = 0

export const useTerminals = create<TerminalsState>((set, get) => ({
  tabs: {},
  active: {},
  shown: {},
  sizes: {},
  exitedAt: {},
  confirmClose: null,
  focused: false,
  focusRequest: null,
  opening: {},
  loaded: {},

  async load(sessionId) {
    let listed: TerminalInfo[]
    try {
      listed = await api.listTerminals(sessionId)
    } catch (err) {
      // A session the server no longer knows has no terminals to show.
      if (err instanceof ApiError && err.status === 404) listed = []
      else {
        // An older server without terminals, or one that failed: the way in
        // stays, and pressing it says what went wrong.
        set((state) => ({ loaded: { ...state.loaded, [sessionId]: true } }))
        return
      }
    }
    set((state) => {
      const ids = new Set(listed.map((t) => t.id))
      const active = state.active[sessionId]
      return {
        tabs: { ...state.tabs, [sessionId]: listed },
        loaded: state.loaded[sessionId] ? state.loaded : { ...state.loaded, [sessionId]: true },
        active:
          listed.length === 0
            ? without(state.active, sessionId)
            : active && ids.has(active)
              ? state.active
              : { ...state.active, [sessionId]: listed[listed.length - 1].id },
        // Nothing to show without a tab; the chip leaves with the last one.
        shown: listed.length === 0 ? without(state.shown, sessionId) : state.shown,
      }
    })
  },

  async open(sessionId) {
    if (get().opening[sessionId]) return null
    set((state) => ({ opening: { ...state.opening, [sessionId]: true } }))
    try {
      const info = await api.openTerminal(sessionId, sizeFor(get(), sessionId))
      set((state) => ({
        tabs: { ...state.tabs, [sessionId]: [...(state.tabs[sessionId] ?? []), info] },
        active: { ...state.active, [sessionId]: info.id },
        shown: { ...state.shown, [sessionId]: true },
      }))
      get().requestFocus(info.id)
      return info.id
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        useOrbital.setState({
          toast: { kind: 'error', message: "The session's folder is gone, so there is nowhere to start a shell." },
        })
      } else {
        reportError(err, 'Failed to start a shell')
      }
      return null
    } finally {
      set((state) => ({ opening: without(state.opening, sessionId) }))
    }
  },

  async toggle(sessionId) {
    const state = get()
    if ((state.tabs[sessionId] ?? []).length === 0) {
      await state.open(sessionId)
      return
    }
    state.setShown(sessionId, !state.shown[sessionId])
  },

  setShown(sessionId, shown) {
    set((state) => ({
      shown: shown ? { ...state.shown, [sessionId]: true } : without(state.shown, sessionId),
      confirmClose: shown ? state.confirmClose : null,
    }))
  },

  pick(sessionId, id) {
    set((state) => ({
      active: { ...state.active, [sessionId]: id },
      confirmClose: state.confirmClose === id ? state.confirmClose : null,
    }))
  },

  requestClose(id) {
    const found = findTab(get(), id)
    if (!found) return
    // 48d: only a tab with something running in it asks; idle and exited close at once.
    if (tabRunning(found.tab)) {
      set((state) => ({ confirmClose: id, active: { ...state.active, [found.sessionId]: id } }))
      return
    }
    void get().close(id)
  },

  cancelClose() {
    if (get().confirmClose !== null) set({ confirmClose: null })
  },

  async close(id) {
    if (!findTab(get(), id)) return
    set({ confirmClose: null })
    try {
      await api.closeTerminal(id)
    } catch (err) {
      // Already gone on the server: forgetting the tab is the whole job.
      if (!(err instanceof ApiError && err.status === 404)) {
        reportError(err, 'Failed to close the terminal')
        return
      }
    }
    get().forget(id)
  },

  async restart(id) {
    const found = findTab(get(), id)
    if (!found || found.tab.exitCode === null) return
    try {
      const info = await api.restartTerminal(id, get().sizes[id])
      set((state) => ({
        tabs: withTab(state.tabs, found.sessionId, id, info),
        exitedAt: without(state.exitedAt, id),
      }))
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.message.includes('cwd_missing')) {
        useOrbital.setState({
          toast: { kind: 'error', message: "The session's folder is gone, so there is nowhere to start a shell." },
        })
        return
      }
      // 409 running: the restart message on the socket already brought it back.
      if (err instanceof ApiError && err.status === 409) return
      reportError(err, 'Failed to start a new shell')
    }
  },

  applyControl(id, control) {
    const found = findTab(get(), id)
    if (!found) return
    const { sessionId } = found
    switch (control.type) {
      case 'status':
        set((state) => ({ tabs: withTab(state.tabs, sessionId, id, { label: control.label, busy: control.busy }) }))
        return
      case 'exit':
        set((state) => ({
          tabs: withTab(state.tabs, sessionId, id, { exitCode: control.exitCode, busy: false }),
          exitedAt: { ...state.exitedAt, [id]: Date.now() },
          confirmClose: state.confirmClose === id ? null : state.confirmClose,
        }))
        return
      case 'restart':
        set((state) => ({
          tabs: withTab(state.tabs, sessionId, id, { exitCode: null }),
          exitedAt: without(state.exitedAt, id),
        }))
        return
    }
  },

  forget(id) {
    const found = findTab(get(), id)
    if (!found) return
    const { sessionId } = found
    set((state) => {
      const list = state.tabs[sessionId] ?? []
      const rest = list.filter((t) => t.id !== id)
      const nextActive = activeAfterClose(
        list.map((t) => t.id),
        state.active[sessionId] ?? null,
        id,
      )
      return {
        tabs: { ...state.tabs, [sessionId]: rest },
        active: nextActive ? { ...state.active, [sessionId]: nextActive } : without(state.active, sessionId),
        // The last tab gone takes the terminal with it; ›_ goes back to the strip.
        shown: rest.length === 0 ? without(state.shown, sessionId) : state.shown,
        sizes: without(state.sizes, id),
        exitedAt: without(state.exitedAt, id),
        confirmClose: state.confirmClose === id ? null : state.confirmClose,
      }
    })
    const next = get().active[sessionId]
    if (next && get().shown[sessionId] && get().focused) get().requestFocus(next)
  },

  setSize(id, cols, rows) {
    const current = get().sizes[id]
    if (current && current.cols === cols && current.rows === rows) return
    set((state) => ({ sizes: { ...state.sizes, [id]: { cols, rows } } }))
  },

  setFocused(focused) {
    if (get().focused !== focused) set({ focused })
  },

  requestFocus(id) {
    set({ focusRequest: { id, seq: ++focusSeq } })
  },
}))
