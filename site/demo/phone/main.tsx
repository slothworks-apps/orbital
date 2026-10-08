import '../demo.css'
import { createRoot } from 'react-dom/client'
import { announceReady } from '../fake/install'

// Placeholder until the phone demo is built (spec § The demos): the entry
// exists so the demo build is complete. The phone screens bring their own
// stylesheet (`web/src/mobile`), which replaces `demo.css` here.
createRoot(document.getElementById('root')!).render(
  <div className="flex h-screen w-screen items-center justify-center bg-space font-mono text-text-muted">
    phone demo · coming
  </div>,
)
announceReady()
