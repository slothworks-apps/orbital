import { truncateMiddle } from '../../lib/format'
import { treesCompactText, treesCountText, type WhereForm } from '../../lib/whereForm'

/**
 * How the phone's where line — project · mark branch · count — shares a
 * narrow row (canvas `Feature - Git worktree` 2h, WHAT GIVES WAY, IN ORDER;
 * spec 2026-10-07-live-working-tree-design, The phone). The same order in the
 * session list row and the session screen's header:
 *
 * 0. everything in full;
 * 1. the count drops its word: "+3 worktrees" → tree mark + "+3";
 * 2. the branch middle-cuts, down to `BRANCH_FLOOR_CH`;
 * 3. the project name cuts at its tail, down to `PROJECT_FLOOR_CH`.
 *
 * The count is never dropped. Without one (the `plain` form) the branch
 * middle-cuts to fit and nothing else gives way, as in 2h's last list row.
 * Which form the line is in comes from `lib/whereForm.ts`, the desktop's own
 * decision.
 */

/** 2h: the tag dot before the project, and the gap after it. */
const DOT_PX = 6
const GAP_PX = 6
/** 2h: the tree mark a worktree session draws instead of ⎇, and its gap to the branch. */
export const TREE_MARK_PX = 13
export const MARK_GAP_PX = 5
/** 2h compact count: the tree mark, then this gap, then "+3". */
export const COUNT_MARK_GAP_PX = 3
/** ⎇ and the gap after it, in characters (2h's `pre`). */
const GLYPH_CH = 2

/** 2h, step 2: the branch's floor. */
export const BRANCH_FLOOR_CH = 12
/** 2h, step 3: the project name's floor, its "…" included. */
export const PROJECT_FLOOR_CH = 4

/** JetBrains Mono's advance is 0.6 em: one character of a line set in `fontPx`. */
export function charPxOf(fontPx: number): number {
  return fontPx * 0.6
}

export interface WhereFitInput {
  /** The project's name as the row writes it. */
  project: string
  /** The session's branch (or sha); empty without a git reading. Form B draws none. */
  branch: string
  /** The session itself sits in a worktree: the tree mark stands before the branch, not ⎇ (2h phC). */
  inWorktree: boolean
  form: WhereForm
  /** The line's measured width; null before it has one, which draws everything in full. */
  availPx: number | null
  charPx: number
  /** What the count spends beyond its text: the header's ▾ and its gap; 0 in the list row. */
  caretPx: number
}

export type CountMode = 'full' | 'compact' | 'none'

export interface WhereFit {
  stage: 0 | 1 | 2 | 3
  project: string
  /** Empty when the line draws no branch. */
  branch: string
  count: CountMode
}

/** Cuts the tail off, keeping the head that names the project (2h, step 3). */
function cutTail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`
}

export function fitWhere(input: WhereFitInput): WhereFit {
  const { project, form, availPx: avail, charPx: ch, caretPx } = input
  const branch = form.kind === 'trees' ? '' : input.branch
  const hasCount = form.kind !== 'plain'
  const counted: CountMode = hasCount ? 'full' : 'none'
  if (avail === null) return { stage: 0, project, branch, count: counted }

  // A "·" between parts, with a gap either side of it.
  const sepPx = GAP_PX * 2 + ch
  const markPx = input.inWorktree ? TREE_MARK_PX + MARK_GAP_PX : GLYPH_CH * ch
  const projectPx = (chars: number) => DOT_PX + GAP_PX + chars * ch
  const branchPx = (chars: number) => (branch ? sepPx + markPx + chars * ch : 0)
  const fullPx = hasCount ? sepPx + treesCountText(form).length * ch + caretPx : 0
  const compactPx = hasCount ? sepPx + TREE_MARK_PX + COUNT_MARK_GAP_PX + treesCompactText(form).length * ch + caretPx : 0
  const fits = (p: number, b: number, c: number) => projectPx(p) + branchPx(b) + c <= avail

  if (fits(project.length, branch.length, fullPx)) return { stage: 0, project, branch, count: counted }
  if (!hasCount) {
    const room = Math.floor((avail - projectPx(project.length) - branchPx(0)) / ch)
    return { stage: 2, project, branch: truncateMiddle(branch, Math.max(BRANCH_FLOOR_CH, room)), count: 'none' }
  }
  if (fits(project.length, branch.length, compactPx)) return { stage: 1, project, branch, count: 'compact' }
  if (branch) {
    const room = Math.floor((avail - projectPx(project.length) - branchPx(0) - compactPx) / ch)
    if (room >= BRANCH_FLOOR_CH) return { stage: 2, project, branch: truncateMiddle(branch, room), count: 'compact' }
  }
  const shortBranch = truncateMiddle(branch, BRANCH_FLOOR_CH)
  const room = Math.floor((avail - projectPx(0) - branchPx(shortBranch.length) - compactPx) / ch)
  return { stage: 3, project: cutTail(project, Math.max(PROJECT_FLOOR_CH, room)), branch: shortBranch, count: 'compact' }
}
