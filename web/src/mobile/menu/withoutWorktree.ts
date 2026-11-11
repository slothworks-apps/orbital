import { leaveWithoutWorktreePrefill } from '../../store/setupActions'
import { useMobile } from '../state'

/**
 * Start without a worktree from the phone (spec
 * 2026-11-09-worktree-setup-in-background-design § The phone; canvas 66d):
 * 9d opens prefilled with the session's launch, Worktree off; the session
 * goes once that launch is accepted.
 */
export function startWithoutWorktreeOnPhone(id: string): void {
  if (leaveWithoutWorktreePrefill(id)) useMobile.getState().go('new')
}
