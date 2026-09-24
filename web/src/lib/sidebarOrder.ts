/**
 * The sidebar's session order, as data: which rows the sidebar draws in
 * PINNED, ACTIVE and HISTORY, and the flat PINNED-then-ACTIVE list the
 * session-cycling shortcuts walk (spec: 2026-09-23-shortcuts-design § 4).
 * `Sidebar` draws from `partitionSessions` and the shortcuts read
 * `sidebarOrder`, which is built from the same two calls — so ⌃⇥ can never
 * land on a row the sidebar is not showing, or skip one it is.
 */

import { visibleSessions } from '../store/store'
import type { OrbitalState } from '../store/store'
import type { ApiSession, SessionSource } from './types'

export interface SidebarSections {
  /** Pinned rows, oldest pin first — PINNED keeps pin order (spec § Sidebar). */
  pinned: ApiSession[]
  /** Unpinned live rows before the origin filter, which is what ACTIVE counts. */
  live: ApiSession[]
  active: ApiSession[]
  history: ApiSession[]
}

/**
 * The sidebar's three sections. A pinned session appears under PINNED only —
 * never in two places — which is why the pinned rows come out of the list
 * before ACTIVE and HISTORY are cut from what is left (spec
 * 2026-09-20-pinned-sessions-design).
 *
 * The origin filter still narrows ACTIVE alone: it says where a LIVE session
 * is driven from, and a pinned row is in PINNED whoever drives it.
 */
export function partitionSessions(
  visible: ApiSession[],
  sourceFilter: 'all' | SessionSource
): SidebarSections {
  const pinned: ApiSession[] = []
  const rest: ApiSession[] = []
  for (const session of visible) (session.pinnedAt != null ? pinned : rest).push(session)
  pinned.sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0))

  const live = rest.filter((s) => s.status !== 'ended')
  return {
    pinned,
    live,
    active: sourceFilter === 'all' ? live : live.filter((s) => s.source === sourceFilter),
    history: rest.filter((s) => s.status === 'ended'),
  }
}

/**
 * PINNED rows then ACTIVE rows, top to bottom, with the tag filter, the
 * search and the origin filter applied exactly as the sidebar applies them.
 * HISTORY is left out: the cycling shortcuts move between sessions you are
 * working with, not through the archive.
 */
export function sidebarOrder(state: Pick<OrbitalState, 'sessions' | 'ui'>): ApiSession[] {
  const { pinned, active } = partitionSessions(visibleSessions(state), state.ui.sourceFilter)
  return [...pinned, ...active]
}

/**
 * The session `step` rows away from `selectedId` in `order`, wrapping at
 * either end. With nothing selected — or a selection that is not in the
 * list, such as a HISTORY row — next starts at the top and previous at the
 * bottom. A list of one or none has nowhere to go, so the answer is `null`.
 */
export function stepSession(
  order: ApiSession[],
  selectedId: string | null,
  step: 1 | -1
): string | null {
  if (order.length < 2) return null
  const at = selectedId == null ? -1 : order.findIndex((s) => s.id === selectedId)
  if (at === -1) return (step === 1 ? order[0] : order[order.length - 1]).id
  return order[(at + step + order.length) % order.length].id
}

/**
 * The first session after `selectedId` in `order` whose status is
 * `needs_input`, wrapping to the top; the selection itself never counts,
 * so a lone waiting session that is already open gives `null`.
 */
export function nextNeedingInput(order: ApiSession[], selectedId: string | null): string | null {
  const at = selectedId == null ? -1 : order.findIndex((s) => s.id === selectedId)
  for (let i = 1; i <= order.length; i++) {
    const session = order[(at + i + order.length) % order.length]
    if (session.id !== selectedId && session.status === 'needs_input') return session.id
  }
  return null
}
