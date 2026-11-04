import { useEffect, useState } from 'react'
import type { EndWithWorktreeRequest, WorktreeState } from '@orbital/shared/worktree'
import type { ApiSession } from './types'
import { useSessionWorktree } from './useSessionWorktree'
import {
  REFUSALS,
  endOffersRemoval,
  endRefused,
  endRequest,
  endRowCopy,
  endRowStartsTicked,
  endedWorktreeNote,
  type EndAnswer,
} from './worktree'

export interface EndWorktreeRow {
  /** The worktree End offers to remove, or null: no row at all (no worktree, C3, not removable). */
  offered: WorktreeState | null
  ticked: boolean
  toggle: () => void
  /** The row's line, whether it names a loss, and End's label for this tick. */
  copy: ReturnType<typeof endRowCopy> | null
  /**
   * Holds the row as it stands and returns what End sends besides the
   * session: nothing unticked; the removal and the path the row showed,
   * ticked. Called as End is pressed: the server ends the session before it
   * removes the worktree, and the state read again on that status change —
   * a worktree half gone — must not move the tick under the press.
   */
  hold: () => EndWithWorktreeRequest
  /** Lets go of a held row after an End that failed; `settle` lets go after a refusal. */
  release: () => void
  /** The calm one line after a refusal (the worktree changed under the confirmation), in the confirmation. */
  note: string | null
  /**
   * What End does with the server's answer. A refusal ended nothing: the
   * state is read again, the row starts over and the note says why — false,
   * so the confirmation stays. Otherwise the session ended: true, with the
   * note to say if its worktree stayed (git refused, say).
   */
  settle: (answer: EndAnswer) => { ended: false } | { ended: true; stayed: string | null }
}

/**
 * End's "Also remove worktree" row (canvas 63h; spec
 * 2026-11-02-work-in-a-worktree-design § Where it is offered, 1), for the
 * desktop's `EndDialog` and the phone's End confirmation alike.
 *
 * Read while `active` (the confirmation open). The tick follows the variant
 * until the user moves it (`endRowStartsTicked`), and starts over each time
 * the confirmation opens. Ending with it unticked is the user's *Keep*: the
 * Mac records that itself, so the strip does not come back for this worktree.
 */
export function useEndWorktreeRow(
  session: Pick<ApiSession, 'id' | 'status' | 'git' | 'branch'> | null | undefined,
  active: boolean,
): EndWorktreeRow {
  const { state, refresh } = useSessionWorktree(session, active)
  /** The tick by hand; null follows the variant. */
  const [byHand, setByHand] = useState<boolean | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** The row as End was pressed, while the End is under way. */
  const [held, setHeld] = useState<{ offered: WorktreeState | null; ticked: boolean } | null>(null)
  const id = session?.id ?? null
  useEffect(() => {
    if (!active) return
    setByHand(null)
    setNote(null)
    setHeld(null)
  }, [active, id])

  const live = endOffersRemoval(state) ? state : null
  const liveTicked = live ? (byHand ?? endRowStartsTicked(live)) : false
  const offered = held ? held.offered : live
  const ticked = held ? held.ticked : liveTicked
  return {
    offered,
    ticked,
    toggle: () => {
      setByHand(!ticked)
      setNote(null)
    },
    copy: offered ? endRowCopy(offered, ticked) : null,
    hold: () => {
      setHeld({ offered, ticked })
      return endRequest(offered, ticked)
    },
    release: () => setHeld(null),
    note,
    settle: (answer) => {
      if (endRefused(answer)) {
        setHeld(null)
        refresh()
        setByHand(null)
        setNote(REFUSALS[answer.error])
        return { ended: false }
      }
      return { ended: true, stayed: endedWorktreeNote(answer) }
    },
  }
}
