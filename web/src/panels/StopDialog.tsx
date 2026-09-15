import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { openToolUse } from './Transcript'
import { salientInput } from './ToolRow'

export interface StopDialogProps {
  open: boolean
  sessionId: string | null
  onClose: () => void
}

/**
 * Confirms interrupting a mid-turn session (artboard 1b). Shows the tool
 * call currently mid-edit (if any) so the user knows what stopping now
 * discards. Escape/"Keep running" never touch the API; `api.interrupt` only
 * fires from the explicit "Stop turn" action, and the dialog only closes on
 * a *successful* interrupt — a failure reports a toast and leaves the
 * dialog open (an interrupt that silently no-ops server-side shouldn't read
 * to the user as "stopped").
 */
export function StopDialog({ open, sessionId, onClose }: StopDialogProps) {
  // Captured at the moment the dialog opens, not the live `sessionId` prop —
  // if the selection changes elsewhere while this dialog is still open, it
  // must keep acting on the session it was opened for.
  const [targetId, setTargetId] = useState<string | null>(null)
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) setTargetId(sessionId)
    wasOpenRef.current = open
  }, [open, sessionId])

  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!open) setPending(false)
  }, [open])

  const messages = useOrbital(useShallow((s) => (targetId ? (s.transcripts[targetId] ?? []) : [])))
  const openTool = openToolUse(messages)

  async function handleStop() {
    if (!targetId || pending) return
    setPending(true)
    try {
      await api.interrupt(targetId)
      onClose()
    } catch (err) {
      reportError(err, 'Failed to stop the session')
    } finally {
      setPending(false)
    }
  }

  const toolLabel = openTool
    ? `${openTool.toolName}${(() => {
        const salient = salientInput(openTool.toolName, openTool.toolInput)
        return salient ? `: ${salient}` : ''
      })()}`
    : null

  return (
    <Dialog
      open={open}
      title="Stop the running turn?"
      eyebrow="TURN IN PROGRESS"
      onClose={onClose}
      footerCaption="esc cancel · ⏎ stop"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Keep running
          </Button>
          <Button variant="warning" onClick={() => void handleStop()} disabled={pending}>
            ■ Stop turn
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-soft">
          This session is mid-turn. Stopping now discards the assistant&apos;s partial response —
          any edits it already made on disk stay exactly as they are.
        </p>
        {toolLabel && (
          <div className="flex items-center gap-2 rounded-md border border-panel-border bg-black/20 px-3 py-2 font-mono text-xs text-text-soft">
            <span aria-hidden>⚙</span>
            <span className="min-w-0 flex-1 truncate">{toolLabel} · running</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}
