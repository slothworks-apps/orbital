import {
  WHERE_BRANCH_CAP_CH,
  WHERE_BRANCH_FLOOR_CH,
  splitWhereRow,
  truncateHead,
  truncateMiddle,
} from '../lib/format'
import { formatLineCount } from '../lib/branchStatus'
import type { LineGroup } from '../lib/branchStatus'
import { FOLD_MIN_PATH_PX } from './stripFold'

/**
 * How the where-cell — path · mark · branch · #PR · lines · +N worktrees —
 * gives up width (canvas `Feature - Branch status` 1c, 1d, 1h FOLD ORDER;
 * `Feature - Git worktree` 2e FOLD ORDER · 1H + TWO STEPS; spec
 * 2026-09-30-branch-pr-and-line-changes-design § The fold order):
 *
 * 0. everything inline; the path yields from its head down to its leaf;
 *    then the worktree count goes compact — tree mark + "+N";
 * 1. split collapses to the total;
 * 2. the strip folds — `stripFold.ts`, fed `whereFoldReservePx`;
 * 3. the branch is cut in the middle, down to `WHERE_BRANCH_CUT_CH`;
 * 4. the lines leave the row for the branch's tooltip;
 * 5. last resort: the count follows them into that tooltip, the branch goes
 *    down to `WHERE_BRANCH_FLOOR_CH`, the path to "…".
 *
 * The #PR is never dropped. With nothing to show after the branch, the row
 * is `splitWhereRow`'s, exactly as before this feature — fold point included.
 *
 * Form B (2e: the session on the default branch in the main checkout, with
 * subagents elsewhere) has only the path and the count, and folds by
 * `fitTreesRow`.
 */

/** One character of the row's 11px JetBrains Mono. */
export const CHAR_PX = 6.6
/** 1h: the gap between every suffix — the path-to-mark gap, repeated. */
export const SUFFIX_GAP_PX = 9
/** 1h: gap inside a line group — ring, `+n`, `−n`. */
export const LINE_PAIR_GAP_PX = 4
/** 1h: between the total and the uncommitted group. */
export const LINE_GROUP_GAP_PX = 8
/** 1h: the uncommitted ring's diameter. */
export const RING_PX = 5
/** 2e compact form: the tree mark drawn before the compact count. */
export const COUNT_MARK_PX = 13
/** 2e compact form: between that mark and the number. */
export const COUNT_MARK_GAP_PX = 3

/** 1h, step 1: the path yields down to its leaf, this many characters. */
export const WHERE_PATH_LEAF_CH = 10
/** 1h, step 3: the branch's floor while the lines are still on the row. */
export const WHERE_BRANCH_CUT_CH = 12

export type WhereStage = 0 | 1 | 2 | 3 | 4 | 5

/** How the worktree count is drawn: spelled out, compact, moved into the branch's tooltip, or absent. */
export type CountMode = 'full' | 'compact' | 'moved' | 'none'

/** The worktree count's two spellings (`lib/whereForm.ts`): "+3 worktrees" and "+3". */
export interface WhereCount {
  full: string
  compact: string
}

export interface WhereRowInput {
  path: string
  /** The branch (or sha) as the reading has it; empty outside a repository. */
  branch: string
  /** The mark and the gaps either side of it, in px; 0 when there is no mark. */
  markPx: number
  /** The cell's width, in px. */
  cellPx: number
  /** `#123`, or empty when there is no PR to draw. */
  pr: string
  /** The line groups in full, as `lineGroups` gives them. */
  lines: LineGroup[]
  /** Whether the strip is folded right now. */
  folded: boolean
  /** The worktree count, when running subagents work in other trees. */
  count?: WhereCount | null
}

export interface WhereRowFit {
  path: string
  branch: string
  /** The #PR as given — every step keeps it (1h: "the #PR is never dropped"). */
  pr: string
  /** The groups drawn on the row — the total alone from step 1, none from step 4. */
  lines: LineGroup[]
  /** Step 4 on: the lines live in the branch's tooltip, under its full name. */
  linesMoved: boolean
  /** How the worktree count is drawn — `none` without one. */
  count: CountMode
  stage: WhereStage
}

