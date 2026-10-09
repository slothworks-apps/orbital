import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '../theme.css'
import './mobile.css'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { MobileApp } from './MobileApp'
import { boot } from './boot'
import { hideSplashAfterPaint } from './platform/splash'
import { notifyStarted, startUpdates, switchToPendingBundle, takePendingBundle } from './update/platform'
import { RestartFrame } from './update/RestartFrame'
import { restoreDrafts, takeRestartStash } from './update/restartStash'

/** Lifts the launch screen once the first screen has committed; outside the boundary, so a crash lifts it too. */
function FirstPaint(): null {
  useEffect(hideSplashAfterPaint, [])
  return null
}

/**
 * Inside the boundary: only a bundle whose first screen rendered tells the
 * updater it started. One that crashes, or never gets here, is rolled back by
 * the plugin (spec 2026-10-09-phone-ota-updates-design → The app).
 */
function Started(): null {
  useEffect(notifyStarted, [])
  return null
}

const root = createRoot(document.getElementById('root')!)

// A Restart into a new bundle: its frame stays up until this bundle's first
// screen replaces it, and the drafts go back into their composers.
const restarted = takeRestartStash()
if (restarted) {
  root.render(<RestartFrame version={__MOBILE_VERSION__} />)
  restoreDrafts(restarted)
}

/**
 * `?update-demo` swaps in a stand-in for the updater, to check the UPDATE
 * notice and the restart frame in a browser — only in a dev server or a build
 * made with `VITE_ORBITAL_UPDATE_DEMO=1`; a release build drops the branch and
 * the module with it (`update/demo`).
 */
const updateDemo =
  (import.meta.env.DEV || import.meta.env.VITE_ORBITAL_UPDATE_DEMO === '1') &&
  new URLSearchParams(window.location.search).has('update-demo')

void (async () => {
  // A bundle closed with × last time is switched to now, behind the launch
  // screen; the reload starts this file again in the new bundle. A start
  // without one awaits nothing before boot.
  const pending = takePendingBundle()
  if (pending && (await switchToPendingBundle(pending))) return
  if (updateDemo) void import('./update/demo').then((demo) => demo.installUpdateDemo())
  else void startUpdates(__MOBILE_BEAM__, __MOBILE_VERSION__)

  // The seams must be in place before anything renders: the first screen
  // may open the socket or ask for an image.
  try {
    await boot()
  } catch (err) {
    console.warn('orbital: boot failed', err)
  }
  root.render(
    <StrictMode>
      <ErrorBoundary label="Orbital">
        <MobileApp />
        <Started />
      </ErrorBoundary>
      <FirstPaint />
    </StrictMode>,
  )
})()
