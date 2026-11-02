import { useCallback, useEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { command, matches } from '../lib/keymap'
import { useSessionWorktree } from '../lib/useSessionWorktree'
import {
  endOffersRemoval,
  endRemoveMode,
  endRowCopy,
  endRowStartsTicked,
  type RemoveWorktreeMode,
  type WorktreeState,
} from '../lib/worktree'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'

/** What a confirmed End carries besides the session: End's worktree row (canvas 63h). */
export interface EndOptions {
  removeWorktree?: RemoveWorktreeMode
}

export interface EndDialogProps {
  open: boolean
  sessionId: string | null
  onClose: () => void
  /**
   * How the confirmed End is carried out, when not the header's plain
   * `endSession` — the map's trash passes `trashSession`, which also takes
   * the pin (spec 2026-09-24-sessions-end-only-by-hand-design § 3). Must
   * reject on failure, like `endSession`, so the dialog stays open. Must
   * pass `opts` on: it carries the worktree row's answer.
   */
  onEnd?: (id: string, opts: EndOptions) => Promise<void>
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
  const { state: worktree } = useSessionWorktree(session, open)
  const offered = endOffersRemoval(worktree) ? worktree : null
  /** The row's tick by hand; null follows the variant (ticked only when nothing would be lost). */
  const [ticked, setTicked] = useState<boolean | null>(null)
  useEffect(() => {
    if (open) setTicked(null)
  }, [open, targetId])
  const isTicked = offered ? (ticked ?? endRowStartsTicked(offered)) : false
  const row = offered ? endRowCopy(offered, isTicked) : null

  const handleEnd = useCallback(async () => {
    if (!targetId || pending) return
    setPending(true)
    try {
      const removeWorktree = endRemoveMode(offered, isTicked)
      const end = onEnd ?? ((id: string, opts: EndOptions) => useOrbital.getState().endSession(id, opts))
      await end(targetId, removeWorktree ? { removeWorktree } : {})
      // Ending with the row unticked is a Keep (63h RULES): the panel's strip
      // does not come back for this worktree. Best-effort — a lost Keep only
      // means the strip asks once more.
      if (offered && !removeWorktree) void api.keepSessionWorktree(targetId).catch(() => {})
      onClose()
    } catch (err) {
      reportError(err, 'Failed to end the session')
    } finally {
      setPending(false)
    }
  }, [targetId, pending, onClose, onEnd, offered, isTicked])

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
            {row?.endLabel ?? 'End session'}
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
      {offered && row && (
        <WorktreeRow
          worktree={offered}
          ticked={isTicked}
          line={row.line}
          loses={row.loses}
          onToggle={() => setTicked(!isTicked)}
        />
      )}
    </Dialog>
  )
}

/**
 * End's "Also remove worktree" row (canvas 63h): the whole row is the
 * checkbox. Its line names what the variant keeps or, ticked in C2a, what
 * goes — in the soft error ink, with no fill anywhere.
 */
function WorktreeRow({
  worktree,
  ticked,
  line,
  loses,
  onToggle,
}: {
  worktree: WorktreeState
  ticked: boolean
  line: string
  loses: boolean
  onToggle: () => void
}) {
  return (
    // 63h: 14px under the sentence, 11px/13px inside a 10px radius, the well fill under a .12 hairline.
    <button
      type="button"
      role="checkbox"
      aria-checked={ticked}
      onClick={onToggle}
      className="mt-3.5 flex w-full items-start gap-[11px] rounded-[10px] border border-line/12 bg-space-deep/60 px-[13px] py-[11px] text-left text-ink-100"
    >
      {/* 63h: a 16px box, 1.5px border, 4px radius; `background .15s, border-color .15s`. */}
      <span
        aria-hidden
        className={[
          'mt-px grid h-4 w-4 flex-none place-items-center rounded-[4px] border-[1.5px] fs-11 font-bold leading-none text-space-deep transition-[background-color,border-color] duration-150 ease-[ease]',
          ticked ? 'border-accent bg-accent' : 'border-line/35 bg-transparent',
        ].join(' ')}
      >
        {ticked ? '✓' : ''}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="fs-13 font-semibold">
          Also remove worktree <span className="font-mono fs-12 font-normal">{worktree.leaf}</span>
        </span>
        <span
          className={[
            'fs-12 leading-[1.45] transition-colors duration-150 ease-[ease]',
            loses ? 'text-danger-pale' : 'text-ink-900/70',
          ].join(' ')}
        >
          {line}
        </span>
      </span>
    </button>
  )
}
