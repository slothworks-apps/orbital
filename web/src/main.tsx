import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import './theme.css'
import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { initDesktopBridge } from './lib/desktop'
import { useOrbital } from './store/store'
import { ErrorBoundary, resetErrorBoundaries } from './ui/ErrorBoundary'

// Lazy on BOTH sides of the sandbox branch, because importing `App.tsx` is
// not free: it calls `getSocket()` at module scope (its once-per-page-load
// guarantee — see `lib/socket.ts`), so an eager import here would open the
// app's WebSocket underneath the server-free sandbox.
const App = lazy(() => import('./App.tsx'))
const SandboxPage = lazy(() =>
  import('./sandbox/SandboxPage.tsx').then((m) => ({ default: m.SandboxPage }))
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
 * Under Electron, clicking a notification asks the map to open that session.
 * In a browser there is no bridge and this does nothing. The store is a module
 * singleton, so it is ready here — the listener only ever fires after a user
 * clicks, long past mount.
 */
initDesktopBridge((id) => useOrbital.getState().select(id))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outermost net: App's own body (the WS wiring, the URL sync) throwing
        should still leave something on screen to reload from. */}
    <ErrorBoundary label="Orbital">
      <Suspense fallback={null}>{sandbox ? <SandboxPage /> : <App />}</Suspense>
    </ErrorBoundary>
  </StrictMode>,
)