/** A line groups run's drawn width: text, inner gaps, rings, the gap between groups. */
export function lineGroupsPx(groups: LineGroup[]): number {
  return groups.reduce((sum, g, i) => {
    const chars = formatLineCount(g.added).length + formatLineCount(g.removed).length + 2
    return (
      sum +
      chars * CHAR_PX +
      LINE_PAIR_GAP_PX +
      (g.uncommitted ? RING_PX + LINE_PAIR_GAP_PX : 0) +
      (i > 0 ? LINE_GROUP_GAP_PX : 0)
    )
  }, 0)
}

/** The count's drawn width in a mode, without the gap in front of it; 0 off the row. */
export function countPx(count: WhereCount | null | undefined, mode: CountMode): number {
  if (!count) return 0
  if (mode === 'full') return count.full.length * CHAR_PX
  if (mode === 'compact') return COUNT_MARK_PX + COUNT_MARK_GAP_PX + count.compact.length * CHAR_PX
  return 0
}

/** What the suffixes take, each with the gap in front of it. The #PR's padding is cancelled by its margin (1h). */
function suffixPx(pr: string, groups: LineGroup[], count: WhereCount | null, mode: CountMode): number {
  const c = countPx(count, mode)
  return (
    (pr ? SUFFIX_GAP_PX + pr.length * CHAR_PX : 0) +
    (groups.length > 0 ? SUFFIX_GAP_PX + lineGroupsPx(groups) : 0) +
    (c > 0 ? SUFFIX_GAP_PX + c : 0)
  )
}

/** Step 1: the total alone. A lone group — branch mode, or no parent — is already that. */
function totalOnly(groups: LineGroup[]): LineGroup[] {
  return groups.length > 1 && !groups[0].uncommitted ? [groups[0]] : groups
}

const hasSuffix = (pr: string, lines: LineGroup[], count: WhereCount | null) =>
  pr !== '' || lines.length > 0 || count !== null

type Step = [LineGroup[], CountMode, WhereStage]

export function fitWhereRow(input: WhereRowInput): WhereRowFit {
  const { path, branch, markPx, cellPx, pr, lines, folded } = input
  const count = input.count ?? null
  const roomFor = (groups: LineGroup[], mode: CountMode) =>
    Math.max(0, Math.floor((cellPx - markPx - suffixPx(pr, groups, count, mode)) / CHAR_PX))

  if (!hasSuffix(pr, lines, count)) {
    return {
      ...splitWhereRow(path, branch, roomFor([], 'none')),
      pr,
      lines: [],
      linesMoved: false,
      count: 'none',
      stage: 0,
    }
  }

  // The count as it stays on the row once it has given up its word.
  const compact: CountMode = count ? 'compact' : 'none'
  const total = totalOnly(lines)
  const pathFloor = Math.min(path.length, WHERE_PATH_LEAF_CH)
  const branchWhole = Math.min(branch.length, WHERE_BRANCH_CAP_CH)
  const moved = lines.length > 0
  const fit = (room: number, branchChars: number, [groups, mode, stage]: Step): WhereRowFit => ({
    path: truncateHead(path, room - branchChars),
    branch: truncateMiddle(branch, branchChars),
    pr,
    lines: groups,
    linesMoved: stage >= 4 && moved,
    count: mode,
    stage,
  })

  // Steps 0–2: the branch whole. The count's word and the split only while
  // the strip is open — both come before the fold in the order, so a folded
  // strip never brings them back. The word goes before the split (2e, WHY
  // THERE): compacting loses only the word, the total loses data.
  const open: Step[] = [
    ...(count ? [[lines, 'full', 0] as Step] : []),
    [lines, compact, 0],
    ...(total === lines ? [] : [[total, compact, 1] as Step]),
  ]
  for (const step of folded ? [[total, compact, 2] as Step] : open) {
    const room = roomFor(step[0], step[1])
    if (room - branchWhole >= pathFloor) return fit(room, branchWhole, step)
  }

  // Steps 3–4: the path at its leaf, the branch cut but not below its floor.
  // An open strip lands here too, in the band where the fold is still held.
  const cutFloor = Math.min(branch.length, WHERE_BRANCH_CUT_CH)
  for (const step of [
    [total, compact, 3],
    [[], compact, 4],
  ] as Step[]) {
    const room = roomFor(step[0], step[1])
    const branchChars = Math.min(branchWhole, room - pathFloor)
    if (branchChars >= cutFloor) return fit(room, branchChars, step)
  }

  // Step 5: the count follows the lines into the branch's tooltip (2e). First
  // a lower branch floor with the path still at its leaf; then the path to
  // "…" and the branch at that floor, whatever the room.
  const last: Step = [[], count ? 'moved' : 'none', 5]
  const room = roomFor([], last[1])
  const lastFloor = Math.min(branch.length, WHERE_BRANCH_FLOOR_CH)
  const besideLeaf = Math.min(branchWhole, room - pathFloor)
  if (besideLeaf >= lastFloor) return fit(room, besideLeaf, last)
  const branchChars = Math.max(lastFloor, Math.min(branchWhole, room - 1))
  return { ...fit(room, branchChars, last), path: '…' }
}

