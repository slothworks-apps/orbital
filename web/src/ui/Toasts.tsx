import { useOrbital } from '../store/store'
import { Button } from './Button'

/**
 * Single toast surface for the store's `toast` slice — `reportError`
 * (rename/tag-toggle/stop/clear failures) and `sendPrompt`'s own 409/catch
 * path both set it; this renders it and lets the user dismiss it via
 * `clearToast`. The store only ever holds one toast at a time
 * (`toast: Toast | null`), so a newer one simply replaces whatever was
 * showing — no queue.
 */
export function Toasts() {
  const toast = useOrbital((s) => s.toast)
  const clearToast = useOrbital((s) => s.clearToast)
  const setDialog = useOrbital((s) => s.setDialog)

  if (!toast) return null

  return (
    <div
      role="status"
      aria-live="polite"
      data-kind={toast.kind}
      className={[
        'pointer-events-auto fixed bottom-6 left-1/2 z-50 flex max-w-md -translate-x-1/2 items-center gap-3 rounded-md border px-3.5 py-2 font-sans text-sm shadow-2xl backdrop-blur-md',
        toast.kind === 'error'
          ? 'border-red-400/40 bg-red-950/70 text-red-200'
          : 'border-panel-border bg-panel text-text-soft',
      ].join(' ')}
    >
      <span className="min-w-0 flex-1">{toast.message}</span>
      {/* A real <button>, so it is in the tab order and answers Enter/Space
          without this file owning any key handling of its own. Dismissing
          below is deliberately NOT wired to the log: closing a toast closes
          a toast, it does not mark the row read. */}
      <Button variant="ghost" size="sm" onClick={() => setDialog('errors')}>
        Detail
      </Button>
      <Button variant="ghost" size="sm" onClick={clearToast} aria-label="Dismiss">
        ×
      </Button>
    </div>
  )
}
