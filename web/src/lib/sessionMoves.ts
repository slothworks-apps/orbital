/**
 * Which sidebar section a session sits in, and which moves between sections
 * mean something (spec 2026-10-19-docked-sessions-design § Moves). The drag
 * between sections and the right-click menu both ask here, so a drop target
 * lights up exactly when the menu would offer the same move.
 */

import { trashDropFor, type TrashDrop } from '../store/store'
import type { ApiSession } from './types'

export type SectionKey = 'pinned' | 'active' | 'docked' | 'history'

/** The sidebar's order, top to bottom. */
const SECTION_ORDER: readonly SectionKey[] = ['pinned', 'active', 'docked', 'history']

type MoveFields = Pick<ApiSession, 'status' | 'source' | 'pinnedAt' | 'dockedAt'>

/** A pin wins over everything (a pinned ended row is in PINNED), then the dock, then the end. */
export function sectionOf(session: MoveFields): SectionKey {
  if (session.pinnedAt != null) return 'pinned'
  if (session.dockedAt != null) return 'docked'
  return session.status === 'ended' ? 'history' : 'active'
}

/**
 * What dropping `session` on section `to` does, or null where the move means
 * nothing — its own section, or a dock the session cannot take.
 *
 * A move into HISTORY is an End, so it answers what the map's trash answers
 * (`trashDropFor`): at once, after a confirm, or refused. A refused one is
 * null here — the target must not light up for a drop that does nothing.
 * Ending a pinned ended row is just its unpin, which `trashSession` knows.
 */
export type Move = { kind: 'move'; to: 'pinned' | 'active' | 'docked' } | { kind: 'end'; drop: Exclude<TrashDrop, 'refuse'> }

export function moveFor(session: MoveFields, to: SectionKey): Move | null {
  const from = sectionOf(session)
  if (from === to) return null
  if (to === 'history') {
    // A pinned row that has already ended goes to HISTORY by losing its pin.
    if (session.status === 'ended') return { kind: 'end', drop: 'end' }
    const drop = trashDropFor(session.source, session.status)
    return drop === 'refuse' ? null : { kind: 'end', drop }
  }
  // Only Orbital's own sessions dock: a terminal session ends when its CLI
  // exits, and a docked session is never ended. A Mac that does not dock
  // sends no `dockedAt` at all (a member of the group on an older Orbital).
  if (to === 'docked' && (session.source !== 'web' || session.dockedAt === undefined)) return null
  // An ended terminal session is over because its CLI exited; nothing here
  // reopens it, so it can be pinned but not brought back.
  if (session.status === 'ended' && session.source !== 'web' && to !== 'pinned') return null
  return { kind: 'move', to }
}

/** What `sidebar_sections_collapsed` holds when nothing was ever folded or unfolded: DOCKED only. */
const DEFAULT_FOLDED: readonly SectionKey[] = ['docked']

/**
 * The folded sections out of `sidebar_sections_collapsed`, a JSON array of
 * section keys (spec § Sidebar sections). A missing or unreadable row is the
 * default; an unknown key is dropped.
 */
export function parseFoldedSections(settings: Record<string, string>): SectionKey[] {
  const raw = settings.sidebar_sections_collapsed
  if (raw === undefined) return [...DEFAULT_FOLDED]
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_FOLDED]
    return SECTION_ORDER.filter((key) => parsed.includes(key))
  } catch {
    return [...DEFAULT_FOLDED]
  }
}
