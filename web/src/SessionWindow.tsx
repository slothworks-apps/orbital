import { useEffect, useState } from 'react'
import { useOrbital } from './store/store'
import type { ErrorsEvent, SessionEvent, SessionsEvent } from './store/store'
import { getSocket } from './lib/socket'
import { api } from './lib/api'
import { DetailPanel } from './panels/DetailPanel'
import { ErrorLog } from './panels/ErrorLog'
import { Toasts } from './ui/Toasts'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { EscapeBoundary } from './ui/escapeLayer'

/** Module level for the same reason as App's: one connection per page load. */
const socket = getSocket()

/**
 * Seats the window's session once the snapshot has landed. `loadInitial`
 * only carries the first page of sessions, so an older one is fetched by id
 * first — the same move as the `?session=` restore in `lib/sessionUrl`. A
 * session the server no longer knows is still selected: the panel's own empty
 * state is what a deleted session shows (spec:
 * 2026-09-23-detached-session-windows-design § The detached window).
 */
async function seatSession(id: string): Promise<void> {
  if (!useOrbital.getState().sessions[id]) {
    try {
      const { session } = await api.getSession(id)
      useOrbital.getState().applySessionsEvent({ event: 'upsert', session })
    } catch {
      // Falls through to the empty state.
    }
  }
  await useOrbital.getState().select(id)
}

/**
 * A detached session window, `/session/<id>`: one session's `DetailPanel`
 * filling a desktop window of its own, so several can sit side by side (spec:
 * 2026-09-23-detached-session-windows-design).
 *
 * Owns the data lifecycle the way `App` does, with its own socket and store,
 * but for one session: no map, no sidebar, and no URL mirror — the path IS the
 * selection, and nothing here changes it. The window never receives the
 * detached list (`main.tsx` does not wire the bridge here), so its own
 * `select` is never redirected to focusing itself.
 */
export function SessionWindow({ id }: { id: string }) {
  const loadInitial = useOrbital((s) => s.loadInitial)
  const applySessionsEvent = useOrbital((s) => s.applySessionsEvent)
  const applySessionEvent = useOrbital((s) => s.applySessionEvent)
  const applyErrorsEvent = useOrbital((s) => s.applyErrorsEvent)
  const setWsStatus = useOrbital((s) => s.setWsStatus)
  const setDialog = useOrbital((s) => s.setDialog)
  const dialog = useOrbital((s) => s.ui.dialog)
  const wsStatus = useOrbital((s) => s.ui.wsStatus)
  const title = useOrbital((s) => s.sessions[id]?.title)

  // Selected only once the snapshot has settled: `loadInitial` replaces the
  // sessions map wholesale, so a row fetched by id before it would be lost.
  const [initialLoadSettled, setInitialLoadSettled] = useState(false)
  useEffect(() => {
    void loadInitial().finally(() => setInitialLoadSettled(true))
  }, [loadInitial])

  useEffect(() => {
    if (!initialLoadSettled) return
    void seatSession(id)
  }, [initialLoadSettled, id])

  // The session row itself (title, status, context) arrives on `sessions`.
  useEffect(() => {
    return socket.subscribe('sessions', (msg: SessionsEvent) => applySessionsEvent(msg))
  }, [applySessionsEvent])

  // The toast's Detail and the transcript's error row both open the error
  // log, so the window carries it and the topic that feeds it.
  useEffect(() => {
    return socket.subscribe('errors', (msg: ErrorsEvent) => applyErrorsEvent(msg))
  }, [applyErrorsEvent])

  // Also what triggers the store's catch-up after a reconnect.
  useEffect(() => {
    return socket.onStatusChange((status) => setWsStatus(status))
  }, [setWsStatus])

  // Fixed for the window's lifetime, unlike App's, which follows the selection.
  useEffect(() => {
    return socket.subscribe(`session:${id}`, (msg: SessionEvent) => applySessionEvent(id, msg))
  }, [id, applySessionEvent])

  // The window's title is the session's, and follows a rename. Until the row
  // arrives it keeps the page's own.
  useEffect(() => {
    if (title) document.title = title
  }, [title])

  return (
    <EscapeBoundary>
      <div className="relative h-screen w-screen overflow-hidden bg-space">
        <ErrorBoundary label="Detail panel">
          <DetailPanel standalone />
        </ErrorBoundary>

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

        <ErrorLog open={dialog === 'errors'} onClose={() => setDialog(null)} />
        <Toasts />
      </div>
    </EscapeBoundary>
  )
}
