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

  if (toast.kind === 'rewind_refused') {
    // Canvas 27c REFUSAL, "the toast shell from 1g": a dark glass pill, the
    // errors-log red as its only colour, Details in the accent. It opens the
    // log, where the newest entry — this one — sits first. It stays until
    // dismissed or the next send, so × is the one addition to the canvas.
    return (
      <div
        role="status"
        aria-live="polite"
        data-kind={toast.kind}
        className="pointer-events-auto fixed bottom-6 left-1/2 z-50 flex max-w-[min(680px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3.5 rounded-[10px] border border-[rgba(150,205,255,.2)] bg-[rgba(10,14,24,.85)] py-2.5 pl-4 pr-3.5 font-sans text-[12.5px] text-text-bright backdrop-blur-[16px]"
      >
        {/* oklch(66% .2 25), the errors log's red. */}
        <span aria-hidden className="block h-[7px] w-[7px] flex-none rounded-full bg-[oklch(66%_.2_25)]" />
        <span className="min-w-0 flex-1">{toast.message}</span>
        {toast.action && (
          <button
            type="button"
            // Details leaves the toast up: it goes on the next send or by hand.
            onClick={() => toast.action?.run()}
            className="shrink-0 font-bold text-accent hover:text-text-soft"
          >
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={clearToast}
          aria-label="Dismiss"
          className="shrink-0 text-[rgba(160,190,225,.6)] hover:text-text-bright"
        >
          ×
        </button>
      </div>
    )
  }

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
      {/* The toast's own action ("Undo" on an absorption) — the action clears
          the toast itself: leaving it up would offer an undo that already
          happened. */}
      {toast.action && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            toast.action?.run()
            clearToast()
          }}
        >
          {toast.action.label}
        </Button>
      )}
      {/* A real <button>, so it is in the tab order and answers Enter/Space
          without this file owning any key handling of its own. Dismissing
          below is deliberately NOT wired to the log: closing a toast closes
          a toast, it does not mark the row read. Only error toasts link to
          the error log — an info toast has no row there to show. */}
      {toast.kind === 'error' && (
        <Button variant="ghost" size="sm" onClick={() => setDialog('errors')}>
          Detail
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={clearToast} aria-label="Dismiss">
        ×
      </Button>
    </div>
  )
}
