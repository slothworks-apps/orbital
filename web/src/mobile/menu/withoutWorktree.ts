import { withoutWorktreePrefill } from '../../lib/setup'
import { useNewSessionPrefill } from '../../store/setupActions'
import { useOrbital } from '../../store/store'
import { useMobile } from '../state'

/**
 * Start without a worktree from the phone's ⋯ sheet (spec
 * 2026-11-09-worktree-setup-in-background-design § The phone): 9d opens
 * prefilled with the session's launch, Worktree off; the session goes once
 * that launch is accepted.
 */
export function startWithoutWorktreeOnPhone(id: string): void {
  const session = useOrbital.getState().sessions[id]
  if (!session?.setup) return
  useNewSessionPrefill.setState({ prefill: withoutWorktreePrefill(session, session.setup) })
  useMobile.getState().go('new')
}
