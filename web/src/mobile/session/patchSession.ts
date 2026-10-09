import type { ApiSession } from '../../lib/types'
import { useOrbital } from '../../store/store'

/** One session's optimistic write, a no-op once the store no longer holds it. */
export function patchSession(id: string, fields: Partial<ApiSession>): void {
  useOrbital.setState((state) => {
    const current = state.sessions[id]
    if (!current) return state
    return { sessions: { ...state.sessions, [id]: { ...current, ...fields } } }
  })
}
