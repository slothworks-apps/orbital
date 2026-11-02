import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { isDemo } from './demo'
import type { ApiSession } from './types'
import { isWorktreeState, type WorktreeState } from './worktree'

/**
 * The session's linked worktree and what removing it would lose (`GET
 * /api/sessions/:id/worktree`), for End's row, the panel's cleanup strip and
 * ⋯ → Remove worktree (spec 2026-11-02-work-in-a-worktree-design § Removing
 * the worktree).
 *
 * Asked only while `active` and only for a session whose working tree is a
 * linked worktree (`git.worktree`): every other session answers null anyway.
 * Asked again whenever what the answer depends on moves — the status (a
 * session that ends stops needing to be ended first), the branch and its PR
 * (a push, a merge). A failed read is null: the offer is a convenience, and
 * nothing is offered on a guess.
 */
export function useSessionWorktree(
  session: Pick<ApiSession, 'id' | 'status' | 'git' | 'branch'> | null | undefined,
  active: boolean,
): { state: WorktreeState | null; loaded: boolean; refresh: () => void } {
  const [state, setState] = useState<WorktreeState | null>(null)
  const [loaded, setLoaded] = useState(false)
  const ticket = useRef(0)
  const id = session?.id ?? null
  const inWorktree = session?.git?.worktree === true
  const asks = active && id !== null && inWorktree && !isDemo()

  const load = useCallback(() => {
    const mine = ++ticket.current
    if (!asks || id === null) {
      setState(null)
      setLoaded(true)
      return
    }
    api
      .sessionWorktree(id)
      .then((answer) => {
        if (mine !== ticket.current) return
        setState(isWorktreeState(answer) ? answer : null)
        setLoaded(true)
      })
      .catch(() => {
        if (mine !== ticket.current) return
        setState(null)
        setLoaded(true)
      })
  }, [asks, id])

  // What the answer depends on, as one key: a change in any of them asks again.
  const pr = session?.branch?.pr
  const key = [session?.status, session?.git?.ref, pr?.number, pr?.state].join('|')

  useEffect(() => {
    setLoaded(false)
    load()
    // `key` is read for its change only.
  }, [load, key])

  // A different session starts from nothing rather than showing the last one's answer.
  useEffect(() => {
    setState(null)
  }, [id])

  return { state, loaded, refresh: load }
}
