import { create } from 'zustand'
import { api } from '../lib/api'
import { copyToClipboard } from '../lib/clipboard'
import { reportError } from '../lib/errors'
import { setupPromptText, withoutWorktreePrefill, type NewSessionPrefill } from '../lib/setup'
import { useOrbital } from './store'

/**
 * The ways out of a worktree launch that has not started (spec
 * 2026-11-09-worktree-setup-in-background-design § Ways out of NOT STARTED,
 * § Discard), for every place that offers them: the setup block, the strip's
 * end button, the context menu and the phone's ⋯ sheet.
 */

/** Try again: the same launch settings, from step 1. The session republishes as SETTING UP. */
export function retrySetup(id: string): void {
  api.retrySetup(id).catch((err) => reportError(err, 'Could not try the worktree again'))
}

/** Copy prompt: the first prompt and the queued messages, as one text. */
export async function copySetupPrompt(id: string): Promise<boolean> {
  const setup = useOrbital.getState().sessions[id]?.setup
  if (!setup) return false
  const copied = await copyToClipboard(setupPromptText(setup))
  if (!copied) useOrbital.setState({ toast: { kind: 'error', message: 'Could not copy the prompt' } })
  return copied
}

/**
 * Discards the session: its setup stops and it goes from every client once
 * the server publishes `remove`. The panel lets go of it here already, so a
 * slow `remove` does not leave it open on a session that is gone.
 */
export async function discardSetup(id: string): Promise<void> {
  await api.discardSession(id)
  useOrbital.setState((s) => (s.ui.selectedId === id ? { ui: { ...s.ui, selectedId: null } } : s))
}

/** The New Session prefill Without a worktree left for the dialog's next open. */
export const useNewSessionPrefill = create<{ prefill: NewSessionPrefill | null }>(() => ({ prefill: null }))

/**
 * Leaves this session's launch, Worktree off, for New Session's next open —
 * the desktop's dialog or the phone's screen. False when the session has no
 * setup to carry, and then nothing should open.
 */
export function leaveWithoutWorktreePrefill(id: string): boolean {
  const session = useOrbital.getState().sessions[id]
  if (!session?.setup) return false
  useNewSessionPrefill.setState({ prefill: withoutWorktreePrefill(session, session.setup) })
  return true
}

/** Without a worktree: New Session, prefilled with this session's launch and Worktree off. */
export function startWithoutWorktree(id: string): void {
  if (leaveWithoutWorktreePrefill(id)) useOrbital.getState().setDialog('new')
}

/**
 * The prefilled launch was accepted: the session it replaces goes. A discard
 * that is lost leaves that session NOT STARTED beside the new one, to be
 * discarded by hand — said, and kept in the error log with why.
 */
export function replacedByLaunch(prefill: NewSessionPrefill): void {
  api
    .discardSession(prefill.replaces)
    .catch((err) => reportError(err, `Could not discard “${prefill.title}”, which the new session replaces`))
}
