import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '../theme.css'
import './mobile.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { MobileApp } from './MobileApp'
import { boot } from './boot'

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
      </StrictMode>,
    )
  })
