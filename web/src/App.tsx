import { useEffect, useState } from 'react'
import {
  useOrbital,
  parseDetailPanelWidth,
  resolvePanelPairWidths,
  PANEL_GUTTER_PX,
  SUBAGENT_PANEL_DEFAULT_PX,
} from './store/store'
import type { ErrorsEvent, SessionEvent, SessionsEvent } from './store/store'
import { getSocket } from './lib/socket'
import { SpaceMap } from './map/SpaceMap'
import { Sidebar } from './panels/Sidebar'
import { DetailPanel } from './panels/DetailPanel'
import { SubagentPanel } from './panels/SubagentPanel'
import { NewSessionDialog } from './panels/NewSessionDialog'
import { Settings } from './panels/Settings'
import { ErrorLog } from './panels/ErrorLog'
import { Toasts } from './ui/Toasts'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { EscapeBoundary, useEscapeLayer } from './ui/escapeLayer'
import { readNewSessionParam, useSessionUrl, withoutNewSessionParam } from './lib/sessionUrl'

/**
 * The app's single WebSocket connection, taken at module level so it's created
 * once per page load — NOT inside the component, where React 18
 * `StrictMode`'s dev-only mount→cleanup→mount cycle would otherwise have to be
 * guarded against spinning up a second socket. `OrbitalSocket.subscribe` is
 * refcounted and idempotent-safe to call repeatedly (each effect below
 * subscribes on mount and unsubscribes via its returned cleanup), so
 * `StrictMode` double-invoking those effects is harmless on its own —
 * this only needs to be a singleton to avoid a second live connection.
 *
 * The connection itself now lives in `lib/socket`, because the store launches
 * sessions and has to subscribe before its own request goes out.
 */
const socket = getSocket()

/**
 * App shell (final integration task): mounts the full-bleed `SpaceMap`,
 * the docked `Sidebar`/`DetailPanel`/`SubagentPanel`, the three dialogs
 * that don't own their own trigger+render site (`NewSessionDialog`/
 * `Settings` — `StopDialog`/`ClearDialog` are rendered by `DetailPanel`
 * itself, so they're deliberately NOT repeated here), a single `Toasts`
 * surface, and the WS status banner. Owns the data lifecycle
 * (`loadInitial` + the `sessions`/`session:<id>` WS subscriptions) and the
 * one keyboard shortcut not already owned by a panel (`Esc`) — `Sidebar`
 * owns ⌘K, `SpaceMap` owns ⌥N (see its own comment), so neither is
 * duplicated here.
 */
