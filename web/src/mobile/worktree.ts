import type { WorktreeState } from '@orbital/shared/worktree'
import type { SessionStatus } from '../lib/types'
import { BASE_GROUPS, baseMatches, cleanupChoice, stripShown, type BaseRow } from '../lib/worktree'

/**
 * Work in a worktree on the phone (spec 2026-11-02-work-in-a-worktree-design
 * § The phone; canvas 63g, 63h): the little the phone decides on its own. The
 * rules and the copy are `lib/worktree`'s, shared with the desktop.
 */

/**
 * Where the session screen draws the cleanup row, or null for nowhere: under
 * the end of an ended session's transcript, exactly where the desktop's strip
 * would show (`stripShown`). A live session never gets it, so its transcript
 * does not jump; its worktree goes through End.
 */
export function cleanupRowPlace(status: SessionStatus, state: WorktreeState | null): 'tail' | null {
  return stripShown(status, state) ? 'tail' : null
}

/**
 * The cleanup sheet's two buttons, top to bottom (canvas 63g CLEANUP): the
 * filled one first — Remove in C1, Keep in C2 — and the phone's full-width
 * Remove names what it removes.
 */
export function cleanupSheetButtons(state: Pick<WorktreeState, 'variant' | 'endsSession'>): {
  order: ['remove', 'keep'] | ['keep', 'remove']
  removeLabel: string
  removeLoses: boolean
} {
  const choice = cleanupChoice(state)
  return {
    order: choice.remove === 'filled' ? ['remove', 'keep'] : ['keep', 'remove'],
    removeLabel: choice.removeLabel === 'Remove' ? 'Remove worktree' : choice.removeLabel,
    removeLoses: choice.remove === 'loses',
  }
}

/** One line of the BASE sheet: a group's caption, or a branch. */
export type BaseSheetLine = { kind: 'caption'; label: string } | { kind: 'row'; row: BaseRow }

/**
 * The BASE sheet's lines (canvas 63g BASE SHEET): the desktop picker's rows in
 * its order, each group under its caption, narrowed by the desktop picker's
 * search (`baseMatches`). A group with nothing left loses its caption.
 */
export function baseSheetLines(rows: readonly BaseRow[], query: string): BaseSheetLine[] {
  const lines: BaseSheetLine[] = []
  let group: string | null = null
  for (const row of rows) {
    if (!baseMatches(row, query)) continue
    if (row.group !== group) {
      group = row.group
      lines.push({ kind: 'caption', label: row.group })
    }
    lines.push({ kind: 'row', row })
  }
  return lines
}

/** Whether a row's note sits on its right as a mono key (63g: local, remote) rather than as a second line. */
export function noteIsKey(row: BaseRow): boolean {
  return row.group === BASE_GROUPS.all
}
