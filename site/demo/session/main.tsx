import '../demo.css'
import { createRoot } from 'react-dom/client'
import { announceReady } from '../fake/install'

// Placeholder until the session demo is built (spec § The demos): the entry
// exists so the demo build is complete.
createRoot(document.getElementById('root')!).render(
  <div className="flex h-screen w-screen items-center justify-center bg-space font-mono text-text-muted">
    session demo · coming
  </div>,
)
announceReady()
