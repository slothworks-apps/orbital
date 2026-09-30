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
 * How the where-cell — path · mark · branch · #PR · lines — gives up width
 * (canvas `Feature - Branch status` 1c, 1d, 1h FOLD ORDER; spec
 * 2026-09-30-branch-pr-and-line-changes-design § The fold order):
 *
 * 0. everything inline; the path yields from its head down to its leaf;
 * 1. split collapses to the total;
 * 2. the strip folds — `stripFold.ts`, fed `whereFoldReservePx`;
 * 3. the branch is cut in the middle, down to `WHERE_BRANCH_CUT_CH`;
 * 4. the lines leave the row for the branch's tooltip;
 * 5. last resort: the branch down to `WHERE_BRANCH_FLOOR_CH`, the path to "…".
 *
 * The #PR is never dropped. With nothing to show after the branch, the row
 * is `splitWhereRow`'s, exactly as before this feature — fold point included.
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

/** 1h, step 1: the path yields down to its leaf, this many characters. */
export const WHERE_PATH_LEAF_CH = 10
/** 1h, step 3: the branch's floor while the lines are still on the row. */
export const WHERE_BRANCH_CUT_CH = 12

export type WhereStage = 0 | 1 | 2 | 3 | 4 | 5

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

/** What the suffixes take, each with the gap in front of it. The #PR's padding is cancelled by its margin (1h). */
function suffixPx(pr: string, groups: LineGroup[]): number {
  return (
    (pr ? SUFFIX_GAP_PX + pr.length * CHAR_PX : 0) +
    (groups.length > 0 ? SUFFIX_GAP_PX + lineGroupsPx(groups) : 0)
  )
}

/** Step 1: the total alone. A lone group — branch mode, or no parent — is already that. */
function totalOnly(groups: LineGroup[]): LineGroup[] {
  return groups.length > 1 && !groups[0].uncommitted ? [groups[0]] : groups
}

const hasSuffix = (pr: string, lines: LineGroup[]) => pr !== '' || lines.length > 0

export function fitWhereRow(input: WhereRowInput): WhereRowFit {
  const { path, branch, markPx, cellPx, pr, lines, folded } = input
  const roomFor = (groups: LineGroup[]) =>
    Math.max(0, Math.floor((cellPx - markPx - suffixPx(pr, groups)) / CHAR_PX))

  if (!hasSuffix(pr, lines)) {
    return { ...splitWhereRow(path, branch, roomFor([])), pr, lines: [], linesMoved: false, stage: 0 }
  }

  const total = totalOnly(lines)
  const pathFloor = Math.min(path.length, WHERE_PATH_LEAF_CH)
  const branchWhole = Math.min(branch.length, WHERE_BRANCH_CAP_CH)
  const moved = lines.length > 0
  const fit = (room: number, branchChars: number, groups: LineGroup[], stage: WhereStage): WhereRowFit => ({
    path: truncateHead(path, room - branchChars),
    branch: truncateMiddle(branch, branchChars),
    pr,
    lines: groups,
    linesMoved: stage >= 4 && moved,
    stage,
  })

  // Steps 0–2: the branch whole. Split only while the strip is open — the
  // fold comes after it in the order, so a folded strip never brings it back.
  const whole: Array<[LineGroup[], WhereStage]> = folded
    ? [[total, 2]]
    : total === lines
      ? [[lines, 0]]
      : [[lines, 0], [total, 1]]
  for (const [groups, stage] of whole) {
    const room = roomFor(groups)
    if (room - branchWhole >= pathFloor) return fit(room, branchWhole, groups, stage)
  }

  // Steps 3–4: the path at its leaf, the branch cut but not below its floor.
  // An open strip lands here too, in the band where the fold is still held.
  const cutFloor = Math.min(branch.length, WHERE_BRANCH_CUT_CH)
  for (const [groups, stage] of [[total, 3], [[], 4]] as Array<[LineGroup[], WhereStage]>) {
    const room = roomFor(groups)
    const branchChars = Math.min(branchWhole, room - pathFloor)
    if (branchChars >= cutFloor) return fit(room, branchChars, groups, stage)
  }

  // Step 5: first a lower branch floor with the path still at its leaf; then
  // the path to "…" and the branch at that floor, whatever the room.
  const room = roomFor([])
  const lastFloor = Math.min(branch.length, WHERE_BRANCH_FLOOR_CH)
  const besideLeaf = Math.min(branchWhole, room - pathFloor)
  if (besideLeaf >= lastFloor) return fit(room, besideLeaf, [], 5)
  const branchChars = Math.max(lastFloor, Math.min(branchWhole, room - 1))
  return { ...fit(room, branchChars, [], 5), path: '…' }
}

/**
 * What the strip's fold decision (`stripForm`) has to take off the cell's
 * width before judging it, so that step 2 comes where the order puts it:
 * the suffixes as drawn at that step (the #PR and the total), and whatever
 * the path at its leaf and the whole branch need beyond `FOLD_MIN_PATH_PX`.
 * The strip then folds when the cell cannot hold the row at step 1.
 *
 * Nothing after the branch: 0, and the fold point is exactly today's.
 */
export function whereFoldReservePx(input: Omit<WhereRowInput, 'cellPx' | 'folded'>): number {
  const { path, branch, markPx, pr, lines } = input
  if (!hasSuffix(pr, lines)) return 0
  const needPx =
    markPx + (Math.min(path.length, WHERE_PATH_LEAF_CH) + Math.min(branch.length, WHERE_BRANCH_CAP_CH)) * CHAR_PX
  return suffixPx(pr, totalOnly(lines)) + Math.max(0, needPx - FOLD_MIN_PATH_PX)
}
