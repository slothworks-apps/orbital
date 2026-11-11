import { DELIBERATE_ITEMS, menuFor } from './sessionMenu'
import type { ApiSession } from './types'

/**
 * Which rows a session's context menu draws (spec
 * 2026-10-24-session-context-menu-design § The session menu). Pure, so the
 * menu only draws it.
 */

export type ContextAction =
  | 'open'
  | 'detach'
  | 'rename'
  | 'regenerate'
  | 'tag'
  | 'pin'
  | 'retry'
  | 'without-worktree'
  | 'copy-prompt'
  | 'error-log'
  | 'copy-path'
  | 'takeover'
  | 'clear'
  | 'end'
  | 'discard'
  | 'remove-worktree'

export interface ContextRow {
  action: ContextAction
  /** Drawn but inert: the session's machine is offline. */
  disabled: boolean
}

export interface ContextMenuOptions {
  /** The session's machine is offline (`machineOffline`). */
  offline: boolean
  /** Open in new window is on offer here — the desktop's main window, as the header's detach. */
  detachable: boolean
  /**
   * The session works in a linked worktree: Remove worktree closes the
   * deliberate group (spec 2026-11-02-work-in-a-worktree-design § Where it is
   * offered, 3). Whether it can be removed now is the caller's to say.
   */
  worktree?: boolean
}

/** What an offline machine's session can still do: nothing of it is asked of that machine. */
const NEEDS_NO_MACHINE: ReadonlySet<ContextAction> = new Set(['open', 'copy-path'])

/**
 * Three groups, the phone's ⋯ sheet's order with the desktop's openings in
 * front: the openings, the reversible actions, the deliberate ones. Which of
 * rename, tag, pin, take over, clear and end a session gets is `menuFor`'s —
 * the phone's rule, not a second one; the desktop adds Regenerate name after
 * Rename and Copy path at the end of its group. Take over is offered under
 * the header's own condition, which asks nothing of the Mac's version.
 * An empty group is left out.
 */
export function contextMenuGroups(
  session: Pick<ApiSession, 'source' | 'status' | 'firstAt' | 'setup'>,
  { offline, detachable, worktree = false }: ContextMenuOptions,
): ContextRow[][] {
  const { items } = menuFor(session, offline, true)
  const openings: ContextAction[] = detachable ? ['open', 'detach'] : ['open']
  const labels: ContextAction[] = []
  // A session still setting up names its branch with its first call, so
  // there is nothing to regenerate from yet.
  const regenerates = !session.setup || session.setup.phase === 'ready'
  for (const item of items) {
    if (item === 'rename') labels.push(...(regenerates ? (['rename', 'regenerate'] as const) : (['rename'] as const)))
    else if (!DELIBERATE_ITEMS.has(item)) labels.push(item)
  }
  labels.push('copy-path')
  const deliberate: ContextAction[] = items.filter((item) => DELIBERATE_ITEMS.has(item))
  if (worktree) deliberate.push('remove-worktree')
  return [openings, labels, deliberate]
    .filter((group) => group.length > 0)
    .map((group) => group.map((action) => ({ action, disabled: offline && !NEEDS_NO_MACHINE.has(action) })))
}
