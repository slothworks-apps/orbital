import { useMemo } from 'react'
import { withProgressRows } from '../../lib/progressList'
import type { ApiSession, ChatMessage } from '../../lib/types'
import { useProgressFold, useProgressFrozen } from '../../lib/useProgressList'
import { sessionSupports } from '../version'

/**
 * The transcript with the progress list's rows in it, as the desktop's
 * (canvas 67d, 67g): a call that wrote, changed or replaced the list is its
 * dashed row, a call that only moved states shows nothing, and the frozen
 * mark follows the harness that took over. `shown` is the transcript the
 * phone draws (`useHarnessRows`); the calls are the desktop's fold of the
 * session's whole transcript (`useProgressFold`).
 */
export function useProgressRows(session: Pick<ApiSession, 'id' | 'progress'> | undefined, shown: ChatMessage[]): ChatMessage[] {
  const fold = useProgressFold(session?.id)
  const { frozenAt } = useProgressFrozen(session?.id)
  const supported = session !== undefined && sessionSupports('progressList', session.id)
  return useMemo(() => (supported ? withProgressRows(shown, fold, frozenAt) : shown), [supported, shown, fold, frozenAt])
}
