import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import './theme.css'
import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { dispatchFromMenu, installKeyListener } from './lib/commands'
import { initDesktopBridge, onCommand } from './lib/desktop'
import { setWindowFullScreen } from './lib/windowChrome'
import { useOrbital } from './store/store'
import { ErrorBoundary, resetErrorBoundaries } from './ui/ErrorBoundary'
import { parseStatsRoute } from './stats/route'
import { parseSessionWindowRoute } from './lib/sessionWindowRoute'
import { parseWalkthroughRoute } from './walkthrough/route'

// Lazy on EVERY side of the route branch, because importing `App.tsx` is
// not free: it calls `getSocket()` at module scope (its once-per-page-load
// guarantee — see `lib/socket.ts`), so an eager import here would open the
// app's WebSocket underneath the server-free sandbox and the stats page.
const App = lazy(() => import('./App.tsx'))
const SandboxPage = lazy(() =>
  import('./sandbox/SandboxPage.tsx').then((m) => ({ default: m.SandboxPage }))
)
const ClusterSandboxPage = lazy(() =>
  import('./sandbox/ClusterSandboxPage.tsx').then((m) => ({ default: m.ClusterSandboxPage }))
)
const StatsPage = lazy(() => import('./stats/StatsPage.tsx').then((m) => ({ default: m.StatsPage })))
const SessionWindow = lazy(() =>
  import('./SessionWindow.tsx').then((m) => ({ default: m.SessionWindow }))
)
const WalkthroughPage = lazy(() =>
  import('./walkthrough/WalkthroughPage.tsx').then((m) => ({ default: m.WalkthroughPage }))
)

/**
 * Desktop half of "pinch belongs to the map" (the mobile half is the viewport
 * meta in `index.html`, which desktop browsers ignore).
 *
 * A trackpad pinch reaches the page as a `wheel` event with `ctrlKey` set, and
 * the browser zooms the document unless it is prevented. It has to be a manual
 * listener with `{ passive: false }`: React attaches `wheel` passively, and
 * `preventDefault()` inside a passive listener does nothing at all — which is
 * why the map's own `onWheel` could never have stopped this.
 *
 * Only the pinch is swallowed. Plain wheel scrolling still reaches panels, and
 * ⌘+/− keyboard zoom is untouched — pages cannot reliably intercept it, and
 * leaving it is the one way back if the meta tag ever becomes a problem.
 */
window.addEventListener(
  'wheel',
  (e) => {
    if (e.ctrlKey) e.preventDefault()
  },
  { passive: false }
)

/**
 * Dev only: let a hot update clear whatever the boundaries caught.
 *
 * Orbital is used to drive sessions that edit Orbital, so its own `web/src`
 * is hot-swapped mid-write and a component regularly arrives in a state that
 * parses but throws. The update after it is almost always valid again — this
 * is what lets the tab heal itself then, instead of sitting on the fallback
 * until someone presses ⌘R. See
 * `docs/fixes/hmr-of-a-half-written-file-kills-the-open-ui.md`.
 */
import.meta.hot?.on('vite:afterUpdate', resetErrorBoundaries)

/**
 * `/sandbox` swaps the whole app for the planet animation workbench. A real
 * path, unlike the session URL's query parameter (`lib/sessionUrl.ts`),
 * because the web app is only ever served by vite (the Fastify server hosts
 * no static files), and vite's default `appType: 'spa'` already rewrites
 * unknown paths to `index.html` in both `dev` and `preview`. If the bundle
 * ever moves behind another host, that host needs the same SPA fallback for
 * this route to survive a refresh. Branching here rather than inside `App`
 * keeps the sandbox free of App's side effects — no WebSocket, no store
 * loads.
 */
const sandbox = window.location.pathname === '/sandbox'
/**
 * `/sandbox/cluster` — the real space map over a fixed set of sessions, for
 * looking at how a settled cluster spaces its labels and pills;
 * `/sandbox/cluster/hole` adds a clump resting beside the hole's label.
 * Same kind of branch as `/sandbox`, for the same reasons.
 */
const clusterSandbox =
  window.location.pathname === '/sandbox/cluster' || window.location.pathname === '/sandbox/cluster/hole'

/**
 * `/session/<id>` — a detached session window, one more branch of the same
 * kind (spec: 2026-09-23-detached-session-windows-design).
 */
const sessionWindowId = parseSessionWindowRoute(window.location.pathname)

/**
 * Under Electron, clicking a notification asks the map to open that session,
 * and the main process pushes the list of detached sessions and whether the
 * window is full screen (which drops the window chrome, `lib/windowChrome`).
 * In a browser
 * there is no bridge and this does nothing. The store is a module singleton,
 * so it is ready here — the listeners only ever fire after the page has
 * loaded.
 *
 * Not in a detached window: it must never learn the detached list, or its own
 * `select` would be redirected to focusing itself.
 */
if (sessionWindowId === null) {
  initDesktopBridge({
    select: (id) => useOrbital.getState().select(id),
    setDetached: (ids) => useOrbital.getState().setDetached(ids),
    setFullScreen: setWindowFullScreen,
  })
}

/**
 * `/stats` is the same kind of branch, for the same reasons, and it nests:
 * `parseStatsRoute` tells the dashboard from the per-session drilldown, so
 * the second screen is a prop on one page rather than a second branch here
 * (spec: 2026-09-20-session-stats-design § Web UI).
 */
const stats = parseStatsRoute(window.location.pathname)

/**
 * `/walkthrough/<id>` — the walkthrough page, one more branch of the same kind
 * (spec: 2026-09-23-walkthrough-design § The page).
 */
const walkthroughId = parseWalkthroughRoute(window.location.pathname)

/**
 * One call for every branch below: `App` and `SessionWindow` (the detached
 * session window) both mount from this same file, and installing ahead of
 * the branch — rather than inside each of them — is what keeps a second
 * mount (a hot update, say) from adding a second listener; `installKeyListener`
 * is a no-op past the first call anyway (spec: 2026-09-23-shortcuts-design § 4).
 */
installKeyListener()

/**
 * The desktop menu's other half: a picked item (or its accelerator) arrives
 * here as a command id (spec: 2026-09-23-shortcuts-design § 5). It obeys
 * the key's dialog rule: while a dialog is open only a global command runs
 * (`dispatchFromMenu`). Here rather than in `App` and
 * `SessionWindow` for the same reason as the key listener — an effect runs
 * twice under StrictMode and again on a hot update, and each run would add
 * one more IPC listener, so one click would dispatch twice — and because
 * the main window's other pages (stats, walkthrough) have handlers too, e.g.
 * `PageBar`'s `global.map`. Main sends to the focused window, and Map to
 * the main window.
 */
onCommand((id) => {
  dispatchFromMenu(id)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outermost net: App's own body (the WS wiring, the URL sync) throwing
        should still leave something on screen to reload from. */}
    <ErrorBoundary label="Orbital">
      <Suspense fallback={null}>
        {sandbox ? (
          <SandboxPage />
        ) : clusterSandbox ? (
          <ClusterSandboxPage />
        ) : stats ? (
          <StatsPage route={stats} />
        ) : sessionWindowId !== null ? (
          <SessionWindow id={sessionWindowId} />
        ) : walkthroughId !== null ? (
          <WalkthroughPage id={walkthroughId} />
        ) : (
          <App />
        )}
      </Suspense>
    </ErrorBoundary>
  </StrictMode>,
)
