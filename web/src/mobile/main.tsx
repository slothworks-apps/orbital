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

/** Lifts the launch screen once the first screen has committed; outside the boundary, so a crash lifts it too. */
function FirstPaint(): null {
  useEffect(hideSplashAfterPaint, [])
  return null
}

// The seams must be in place before anything renders: the first screen
// may open the socket or ask for an image.
void boot()
  .catch((err: unknown) => console.warn('orbital: boot failed', err))
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <ErrorBoundary label="Orbital">
          <MobileApp />
        </ErrorBoundary>
        <FirstPaint />
      </StrictMode>,
    )
  })
