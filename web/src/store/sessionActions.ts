import { create } from 'zustand'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { harnessUnfinished } from '../lib/harnessSession'
import { useOrbital } from './store'

/** Where a context menu can be opened from. */
export type SessionMenuSurface = 'map' | 'sidebar'

/**
 * The session actions two places offer — the detail header, for the open
 * session, and the context menu on a planet, a Desk card or a sidebar row,
 * for any session (spec 2026-10-24-session-context-menu-design) — and the
 * bit of UI state they share, kept out of the main store the way
 * compaction's is.
 *
 * - `menu`: the open context menu — whose, where, opened from which
 *   surface (whose planet or row holds its hover look meanwhile), and what
 *   Open does there (the map closes the side slot first, as its click does).
 * - `retitling`: the sessions whose name is being written. Here rather than
 *   in the panel so the header spins for a regenerate the menu started.
 * - `renaming`: a session whose header title should open for editing — the
 *   menu's Rename selects the session and leaves this for the panel to take.
 */
interface SessionActionsState {
  menu: { sessionId: string; x: number; y: number; from: SessionMenuSurface; onOpen: (id: string) => void } | null
  retitling: readonly string[]
  renaming: string | null
}

export const useSessionActions = create<SessionActionsState>(() => ({
  menu: null,
  retitling: [],
  renaming: null,
}))

export function openSessionMenu(
  sessionId: string,
  at: { x: number; y: number; from: SessionMenuSurface },
  onOpen: (id: string) => void,
): void {
  useSessionActions.setState({ menu: { sessionId, ...at, onOpen } })
}

export function closeSessionMenu(): void {
  useSessionActions.setState({ menu: null })
}

/** Open the session and its title for editing (the menu's Rename). */
export function askToRename(id: string, open: (id: string) => void): void {
  // A detached session opens in its own window, whose store this is not:
  // that one is only brought to the front.
  if (!useOrbital.getState().detachedIds.includes(id)) useSessionActions.setState({ renaming: id })
  open(id)
}

/** The panel took the rename request (`renaming`). */
export function renameTaken(): void {
  useSessionActions.setState({ renaming: null })
}

/**
 * Names the session from its own contents, now.
 *
 * Nothing is written here on success: the server publishes the new title on
 * the `sessions` topic, and the header's draft reseeds from it. What this
 * does own is the case where the model answers that the current name still
 * fits — silence there would read as a broken button every time it agrees.
 */
export function regenerateName(id: string): void {
  if (useSessionActions.getState().retitling.includes(id)) return
  useSessionActions.setState((s) => ({ retitling: [...s.retitling, id] }))
  api
    .retitleSession(id)
    .then(({ changed }) => {
      if (changed) return
      useOrbital.setState({
        toast: { kind: 'info', message: 'Name kept — it still fits this session.' },
      })
    })
    .catch((err) => reportError(err, 'Failed to regenerate the name'))
    .finally(() => useSessionActions.setState((s) => ({ retitling: s.retitling.filter((x) => x !== id) })))
}

/**
 * A session wears exactly one tag (canvas 1b), so picking replaces rather
 * than adds: the PUT carries a single id, which the server turns into one
 * manual row and a `manual_removed` row for every rule tag it displaces.
 * Optimistic, and rolled back with an error line when the PUT fails.
 */
export function changeTag(id: string, tagId: number): void {
  const session = useOrbital.getState().sessions[id]
  if (!session) return
  const previousTagIds = session.tagIds
  if (previousTagIds.length === 1 && previousTagIds[0] === tagId) return
  const nextIds = [tagId]
  useOrbital.setState((state) => {
    const current = state.sessions[id]
    if (!current) return state
    return { sessions: { ...state.sessions, [id]: { ...current, tagIds: nextIds } } }
  })
  api.setSessionTags(id, nextIds).catch((err) => {
    useOrbital.setState((state) => {
      const current = state.sessions[id]
      if (!current) return state
      return { sessions: { ...state.sessions, [id]: { ...current, tagIds: previousTagIds } } }
    })
    reportError(err, 'Failed to change the session tag')
  })
}

/**
 * Clear and start over. "Don't ask again" skips straight to what the
 * dialog's only action does: clear and start new, and open the new session.
 * Ending without a successor is End session's job (spec
 * 2026-09-23-end-session-design).
 */
export function askToClear(id: string): void {
  const state = useOrbital.getState()
  if (state.settings.confirm_before_clear === 'false') {
    // The dialog's default, unasked: a harness with steps left goes on in
    // the new session (spec 2026-10-02-harness-redesign-design § 8).
    const carry = harnessUnfinished(state.harnesses[id])
    void (carry ? api.clearSession(id, true, { carryHarness: true }) : api.clearSession(id, true))
      .then((result) => {
        if (result.sessionId) void useOrbital.getState().select(result.sessionId)
      })
      .catch((err) => reportError(err, 'Failed to clear session'))
    return
  }
  state.setDialog('clear', id)
}

/**
 * Take over (spec 2026-10-21-take-over-terminal-session-design): a CLI that
 * is not plainly idle asks first, since what runs there stops.
 */
export function askToTakeOver(id: string): void {
  const state = useOrbital.getState()
  if (state.sessions[id]?.status !== 'idle') state.setDialog('take-over', id)
  else api.takeOver(id).catch((err) => reportError(err, 'Failed to take over the session'))
}