/**
 * What the strip's fold decision (`stripForm`) has to take off the cell's
 * width before judging it, so that step 2 comes where the order puts it:
 * the suffixes as drawn at that step (the #PR, the total, the compact count),
 * and whatever the path at its leaf and the whole branch need beyond
 * `FOLD_MIN_PATH_PX`. The strip then folds when the cell cannot hold the row
 * at step 1.
 *
 * Nothing after the branch: 0, and the fold point is exactly today's.
 */
export function whereFoldReservePx(input: Omit<WhereRowInput, 'cellPx' | 'folded'>): number {
  const { path, branch, markPx, pr, lines } = input
  const count = input.count ?? null
  if (!hasSuffix(pr, lines, count)) return 0
  const needPx =
    markPx + (Math.min(path.length, WHERE_PATH_LEAF_CH) + Math.min(branch.length, WHERE_BRANCH_CAP_CH)) * CHAR_PX
  return suffixPx(pr, totalOnly(lines), count, 'compact') + Math.max(0, needPx - FOLD_MIN_PATH_PX)
}

/** Form B's steps (2e, 2g): the word, the word compact, the strip folded, the path to "…". */
export type TreesStage = 0 | 1 | 2 | 3

export interface TreesRowFit {
  path: string
  /** Never moved: in form B the count is all the row says besides the path. */
  count: 'full' | 'compact'
  stage: TreesStage
}

/**
 * Form B's row — path · "3 worktrees" — as it narrows (2e FOLD ORDER, 2g):
 * the path to its leaf, then the count compact (tree mark + "3"), then the
 * strip folds, then the path to "…". Two items, so it barely folds.
 */
export function fitTreesRow(input: { path: string; cellPx: number; folded: boolean; count: WhereCount }): TreesRowFit {
  const { path, cellPx, folded, count } = input
  const pathFloor = Math.min(path.length, WHERE_PATH_LEAF_CH)
  const steps: Array<[TreesRowFit['count'], TreesStage]> = folded
    ? [['compact', 2]]
    : [
        ['full', 0],
        ['compact', 1],
      ]
  for (const [mode, stage] of steps) {
    const room = Math.floor((cellPx - SUFFIX_GAP_PX - countPx(count, mode)) / CHAR_PX)
    if (room >= pathFloor) return { path: truncateHead(path, room), count: mode, stage }
  }
  return { path: '…', count: 'compact', stage: 3 }
}

/**
 * Form B's fold reserve: whatever the path at its leaf and the compact count
 * need beyond `FOLD_MIN_PATH_PX` — so the strip folds only once the cell
 * cannot hold the row at step 1, which at the panel's narrowest it can (2g:
 * "the strip never needs to fold for form B").
 */
export function treesFoldReservePx(input: { path: string; count: WhereCount }): number {
  const needPx =
    Math.min(input.path.length, WHERE_PATH_LEAF_CH) * CHAR_PX + SUFFIX_GAP_PX + countPx(input.count, 'compact')
  return Math.max(0, needPx - FOLD_MIN_PATH_PX)
}
