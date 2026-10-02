import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '../theme.css'
import './mobile.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { MobileApp } from './MobileApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Orbital">
      <MobileApp />
    </ErrorBoundary>
  </StrictMode>,
)
