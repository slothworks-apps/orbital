import { useEffect } from 'react'
import { useOrbital } from './store/store'
import type { SessionEvent, SessionsEvent } from './store/store'
import { OrbitalSocket, resolveWsUrl } from './lib/ws'
import { SpaceMap } from './map/SpaceMap'
import { Sidebar } from './panels/Sidebar'
import { DetailPanel } from './panels/DetailPanel'
import { NewSessionDialog } from './panels/NewSessionDialog'
import { TagsRules } from './panels/TagsRules'
import { Settings } from './panels/Settings'
import { Toasts } from './ui/Toasts'

/**
 * The app's single WebSocket connection, module-level so it's created once
 * per page load — NOT inside the component, where React 18 `StrictMode`'s
 * dev-only mount→cleanup→mount cycle would otherwise have to be guarded
 * against spinning up a second socket. `OrbitalSocket.subscribe` is
 * refcounted and idempotent-safe to call repeatedly (each effect below
 * subscribes on mount and unsubscribes via its returned cleanup), so
 * `StrictMode` double-invoking those effects is harmless on its own —
 * this only needs to be a singleton to avoid a second live connection.
 */
const socket = new OrbitalSocket(resolveWsUrl('/ws', window.location))

/**
 * App shell (final integration task): mounts the full-bleed `SpaceMap`,
 * the docked `Sidebar`/`DetailPanel`, the three dialogs that don't own
 * their own trigger+render site (`NewSessionDialog`/`TagsRules`/`Settings`
 * — `StopDialog`/`ClearDialog` are rendered by `DetailPanel` itself, so
 * they're deliberately NOT repeated here), a single `Toasts` surface, and
 * the WS status banner. Owns the data lifecycle (`loadInitial` + the
 * `sessions`/`session:<id>` WS subscriptions) and the one keyboard shortcut
 * not already owned by a panel (`Esc`) — `Sidebar` owns ⌘K, `SpaceMap` owns
 * ⌘N (see its own comment), so neither is duplicated here.
 */
export default function App() {
  const loadInitial = useOrbital((s) => s.loadInitial)
  const applySessionsEvent = useOrbital((s) => s.applySessionsEvent)
  const applySessionEvent = useOrbital((s) => s.applySessionEvent)
  const setWsStatus = useOrbital((s) => s.setWsStatus)
  const setDialog = useOrbital((s) => s.setDialog)
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const dialog = useOrbital((s) => s.ui.dialog)
  const wsStatus = useOrbital((s) => s.ui.wsStatus)

  // Initial REST snapshot (sessions/tags/rules/settings) — once per mount.
  useEffect(() => {
    void loadInitial()
  }, [loadInitial])

  // `sessions` topic feeds the sidebar/map for the app's whole lifetime.
  useEffect(() => {
    return socket.subscribe('sessions', (msg: SessionsEvent) => applySessionsEvent(msg))
  }, [applySessionsEvent])

  // WS connection status -> store, surfaced below as the reconnect banner.
  // `onStatusChange` invokes its callback immediately with the current
  // status, so this also seeds `ui.wsStatus` correctly on first mount.
  // Returned unsubscribe is used as this effect's cleanup — without it,
  // StrictMode's dev-only double mount/cleanup/mount (or any real remount
  // over the page's lifetime) would register a second callback forever.
  useEffect(() => {
    return socket.onStatusChange((status) => setWsStatus(status))
  }, [setWsStatus])

  // `session:<id>` topic follows the current selection: subscribing to the
  // newly-selected session and unsubscribing the previous one is exactly
  // what swapping this effect's dependency + cleanup gives for free, via
  // the refcounted client's own subscribe/unsubscribe pairing.
  useEffect(() => {
    if (!selectedId) return
    return socket.subscribe(`session:${selectedId}`, (msg: SessionEvent) =>
      applySessionEvent(selectedId, msg)
    )
  }, [selectedId, applySessionEvent])

  // Esc: close an open dialog first, else deselect the current session.
  // Registered on the CAPTURE phase so it reads `ui.dialog` before any
  // dialog's own bubble-phase Escape handler (Dialog/TagsRules/Settings
  // each already close themselves on Escape) has a chance to clear it —
  // without that, a single Escape press while a dialog is open could both
  // close the dialog AND deselect the session in the same keystroke, since
  // zustand's `set` is synchronous and a bubble-phase handler on `window`
  // would otherwise see the dialog already gone by the time it runs.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      const state = useOrbital.getState()
      if (state.ui.dialog) {
        state.setDialog(null)
        return
      }
      if (state.ui.selectedId) {
        useOrbital.setState((s) => ({ ui: { ...s.ui, selectedId: null } }))
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-space">
      <div className="absolute inset-0">
        <SpaceMap />
      </div>

      {/* Docked panels inset 16px from the viewport edge, per the export's
          `left:16px;top:16px;bottom:16px` on both 1a's sidebar and 1b's
          detail panel. */}
      <div className="absolute inset-y-4 left-4 z-10">
        <Sidebar />
      </div>

      <div className="absolute inset-y-4 right-4 z-10">
        <DetailPanel />
      </div>

      {wsStatus !== 'open' && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center pt-3">
          <span
            role="status"
            className="pointer-events-auto rounded-full border border-panel-border bg-panel px-3 py-1 font-mono text-[11px] tracking-[0.1em] text-text-bright backdrop-blur-md"
          >
            reconnecting…
          </span>
        </div>
      )}

      {/* Dialog layer: NewSessionDialog/TagsRules/Settings each already
          render as fixed, full-viewport overlays (z-50) regardless of
          where they sit in the tree, so grouping them here is enough to
          act as a "portal layer" without a literal ReactDOM.createPortal —
          consistent with how Dialog/TagsRules/Settings implement their own
          overlay today. StopDialog/ClearDialog are intentionally absent:
          DetailPanel owns and renders them itself. */}
      <NewSessionDialog open={dialog === 'new'} onClose={() => setDialog(null)} />
      <TagsRules open={dialog === 'tags'} onClose={() => setDialog(null)} />
      <Settings open={dialog === 'settings'} onClose={() => setDialog(null)} />

      <Toasts />
    </div>
  )
}
