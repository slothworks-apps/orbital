import { api } from '../lib/api'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'

export interface StopDialogProps {
  open: boolean
  sessionId: string | null
  onClose: () => void
}

/**
 * Confirms interrupting a mid-turn session (artboard 1b). Escape/Cancel
 * ("Keep running") never touches the API — `api.interrupt` only fires from
 * the explicit "Stop turn" action, then the dialog closes either way.
 */
export function StopDialog({ open, sessionId, onClose }: StopDialogProps) {
  async function handleStop() {
    if (!sessionId) {
      onClose()
      return
    }
    try {
      await api.interrupt(sessionId)
    } finally {
      onClose()
    }
  }

  return (
    <Dialog
      open={open}
      title="Stop the running turn?"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep running
          </Button>
          <Button variant="danger" onClick={() => void handleStop()}>
            Stop turn
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-soft">
        This session is mid-turn. Stopping now discards the assistant&apos;s partial response —
        any edits it already made on disk stay exactly as they are.
      </p>
    </Dialog>
  )
}
