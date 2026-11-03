import { useCallback, useState } from 'react'
import type { WorktreeState } from '@orbital/shared/worktree'
import { useOrbital } from '../store/store'
import { api } from './api'
import { REFUSALS, removeRequest } from './worktree'

/**
 * Keep and Remove for one session's worktree (spec
 * 2026-11-02-work-in-a-worktree-design § Removing the worktree), for the
 * desktop's strip and ⋯ dialog and the phone's cleanup sheet alike.
 *
 * Remove sends exactly what the user was shown (`removeRequest`). A refusal
 * — the worktree changed since it was read — removes and ends nothing: it is
 * said in one calm line and resolves `'refused'`, for the caller to read the
 * state again. A failure is the caller's to say (`onError`): the desktop
 * reports it, the phone says it on its own line.
 */
export function useWorktreeActions(
  sessionId: string | null,
  onError: (err: unknown, fallback: string) => void,
): {
  busy: boolean
  remove: (state: WorktreeState) => Promise<'removed' | 'refused' | null>
  keep: () => Promise<'kept' | null>
} {
  const [busy, setBusy] = useState(false)
  const remove = useCallback(
    async (state: WorktreeState): Promise<'removed' | 'refused' | null> => {
      if (!sessionId) return null
      setBusy(true)
      try {
        const answer = await api.removeSessionWorktree(sessionId, removeRequest(state))
        if ('error' in answer) {
          useOrbital.setState({ toast: { kind: 'info', message: REFUSALS[answer.error] } })
          return 'refused'
        }
        return 'removed'
      } catch (err) {
        onError(err, 'Could not remove the worktree')
        return null
      } finally {
        setBusy(false)
      }
    },
    [sessionId, onError],
  )
  const keep = useCallback(async (): Promise<'kept' | null> => {
    if (!sessionId) return null
    setBusy(true)
    try {
      await api.keepSessionWorktree(sessionId)
      return 'kept'
    } catch (err) {
      onError(err, 'Could not keep the worktree')
      return null
    } finally {
      setBusy(false)
    }
  }, [sessionId, onError])
  return { busy, remove, keep }
}