export default function App() {
  const loadInitial = useOrbital((s) => s.loadInitial)
  const applySessionsEvent = useOrbital((s) => s.applySessionsEvent)
  const applySessionEvent = useOrbital((s) => s.applySessionEvent)
  const applyErrorsEvent = useOrbital((s) => s.applyErrorsEvent)
  const setWsStatus = useOrbital((s) => s.setWsStatus)
  const setDialog = useOrbital((s) => s.setDialog)
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const dialog = useOrbital((s) => s.ui.dialog)
  const wsStatus = useOrbital((s) => s.ui.wsStatus)

  // Task 8 (spec § 8 "Layout"): with the subagent panel open, it docks at
  // the right edge and the detail panel is pushed left to make room —
  // "map → session → agent". `DetailPanel`/`SpaceMap` each resolve the
  // PANEL WIDTHS themselves (they need the resolved detail width for its
  // own `<Panel>` and for the map's follow inset respectively); this is the
  // one additional site the brief calls out by name — the WRAPPER's own
  // `right` offset, which used to be the static `right-4` below and now has
  // to make room for the subagent panel sitting to its right. `subagentWidthPx`
  // stays 0 (no offset added) whenever the subagent panel is closed, which
  // is what keeps this a no-op in the regression case (requirement 1).
  const subagentPanelOpen = useOrbital((s) => s.subagentPanel !== null)
  const rawDetailPanelWidth = useOrbital((s) => parseDetailPanelWidth(s.settings, window.innerWidth))
  const subagentWidthPx = subagentPanelOpen
    ? resolvePanelPairWidths(rawDetailPanelWidth, SUBAGENT_PANEL_DEFAULT_PX, window.innerWidth)
        .subagentWidthPx
    : 0
  const detailPanelRightPx = subagentPanelOpen
    ? PANEL_GUTTER_PX + subagentWidthPx + PANEL_GUTTER_PX
    : PANEL_GUTTER_PX

  // Initial REST snapshot (sessions/tags/rules/settings) — once per mount.
  // The flag gates `useSessionUrl`'s restore: `loadInitial` replaces the whole
  // sessions map, so a session fetched by id before it lands would be dropped.
  // Set on failure too — a restore against an empty store still works (it
  // fetches the one session it needs), and a URL that silently stopped
  // restoring after one bad request would be worse.
  const [initialLoadSettled, setInitialLoadSettled] = useState(false)
  useEffect(() => {
    void loadInitial().finally(() => setInitialLoadSettled(true))
  }, [loadInitial])

  useSessionUrl(initialLoadSettled)

  // `/?new=1` — the stats empty state's CTA, which had to cross a page load to
  // reach this dialog (see `lib/sessionUrl`). The parameter is stripped as the
  // dialog opens, so closing it and refreshing does not reopen it. Runs before
  // `useSessionUrl`'s mirror can push a URL, because that mirror waits for the
  // initial load and this does not.
  useEffect(() => {
    if (!readNewSessionParam()) return
    window.history.replaceState(null, '', withoutNewSessionParam())
    setDialog('new')
  }, [setDialog])

  // `sessions` topic feeds the sidebar/map for the app's whole lifetime.
  useEffect(() => {
    return socket.subscribe('sessions', (msg: SessionsEvent) => applySessionsEvent(msg))
  }, [applySessionsEvent])

  // `errors` topic — the shared error log, subscribed for the app's whole
  // lifetime exactly like `sessions`, with the returned unsubscribe as this
  // effect's cleanup.
  useEffect(() => {
    return socket.subscribe('errors', (msg: ErrorsEvent) => applyErrorsEvent(msg))
  }, [applyErrorsEvent])

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

  // App is the OUTERMOST escape layer — always registered, so it only ever
  // sees the key when nothing is open above it (see `ui/escapeLayer`). Any
  // open dialog or panel registers later and therefore outranks it, which is
  // why this no longer needs to check `ui.dialog` itself.
  useEscapeLayer(true, () => {
    useOrbital.setState((s) => (s.ui.selectedId ? { ui: { ...s.ui, selectedId: null } } : s))
  })

  return (
    // Everything the shell renders sits one layer in from App's own, so any
    // panel or dialog outranks it for Escape.
    <EscapeBoundary>
    <div className="relative h-screen w-screen overflow-hidden bg-space">
      <div className="absolute inset-0">
        <ErrorBoundary label="Space map">
          <SpaceMap />
        </ErrorBoundary>
      </div>

      {/* Docked panels inset 16px from the viewport edge, per the export's
          `left:16px;top:16px;bottom:16px` on both 1a's sidebar and 1b's
          detail panel. */}
      {/* One boundary per docked surface, not one around the shell: a panel
          that throws should cost that panel, leaving the other two — and with
          them the session list and the map — readable. See
          `docs/fixes/hmr-of-a-half-written-file-kills-the-open-ui.md`. */}
      <div className="absolute inset-y-4 left-4 z-10">
        <ErrorBoundary label="Sidebar">
          <Sidebar />
        </ErrorBoundary>
      </div>

      {/* `right` eases on the same 420ms curve `Panel.tsx` already animates
          this panel's WIDTH on, and `SpaceMap`'s own right-anchored overlays
          ease on (fix round 1, finding 2) — before this, the width eased in
          while the wrapper's position snapped in one frame. No drag
          exemption is needed the way `SpaceMap`'s `overlayTransition` drops
          its own transition mid-drag: THIS offset never changes while the
          detail panel is being dragged, only when the subagent panel opens
          or closes. */}
      <div
        className="absolute inset-y-4 z-10 transition-[right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]"
        style={{ right: detailPanelRightPx }}
      >
        <ErrorBoundary label="Detail panel">
          <DetailPanel />
        </ErrorBoundary>
      </div>

      {/* Subagent panel: always mounted, like `DetailPanel` above — it
          renders nothing of its own the moment `store.subagentPanel` is
          null (task 7), so there is no open/close gate to duplicate here.
          Docks at the SAME 16px edge inset the detail panel used alone;
          it is the detail panel that moves to make room, not this one. */}
      <div className="absolute inset-y-4 right-4 z-10">
        <ErrorBoundary label="Subagent panel">
          <SubagentPanel widthPx={subagentWidthPx} />
        </ErrorBoundary>
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

      {/* Dialog layer: NewSessionDialog/Settings each already render as
          fixed, full-viewport overlays (z-50) regardless of where they sit
          in the tree, so grouping them here is enough to act as a "portal
          layer" without a literal ReactDOM.createPortal — consistent with
          how Dialog/Settings implement their own overlay today. Tags & rules
          is not here because it is no longer a dialog: it is a section of
          Settings. StopDialog/ClearDialog are intentionally absent too —
          DetailPanel owns and renders them itself. */}
      <NewSessionDialog open={dialog === 'new'} onClose={() => setDialog(null)} />
      <Settings open={dialog === 'settings'} onClose={() => setDialog(null)} />
      <ErrorLog open={dialog === 'errors'} onClose={() => setDialog(null)} />

      {/* The way into the error log lives in SpaceMap's HUD now — an icon
          with the unseen count as its badge, riding the zoom column. */}

      <Toasts />
    </div>
    </EscapeBoundary>
  )
}
