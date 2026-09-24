import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { command, matches } from '../lib/keymap'
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
  const session = useOrbital((s) => (targetId ? s.sessions[targetId] : undefined))
  const openTool = openToolUse(messages)

  const handleStop = useCallback(async () => {
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
  }, [targetId, pending, onClose])

  // ⏎ stops, per the footer hint the export prints ("esc cancel · ⏎ stop").
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matches(command('dialogs.confirm').chords[0], e)) return
      e.preventDefault()
      void handleStop()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, handleStop])

  const toolTarget = openTool ? salientInput(openTool.toolName, openTool.toolInput) : null

  return (
    <Dialog
      open={open}
      title="Stop the running turn?"
      eyebrow="TURN IN PROGRESS"
      // 1b frames this confirm in amber down to its corner brackets, and
      // blinks a dot before the kicker while the turn is still live.
      size="sm"
      tone="warning"
      eyebrowPulse
      onClose={onClose}
      footerCaption="esc cancel · ⏎ stop"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={pending}>
            Keep running
          </Button>
          <Button variant="warning" size="lg" onClick={() => void handleStop()} disabled={pending}>
            {/* 8px square glyph rather than a text ■, per the export. */}
            <span aria-hidden className="h-2 w-2 rounded-[1px] bg-current" />
            Stop turn
          </Button>
        </>
      }
    >
      {/* Body copy + geometry verbatim from the export's stop confirm. */}
      <div className="flex flex-col">
        <p className="text-[13px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
          {session?.title && <span className="font-mono text-text-bright">{session.title}</span>}
          {session?.title ? ' is mid-turn' : 'This session is mid-turn'}
          {toolTarget ? (
            <>
              {' — currently editing '}
              <span className="font-mono text-text-bright">{toolTarget}</span>
            </>
          ) : null}
          . The partial response is discarded; edits already written to disk stay.
        </p>
        {openTool && (
          <div className="mt-3.5 flex items-center gap-2.5 rounded-lg border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)] px-3 py-2.5 font-mono text-[11px] text-[rgba(160,190,225,.75)]">
            <span aria-hidden className="text-[rgba(160,190,225,.5)]">
              ⚙
            </span>
            <span className="min-w-0 truncate">
              {openTool.toolName}
              {toolTarget ? ': ' : ''}
              {toolTarget && <span className="text-text-bright">{toolTarget}</span>}
            </span>
            <span className="flex-1" />
            <span className="shrink-0 text-amber-400">running</span>
          </div>
        )}
      </div>
    </Dialog>
  )
}
