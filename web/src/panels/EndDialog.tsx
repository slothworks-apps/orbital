import { useCallback, useEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'
import { reportError } from '../lib/errors'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'

export interface EndDialogProps {
  open: boolean
  sessionId: string | null
  onClose: () => void
}

/**
 * Confirms ending a session (spec 2026-09-23-end-session-design; canvas
 * `Feature - Header actions` 23a, "3 · DIALOG"): the 1g shell minus the
 * lineage row and the checkbox — nothing is being created, so there is
 * nothing to preview, and ending is rare enough that the confirmation is the
 * point, so there is no "don't ask again".
 *
 * Like `StopDialog`, it closes only on a successful end; a failure reports and
 * leaves it open. The panel stays on the session, which the server republishes
 * as ended.
 */
export function EndDialog({ open, sessionId, onClose }: EndDialogProps) {
  // Captured at the moment the dialog opens, not the live `sessionId` prop —
  // see StopDialog: the selection can change elsewhere while this is open.
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

  const session = useOrbital((s) => (targetId ? s.sessions[targetId] : undefined))

  const handleEnd = useCallback(async () => {
    if (!targetId || pending) return
    setPending(true)
    try {
      await useOrbital.getState().endSession(targetId)
      onClose()
    } catch (err) {
      reportError(err, 'Failed to end the session')
    } finally {
      setPending(false)
    }
  }, [targetId, pending, onClose])

  // ⏎ ends, per the footer caption (23a: "esc · ⏎ end"); esc is the Dialog's.
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.shiftKey) return
      e.preventDefault()
      void handleEnd()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, handleEnd])

  return (
    <Dialog
      open={open}
      title="End this session?"
      // Lowercase like its sibling `/clear`, not the canvas's "/END".
      eyebrow="/end"
      onClose={onClose}
      footerCaption="esc · ⏎ end"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" onClick={() => void handleEnd()} disabled={pending}>
            End session
          </Button>
        </>
      }
    >
      {/* Copy from canvas 23a. */}
      <p className="text-[13px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
        {session?.title && <span className="font-mono text-text-bright">{session.title}</span>}
        {session?.title ? ' stops' : 'This session stops'} and moves to history — the transcript
        stays readable there.
      </p>
    </Dialog>
  )
}
