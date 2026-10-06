import type { ApiSession } from '../../lib/types'

/**
 * What every slot of the session screen is handed (see the map at the top of
 * `screens/SessionScreen.tsx`). A slot reads anything else it needs from the
 * stores itself, so a feature never has to widen this to land.
 */
export interface SlotProps {
  session: ApiSession
  /** The Mac is asleep (`isMacAsleep`): read-only, from the last sync. */
  offline: boolean
}

/**
 * What a tail piece's key hook is handed. Hooks run on every render, also
 * before the session's row has landed (9d opens a session ahead of its
 * upsert), so the session may be missing; the key is then null.
 */
export interface SlotKeyProps {
  session: ApiSession | undefined
  offline: boolean
}
