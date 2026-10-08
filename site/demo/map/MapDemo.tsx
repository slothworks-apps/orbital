import { useEffect } from 'react'
import { getSocket } from '../../../web/src/lib/socket'
import { useViewportWidth } from '../../../web/src/lib/useViewportWidth'
import { SpaceMap } from '../../../web/src/map/SpaceMap'
import { ComposerLockContext } from '../../../web/src/panels/Composer'
import { DetailPanel } from '../../../web/src/panels/DetailPanel'
import { ErrorLog } from '../../../web/src/panels/ErrorLog'
import { NewSessionDialog } from '../../../web/src/panels/NewSessionDialog'
import { Settings } from '../../../web/src/panels/Settings'
import { Sidebar } from '../../../web/src/panels/Sidebar'
import { SubagentPanel } from '../../../web/src/panels/SubagentPanel'
import {
  PANEL_GUTTER_PX,
  SUBAGENT_PANEL_DEFAULT_PX,
  parseDetailPanelWidth,
  resolvePanelPairWidths,
  useOrbital,
  type SessionEvent,
  type SessionsEvent,
} from '../../../web/src/store/store'
import { ErrorBoundary } from '../../../web/src/ui/ErrorBoundary'
import { EscapeBoundary, useEscapeLayer } from '../../../web/src/ui/escapeLayer'
import { Toasts } from '../../../web/src/ui/Toasts'
import { COMPOSER_LOCKED } from '../page'

/**
 * The map demo's shell: the parts of `web/src/App.tsx` the map needs — the
 * Planets map, the collapsed sidebar, the detail and subagent panels docked
 * as the app docks them, the same socket subscriptions, and the three
 * dialogs the map and the sidebar open (New session, Settings, the error
 * log) — without the desktop bridge, the keymap, URL sync or the pages the
 * app links to (`main.tsx` keeps a visitor on this page). The map is
 * `SpaceMap` directly, never `MapView`: Planets is the only theme the
 * website shows.
 */
export function MapDemo() {
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const dialog = useOrbital((s) => s.ui.dialog)

  useEffect(
    () => getSocket().subscribe('sessions', (msg: SessionsEvent) => useOrbital.getState().queueSessionsEvent(msg)),
    [],
  )

  useEffect(() => {
    if (!selectedId) return
    return getSocket().subscribe(`session:${selectedId}`, (msg: SessionEvent) =>
      useOrbital.getState().applySessionEvent(selectedId, msg),
    )
  }, [selectedId])

  // Escape closes the panel, as in the app.
  useEscapeLayer(true, () => {
    useOrbital.setState((s) => (s.ui.selectedId ? { ui: { ...s.ui, selectedId: null } } : s))
  })

  // The detail panel moves left for an open subagent panel — `App`'s layout.
  const subagentPanelOpen = useOrbital((s) => s.subagentPanel !== null)
  const viewportWidth = useViewportWidth()
  const rawDetailPanelWidth = useOrbital((s) => parseDetailPanelWidth(s.settings, viewportWidth))
  const subagentWidthPx = subagentPanelOpen
    ? resolvePanelPairWidths(rawDetailPanelWidth, SUBAGENT_PANEL_DEFAULT_PX, viewportWidth).subagentWidthPx
    : 0
  const detailPanelRightPx = subagentPanelOpen
    ? PANEL_GUTTER_PX + subagentWidthPx + PANEL_GUTTER_PX
    : PANEL_GUTTER_PX

  return (
    <ComposerLockContext.Provider value={COMPOSER_LOCKED}>
      <EscapeBoundary>
        <div className="relative h-screen w-screen overflow-hidden bg-space">
          <div className="absolute inset-0">
            <ErrorBoundary label="Space map">
              <SpaceMap />
            </ErrorBoundary>
          </div>
          <div className="absolute inset-y-4 left-4 z-10">
            <ErrorBoundary label="Sidebar">
              <Sidebar />
            </ErrorBoundary>
          </div>
          <div
            className="absolute inset-y-4 z-10 transition-[right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]"
            style={{ right: detailPanelRightPx }}
          >
            <ErrorBoundary label="Detail panel">
              <DetailPanel />
            </ErrorBoundary>
          </div>
          <div className="absolute inset-y-4 right-4 z-10">
            <ErrorBoundary label="Subagent panel">
              <SubagentPanel widthPx={subagentWidthPx} />
            </ErrorBoundary>
          </div>
          {/* As `App` renders them. The first prompt is the composer, so the
              lock above reaches it too. */}
          <NewSessionDialog open={dialog === 'new'} onClose={closeDialog} />
          <Settings open={dialog === 'settings'} onClose={closeDialog} />
          <ErrorLog open={dialog === 'errors'} onClose={closeDialog} />
          <Toasts />
        </div>
      </EscapeBoundary>
    </ComposerLockContext.Provider>
  )
}

function closeDialog() {
  useOrbital.getState().setDialog(null)
}
