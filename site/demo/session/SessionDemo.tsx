import { useEffect } from 'react'
import { getSocket } from '../../../web/src/lib/socket'
import { ComposerLockContext } from '../../../web/src/panels/Composer'
import { DetailPanel } from '../../../web/src/panels/DetailPanel'
import { useOrbital, type SessionEvent, type SessionsEvent } from '../../../web/src/store/store'
import { ErrorBoundary } from '../../../web/src/ui/ErrorBoundary'
import { EscapeBoundary } from '../../../web/src/ui/escapeLayer'
import { Toasts } from '../../../web/src/ui/Toasts'
import { COMPOSER_LOCKED } from '../page'

/**
 * The session demo's shell: one session's `DetailPanel` filling the page, as
 * `web/src/SessionWindow.tsx` fills a detached window with it — the panel's
 * `standalone` form, with the same two socket subscriptions. No map, no
 * sidebar, no subagent panel: this demo is the panel.
 */
export function SessionDemo({ id }: { id: string }) {
  useEffect(
    () => getSocket().subscribe('sessions', (msg: SessionsEvent) => useOrbital.getState().queueSessionsEvent(msg)),
    [],
  )
  useEffect(
    () => getSocket().subscribe(`session:${id}`, (msg: SessionEvent) => useOrbital.getState().applySessionEvent(id, msg)),
    [id],
  )

  return (
    <ComposerLockContext.Provider value={COMPOSER_LOCKED}>
      <EscapeBoundary>
        <div className="relative flex h-screen w-screen overflow-hidden bg-space">
          <div className="h-full w-full">
            <ErrorBoundary label="Detail panel">
              <DetailPanel standalone />
            </ErrorBoundary>
          </div>
          <TrafficLights />
          <Toasts />
        </div>
      </EscapeBoundary>
    </ComposerLockContext.Provider>
  )
}

/**
 * The window's three buttons, drawn where the standalone panel leaves room
 * for them (`WINDOW_STRIP_INSET_PX`): in the app macOS draws them, and the
 * empty inset reads as a mistake without them. Decoration only.
 */
function TrafficLights() {
  return (
    <div aria-hidden className="pointer-events-none absolute left-[18px] top-[14px] z-30 flex gap-2">
      <span className="block h-3 w-3 rounded-full bg-[#ff5f57]" />
      <span className="block h-3 w-3 rounded-full bg-[#febc2e]" />
      <span className="block h-3 w-3 rounded-full bg-[#28c840]" />
    </div>
  )
}
