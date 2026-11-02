import { useCallback, useState } from 'react'
import { api } from '../../lib/api'
import type { ApiSession } from '../../lib/types'
import { useSessionWorktree } from '../../lib/useSessionWorktree'
import { cleanupAfterText, cleanupChoice, variantLine, type WorktreeRemoveRefusal, type WorktreeState } from '../../lib/worktree'
import { useOrbital } from '../../store/store'
import { sessionSupports } from '../version'
import { BottomSheet, PrimaryButton, SecondaryButton } from '../ui'
import { cleanupRowPlace, cleanupSheetButtons } from '../worktree'

/**
 * Removing a session's worktree from the phone (spec
 * 2026-11-02-work-in-a-worktree-design § The phone; canvas 63g CLEANUP): a
 * row on the session screen that never opens by itself, and the sheet it
 * opens with the desktop strip's two choices.
 */

/** What a refusal says (the server's 409s): the state moved since it was read. The desktop's words. */
const REFUSALS: Record<WorktreeRemoveRefusal, string> = {
  worktree_shared: 'Another session is working in this worktree now.',
  worktree_live_terminal: 'A terminal session is still running in this worktree.',
  worktree_dirty: 'The worktree has uncommitted changes now.',
}

/** Said on the composer's line, like every request of this phone. */
function sayError(message: string) {
  useOrbital.setState({ toast: { kind: 'error', message } })
}

export interface WorktreeCleanup {
  state: WorktreeState | null
  /** Where the row goes (`cleanupRowPlace`), or null; the line after a press stays where the row was. */
  place: 'tail' | 'header' | null
  /** The line left after Keep or Remove, in the row's place. */
  after: string | null
  sheet: boolean
  openSheet: () => void
  closeSheet: () => void
  busy: boolean
  keep: () => void
  remove: () => void
  /** Changes whenever what the transcript's tail shows does. */
  tailKey: string
}

/**
 * The session screen's cleanup, read once for the row and its sheet. Asked
 * only from a Mac that serves it and while that Mac is awake.
 */
export function useWorktreeCleanup(session: ApiSession | undefined, offline: boolean): WorktreeCleanup {
  const served = session ? sessionSupports('worktreeLaunch', session.id) : false
  const { state, refresh } = useSessionWorktree(session, served && !offline)
  const [sheet, setSheet] = useState(false)
  const [busy, setBusy] = useState(false)
  /** The line after a press, and where the row stood when it was pressed. */
  const [after, setAfter] = useState<{ text: string; place: 'tail' | 'header' } | null>(null)
  const rowPlace = session ? cleanupRowPlace(session.status, state) : null
  const id = session?.id ?? null

  const finish = useCallback(
    (action: 'removed' | 'kept', from: WorktreeState) => {
      setAfter({ text: cleanupAfterText(action, from), place: rowPlace ?? 'tail' })
      setSheet(false)
      refresh()
    },
    [rowPlace, refresh],
  )

  const remove = useCallback(() => {
    if (!id || !state || busy) return
    const from = state
    setBusy(true)
    api
      .removeSessionWorktree(id, cleanupChoice(from).force)
      .then((answer) => {
        if ('error' in answer) {
          sayError(REFUSALS[answer.error])
          setSheet(false)
          refresh()
        } else finish('removed', from)
      })
      .catch((err: unknown) => sayError(err instanceof Error ? err.message : 'Could not remove the worktree'))
      .finally(() => setBusy(false))
  }, [id, state, busy, finish, refresh])

  const keep = useCallback(() => {
    if (!id || !state || busy) return
    const from = state
    setBusy(true)
    api
      .keepSessionWorktree(id)
      .then(() => finish('kept', from))
      .catch((err: unknown) => sayError(err instanceof Error ? err.message : 'Could not keep the worktree'))
      .finally(() => setBusy(false))
  }, [id, state, busy, finish])

  const place = after ? after.place : rowPlace
  return {
    state,
    place,
    after: after?.text ?? null,
    // The sheet goes with the row: a state that moved under it (another session came in) closes it.
    sheet: sheet && rowPlace !== null,
    openSheet: () => setSheet(true),
    closeSheet: () => setSheet(false),
    busy,
    keep,
    remove,
    tailKey: place === 'tail' ? `wt:${after?.text ?? state?.variant ?? ''}` : '-',
  }
}

/**
 * The row (canvas 63g): a 56px card under the end of an ended session's
 * transcript, or under the header's where line; after a press, the one mono
 * line saying what happened, where the row was.
 */
export function WorktreeCleanupRow({ cleanup, className = '' }: { cleanup: WorktreeCleanup; className?: string }) {
  if (cleanup.after) {
    return <div className={`px-1 py-1.5 font-mono fs-11 text-ink-900/60 ${className}`}>{cleanup.after}</div>
  }
  const state = cleanup.state
  if (!state || !cleanup.place) return null
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={cleanup.openSheet}
      className={`flex min-h-14 w-full items-center gap-3 rounded-[14px] border border-line/16 bg-space/50 px-3.5 py-2 text-left text-ink-100 ${className}`}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="fs-14 font-semibold [overflow-wrap:anywhere]">Remove worktree {state.leaf}?</span>
        <span className="truncate fs-12 text-ink-900/65">{variantLine(state)}</span>
      </span>
      <span aria-hidden className="shrink-0 fs-18 text-ink-900/60">
        ›
      </span>
    </button>
  )
}

/**
 * The sheet the row opens (canvas 63g): WORKTREE <LEAF>, what removing it
 * keeps or loses, and the two choices stacked with the filled one on top —
 * Remove in C1, Keep in C2, where Remove names what is lost.
 */
export function WorktreeCleanupSheet({ cleanup }: { cleanup: WorktreeCleanup }) {
  const state = cleanup.state
  if (!state) return null
  const buttons = cleanupSheetButtons(state)
  const filled = buttons.order[0]
  const press = { keep: cleanup.keep, remove: cleanup.remove }
  const label = { keep: 'Keep', remove: buttons.removeLabel }

  return (
    // 63g: the text sits 16px in (the shell's 10 plus 6), the title 4px further.
    <BottomSheet label={`Worktree ${state.leaf}`} onDismiss={cleanup.closeSheet}>
      <div className="flex flex-col gap-2 px-1.5 pb-2">
        <div className="px-1 font-mono fs-10 tracking-[0.18em] text-ink-900/60 [overflow-wrap:anywhere]">
          WORKTREE {state.leaf.toUpperCase()}
        </div>
        <p className="px-1 pb-2 fs-13.5 leading-[1.5] text-ink-600/88 [text-wrap:pretty]">
          {variantLine(state)}. The local branch stays{state.endsSession ? '; the session is ended first.' : '.'}
        </p>
        {buttons.order.map((which) =>
          which === filled ? (
            <PrimaryButton key={which} variant="sheet" onClick={press[which]} disabled={cleanup.busy}>
              {label[which]}
            </PrimaryButton>
          ) : (
            <SecondaryButton
              key={which}
              variant="sheet"
              tone={which === 'remove' && buttons.removeLoses ? 'loses' : undefined}
              onClick={press[which]}
              disabled={cleanup.busy}
            >
              {label[which]}
            </SecondaryButton>
          ),
        )}
      </div>
    </BottomSheet>
  )
}
