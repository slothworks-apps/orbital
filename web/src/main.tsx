import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import './theme.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
