import { menuFor } from './sessionMenu'
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
  | 'copy-path'
  | 'takeover'
  | 'clear'
  | 'end'

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
  session: Pick<ApiSession, 'source' | 'status' | 'firstAt'>,
  { offline, detachable }: ContextMenuOptions,
): ContextRow[][] {
  const { items } = menuFor(session, offline, true)
  const openings: ContextAction[] = detachable ? ['open', 'detach'] : ['open']
  const labels: ContextAction[] = []
  for (const item of items) {
    if (item === 'rename') labels.push('rename', 'regenerate')
    else if (item === 'tag' || item === 'pin') labels.push(item)
  }
  labels.push('copy-path')
  const deliberate = items.filter((item): item is 'takeover' | 'clear' | 'end' =>
    item === 'takeover' || item === 'clear' || item === 'end',
  )
  return [openings, labels, deliberate]
    .filter((group) => group.length > 0)
    .map((group) => group.map((action) => ({ action, disabled: offline && !NEEDS_NO_MACHINE.has(action) })))
}
