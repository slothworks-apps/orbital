import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { useSessionWorktree } from '../lib/useSessionWorktree'
import type { ApiSession } from '../lib/types'
import {
  cleanupAfterText,
  cleanupChoice,
  stripShown,
  variantLine,
  type ChoiceFill,
  type WorktreeRemoveRefusal,
  type WorktreeState,
} from '../lib/worktree'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'

/**
 * Removing a session's linked worktree (spec 2026-11-02-work-in-a-worktree-design
 * § Removing the worktree; canvas 63e/63f): the detail panel's strip and the
 * dialog ⋯ → Remove worktree opens. Both offer the same choice — Keep, then
 * Remove — and run it the same way.
 */

/** What a refusal says (the server's 409s): the state moved since it was read. */
const REFUSALS: Record<WorktreeRemoveRefusal, string> = {
  worktree_shared: 'Another session is working in this worktree now.',
  worktree_live_terminal: 'A terminal session is still running in this worktree.',
  worktree_dirty: 'The worktree has uncommitted changes now.',
}

/** The Button variant for each fill (63e's BTN: pri, sec, des). */
const FILL_VARIANT: Record<ChoiceFill, 'primary-plain' | 'ghost' | 'danger-soft'> = {
  filled: 'primary-plain',
  plain: 'ghost',
  loses: 'danger-soft',
}

/**
 * Keep and Remove for one session's worktree. Resolves to what was done, or
 * null when it failed (reported) or was refused (reported with the reason).
 */
function useCleanupActions(sessionId: string | null) {
  const [busy, setBusy] = useState(false)
  const remove = useCallback(
    async (state: WorktreeState): Promise<'removed' | null> => {
      if (!sessionId) return null
      setBusy(true)
      try {
        const answer = await api.removeSessionWorktree(sessionId, cleanupChoice(state).force)
        if ('error' in answer) {
          useOrbital.setState({ toast: { kind: 'error', message: REFUSALS[answer.error] } })
          return null
        }
        return 'removed'
      } catch (err) {
        reportError(err, 'Could not remove the worktree')
        return null
      } finally {
        setBusy(false)
      }
    },
    [sessionId],
  )
  const keep = useCallback(async (): Promise<'kept' | null> => {
    if (!sessionId) return null
    setBusy(true)
    try {
      await api.keepSessionWorktree(sessionId)
      return 'kept'
    } catch (err) {
      reportError(err, 'Could not keep the worktree')
      return null
    } finally {
      setBusy(false)
    }
  }, [sessionId])
  return { busy, remove, keep }
}

/** Keep · Remove, in that order whatever the variant; only the fill moves (63f). */
function CleanupButtons({
  state,
  busy,
  onKeep,
  onRemove,
  size,
}: {
  state: WorktreeState
  busy: boolean
  onKeep: () => void
  onRemove: () => void
  size: 'login-row' | 'lg'
}) {
  const choice = cleanupChoice(state)
  return (
    <>
      <Button variant={FILL_VARIANT[choice.keep]} size={size} disabled={busy} onClick={onKeep}>
        Keep
      </Button>
      <Button variant={FILL_VARIANT[choice.remove]} size={size} disabled={busy} onClick={onRemove}>
        {choice.removeLabel}
      </Button>
    </>
  )
}

/**
 * The cleanup strip (canvas 63e): one 46px row directly under the where row,
 * so it need not repeat the worktree's name, and never in the transcript. It
 * shows only for a session that is not working whose branch is pushed and
 * has a PR, when nobody else is in the tree and Keep has not been pressed
 * (`stripShown`). A press leaves one line saying what happened, and the
 * strip is gone.
 */
export function WorktreeCleanupStrip({
  session,
  worktree: { state, refresh },
}: {
  session: ApiSession | null | undefined
  /** The panel's `useSessionWorktree` for this session, shared with its ⋯ menu. */
  worktree: Pick<ReturnType<typeof useSessionWorktree>, 'state' | 'refresh'>
}) {
  const { busy, remove, keep } = useCleanupActions(session?.id ?? null)
  const [after, setAfter] = useState<string | null>(null)
  const id = session?.id
  useEffect(() => setAfter(null), [id])

  if (after) {
    // 63e: mono 10.5 in muted ink, where the strip was.
    return <div className="mt-2 font-mono fs-10.5 text-ink-900/60">{after}</div>
  }
  if (!session || !stripShown(session.status, state)) return null

  const done = (action: 'removed' | 'kept' | null) => {
    if (!action) return
    setAfter(cleanupAfterText(action, state))
    refresh()
  }

  return (
    // 63e: 2px under the header's 8px rhythm; 7px 8px 7px 12px inside a 10px
    // radius, the well fill under a .16 hairline; title and line stacked 1px apart.
    <div
      role="group"
      aria-label="Remove worktree?"
      className="mt-2.5 flex h-[46px] items-center gap-3 rounded-[10px] border border-line/16 bg-space/50 py-[7px] pl-3 pr-2"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="fs-12.5 font-semibold text-ink-100">Remove worktree?</span>
        <span className="truncate fs-11.5 text-ink-900/70">{variantLine(state)}</span>
      </div>
      <div className="flex flex-none gap-1.5">
        <CleanupButtons
          state={state}
          busy={busy}
          size="login-row"
          onKeep={() => void keep().then(done)}
          onRemove={() => void remove(state).then(done)}
        />
      </div>
    </div>
  )
}

/**
 * ⋯ → Remove worktree (spec § Where it is offered, 3): the strip's choice in a
 * confirm, for any worktree session and whether or not the strip is showing.
 * The session is captured as the dialog opens, as End's is.
 */
export function RemoveWorktreeDialog({
  open,
  sessionId,
  onClose,
}: {
  open: boolean
  sessionId: string | null
  onClose: () => void
}) {
  const [targetId, setTargetId] = useState<string | null>(null)
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (open && !wasOpenRef.current) setTargetId(sessionId)
    wasOpenRef.current = open
  }, [open, sessionId])

  const session = useOrbital((s) => (targetId ? s.sessions[targetId] : undefined))
  const { state, loaded } = useSessionWorktree(session, open)
  const { busy, remove, keep } = useCleanupActions(targetId)
  const offered = state && state.removable && state.variant !== 'c3' ? state : null

  const finish = (action: 'removed' | 'kept' | null) => {
    if (!action || !offered) return
    useOrbital.setState({ toast: { kind: 'info', message: cleanupAfterText(action, offered) } })
    onClose()
  }

  return (
    <Dialog
      open={open}
      title={offered ? `Remove worktree ${offered.leaf}?` : 'Remove worktree?'}
      eyebrow="WORKTREE"
      onClose={onClose}
      footerCaption="esc · keep it as it is"
      footer={
        offered ? (
          <CleanupButtons
            state={offered}
            busy={busy}
            size="lg"
            onKeep={() => void keep().then(finish)}
            onRemove={() => void remove(offered).then(finish)}
          />
        ) : (
          <Button variant="ghost" size="lg" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <p className="fs-13 leading-[1.55] text-ink-600/85 [text-wrap:pretty]">
        {offered ? (
          <>
            {variantLine(offered)}. The local branch stays
            {offered.endsSession ? '; the session is ended first.' : '.'}
          </>
        ) : loaded ? (
          'Another live session still works in this worktree. It can be removed once that one has ended.'
        ) : (
          'Reading the worktree…'
        )}
      </p>
    </Dialog>
  )
}
