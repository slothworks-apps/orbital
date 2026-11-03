import { useCallback, useEffect, useRef, useState } from 'react'
import type { EndWithWorktreeRequest } from '@orbital/shared/worktree'
import { useOrbital } from '../store/store'
import { reportError } from '../lib/errors'
import { command, matches } from '../lib/keymap'
import { useEndWorktreeRow } from '../lib/useEndWorktreeRow'
import type { EndAnswer } from '../lib/worktree'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'

/** What a confirmed End carries besides the session: End's worktree row (canvas 63h). */
export type EndOptions = EndWithWorktreeRequest

export interface EndDialogProps {
  open: boolean
  sessionId: string | null
  onClose: () => void
  /**
   * How the confirmed End is carried out, when not the header's plain
   * `endSession` — the map's trash passes `trashSession`, which also takes
   * the pin (spec 2026-09-24-sessions-end-only-by-hand-design § 3). Must
   * reject on failure, like `endSession`, so the dialog stays open. Must
   * pass `opts` on, which carries the worktree row's answer, and resolve
   * with the server's answer: a refusal ended nothing, and keeps it open.
   */
  onEnd?: (id: string, opts: EndOptions) => Promise<EndAnswer>
}

/**
 * Confirms ending a session (spec 2026-09-23-end-session-design; canvas
 * `Feature - Header actions` 23a, "3 · DIALOG"): the 1g shell minus the
 * summary box and the checkbox — nothing is being created, so there is
 * nothing to preview, and ending is rare enough that the confirmation is the
 * point, so there is no "don't ask again".
 *
 * Like `StopDialog`, it closes only on a successful end; a failure reports and
 * leaves it open. Whether the panel then closes is the caller's `onEnd`
 * (`end_closes_panel`); kept open, it shows the session the server republishes
 * as ended.
 */
export function EndDialog({ open, sessionId, onClose, onEnd }: EndDialogProps) {
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

  // Canvas 63h: a session in a linked worktree gets one more row — every
  // worktree but one another live session is still in (C3).
  const row = useEndWorktreeRow(session, open)
  const { request, settle } = row

  const handleEnd = useCallback(async () => {
    if (!targetId || pending) return
    setPending(true)
    try {
      const end = onEnd ?? ((id: string, opts: EndOptions) => useOrbital.getState().endSession(id, opts))
      const outcome = settle(await end(targetId, request))
      // Refused (the worktree changed under the row): nothing ended, the row
      // shows the state read again with a line saying so.
      if (!outcome.ended) return
      // Ended, but the worktree stayed: said once, never as a failed End.
      if (outcome.stayed) useOrbital.setState({ toast: { kind: 'info', message: outcome.stayed } })
      onClose()
    } catch (err) {
      reportError(err, 'Failed to end the session')
    } finally {
      setPending(false)
    }
  }, [targetId, pending, onClose, onEnd, request, settle])

  // ⏎ ends, per the footer caption (23a: "esc · ⏎ end"); esc is the Dialog's.
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matches(command('dialogs.confirm').chords[0], e)) return
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
            {row.copy?.endLabel ?? 'End session'}
          </Button>
        </>
      }
    >
      {/* Copy from canvas 23a. */}
      <p className="fs-13 leading-[1.55] text-ink-600/85 [text-wrap:pretty]">
        {session?.title && <span className="font-mono text-ink-100">{session.title}</span>}
        {session?.title ? ' stops' : 'This session stops'} and moves to history — the transcript
        stays readable there.
      </p>
      {row.offered && row.copy && (
        // 63h: 14px under the sentence, 11px/13px inside a 10px radius, the
        // well fill under a .12 hairline; the box is the row's checkbox.
        <div className="mt-3.5 rounded-[10px] border border-line/12 bg-space-deep/60 px-[13px] py-[11px]">
          <Checkbox
            size="row"
            checked={row.ticked}
            onChange={row.toggle}
            label={
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="fs-13 font-semibold">
                  Also remove worktree <span className="font-mono fs-12 font-normal">{row.offered.leaf}</span>
                </span>
                <span
                  className={[
                    'fs-12 leading-[1.45] transition-colors duration-150 ease-[ease]',
                    row.copy.loses ? 'text-danger-pale' : 'text-ink-900/70',
                  ].join(' ')}
                >
                  {row.copy.line}
                </span>
              </span>
            }
          />
        </div>
      )}
      {row.note && <p className="mt-2 fs-12 leading-[1.45] text-ink-900/70">{row.note}</p>}
    </Dialog>
  )
}
