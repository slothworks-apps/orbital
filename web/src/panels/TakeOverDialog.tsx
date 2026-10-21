import { useCallback, useEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { command, matches } from '../lib/keymap'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'

/**
 * Confirms taking over a session whose terminal CLI is mid-turn (spec
 * 2026-10-21-take-over-terminal-session-design § 3): the turn running there
 * stops. An idle terminal is taken over without it. Built like `EndDialog`:
 * it closes only once the take over succeeded.
 */
export function TakeOverDialog({ open, sessionId, onClose }: { open: boolean; sessionId: string | null; onClose: () => void }) {
  // Captured as the dialog opens — see EndDialog.
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

  const handleTakeOver = useCallback(async () => {
    if (!targetId || pending) return
    setPending(true)
    try {
      await api.takeOver(targetId)
      onClose()
    } catch (err) {
      reportError(err, 'Failed to take over the session')
    } finally {
      setPending(false)
    }
  }, [targetId, pending, onClose])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matches(command('dialogs.confirm').chords[0], e)) return
      e.preventDefault()
      void handleTakeOver()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, handleTakeOver])

  return (
    <Dialog
      open={open}
      title="Take over from the terminal?"
      eyebrow="take over"
      onClose={onClose}
      footerCaption="esc · ⏎ take over"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="primary" size="lg" onClick={() => void handleTakeOver()} disabled={pending}>
            Take over
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
        {session?.title && <span className="font-mono text-text-bright">{session.title}</span>}
        {session?.title ? ' is' : 'This session is'} working in a terminal. Taking it over quits the CLI
        there and stops the turn it is running; the conversation goes on here.
      </p>
    </Dialog>
  )
}
