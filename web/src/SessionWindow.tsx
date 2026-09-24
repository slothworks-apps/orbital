import { useEffect, useState } from 'react'
import {
  useOrbital,
  resolveWindowPanelWidths,
  SUBAGENT_PANEL_DEFAULT_PX,
  WINDOW_PANEL_PAIR_MIN_PX,
} from './store/store'
import type { ErrorsEvent, SessionEvent, SessionsEvent } from './store/store'
import { getSocket } from './lib/socket'
import { api } from './lib/api'
import { openInMainWindow, setSubagentPanel } from './lib/desktop'
import { answeredWidthReached, resolveWindowLayout } from './lib/sessionWindowLayout'
import { useCommand } from './lib/commands'
import { useViewportWidth } from './lib/useViewportWidth'
import { STATS_PATH } from './stats/route'
import { DetailPanel } from './panels/DetailPanel'
import { SubagentPanel } from './panels/SubagentPanel'
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
 *
 * An agent opened from the transcript sits in `SubagentPanel` to the detail
 * panel's right, in the same window, with the lifecycle it has on the map.
 */
export function SessionWindow({ id }: { id: string }) {
  const loadInitial = useOrbital((s) => s.loadInitial)
  const queueSessionsEvent = useOrbital((s) => s.queueSessionsEvent)
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
    return socket.subscribe('sessions', (msg: SessionsEvent) => queueSessionsEvent(msg))
  }, [queueSessionsEvent])

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

  // The two app-level commands a detached window can serve (spec:
  // 2026-09-23-shortcuts-design § 7). Stats is a main-window page, so it goes
  // there rather than replacing the one session this window exists to hold.
  useCommand('global.errors', () => setDialog('errors'))
  useCommand('global.stats', () => openInMainWindow(STATS_PATH))

  // The window's title is the session's, and follows a rename. Until the row
  // arrives it keeps the page's own.
  useEffect(() => {
    if (title) document.title = title
  }, [title])

  // `OPEN →` on an agent row opens the subagent panel beside the detail
  // panel, and main grows the window to make room — or not, when it already
  // holds both — and shrinks it back on close (spec:
  // 2026-09-23-detached-session-windows-design § The subagent panel in the
  // window). Sent on mount too, closed: a reload under an open panel lets main
  // give back what it grew.
  //
  // Main answers with the width the window will have (spec:
  // 2026-09-24-subagent-list-design § 4). Until it has, the window goes on
  // showing the session alone, so a window about to grow never shows the
  // swap; the answer is then kept until the window reaches it. `null` is
  // "not answered yet"; `widthPx` undefined is an answer with no width (the
  // browser, or one already reached). A close forgets it, in the same
  // render, and an answer that lands after a close is discarded.
  const subagentPanelOpen = useOrbital((s) => s.subagentPanel !== null)
  const [answer, setAnswer] = useState<{ widthPx: number | undefined } | null>(null)
  if (!subagentPanelOpen && answer !== null) setAnswer(null)
  useEffect(() => {
    if (!subagentPanelOpen) {
      void setSubagentPanel({ open: false })
      return
    }
    let current = true
    const settle = (widthPx: number | undefined) => {
      if (current) setAnswer({ widthPx })
    }
    setSubagentPanel({
      open: true,
      widthPx: SUBAGENT_PANEL_DEFAULT_PX,
      pairMinPx: WINDOW_PANEL_PAIR_MIN_PX,
    }).then(
      (answered) => settle(answered?.widthPx),
      // A main that cannot answer must not keep the panel from ever showing.
      () => settle(undefined)
    )
    return () => {
      current = false
    }
  }, [subagentPanelOpen])

  const windowWidth = useViewportWidth()
  const answeredWidth = answer?.widthPx
  useEffect(() => {
    if (answeredWidth !== undefined && answeredWidthReached(windowWidth, answeredWidth)) {
      setAnswer({ widthPx: undefined })
    }
  }, [windowWidth, answeredWidth])

  const { detailWidthPx, subagentWidthPx } = resolveWindowPanelWidths(windowWidth)
  const layout = resolveWindowLayout({
    windowWidth,
    pending: answer === null,
    answeredWidth,
    thresholdPx: WINDOW_PANEL_PAIR_MIN_PX,
  })
  const showSubagent = subagentPanelOpen && layout !== 'pending'
  const swap = showSubagent && layout === 'swap'

  return (
    <EscapeBoundary>
      <div className="relative flex h-screen w-screen overflow-hidden bg-space">
        {/* Flush, no gutter: the window is the two panels. In swap the
            subagent takes the whole window and the detail panel stays mounted
            underneath, hidden and inert, so its scroll and composer draft
            are there when the session comes back. */}
        <div
          className={swap ? 'invisible absolute inset-0' : 'h-full shrink-0'}
          style={swap ? undefined : { width: showSubagent ? detailWidthPx : '100%' }}
          inert={swap || undefined}
        >
          <ErrorBoundary label="Detail panel">
            <DetailPanel standalone hidden={swap} />
          </ErrorBoundary>
        </div>
        {showSubagent && (
          <div className="h-full shrink-0" style={{ width: swap ? '100%' : subagentWidthPx }}>
            <ErrorBoundary label="Subagent panel">
              <SubagentPanel widthPx={swap ? windowWidth : subagentWidthPx} inWindow swap={swap} />
            </ErrorBoundary>
          </div>
        )}

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
