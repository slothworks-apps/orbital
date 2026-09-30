import { describe, it, expect } from 'vitest'
import { splitWhereRow, WHERE_BRANCH_FLOOR_CH } from '../lib/format'
import type { LineGroup } from '../lib/branchStatus'
import { FOLD_MIN_PATH_PX, FOLD_HYSTERESIS_PX, foldSavingPx } from '../panels/stripFold'
import {
  CHAR_PX,
  SUFFIX_GAP_PX,
  WHERE_BRANCH_CUT_CH,
  WHERE_PATH_LEAF_CH,
  fitWhereRow,
  lineGroupsPx,
  whereFoldReservePx,
} from '../panels/whereFit'
import type { WhereRowFit, WhereRowInput } from '../panels/whereFit'

// Canvas `Feature - Branch status` 1c/1d's two sessions: a feature branch, and
// the worst case — a long worktree branch with a four-digit PR.
const FEATURE = { path: '~/…/slothworks/orbital', branch: 'feat/pr-chip', markPx: 24, pr: '#123' }
const WORST = {
  path: '~/…/.worktrees/header-pull-request-and-line-changes',
  branch: 'feature/header-pull-request-and-line-changes',
  markPx: 27,
  pr: '#1287',
}
const SPLIT: LineGroup[] = [
  { added: 120, removed: 34, uncommitted: false },
  { added: 8, removed: 2, uncommitted: true },
]
const WORST_SPLIT: LineGroup[] = [
  { added: 1482, removed: 391, uncommitted: false },
  { added: 37, removed: 12, uncommitted: true },
]

type Row = Omit<WhereRowInput, 'cellPx' | 'folded'>

/** An Orbital session's strip in the desktop app: everything but the stats button. */
const SAVING_PX = foldSavingPx({ stats: false, pin: true, clear: true, end: true, detach: true, collapse: true })

/**
 * The row as the panel narrows, one px at a time. `expandedPx` is the cell's
 * width with the strip open; the strip folds exactly when the shipped fold
 * would, entered from the open side (`stripForm` on that width less the
 * reserve), and a folded strip hands its saving to the cell.
 */
function sweep(row: Row, from = 700, to = 100): Array<{ cellPx: number; folded: boolean; fit: WhereRowFit }> {
  const reserve = whereFoldReservePx(row)
  const out = []
  for (let expandedPx = from; expandedPx >= to; expandedPx--) {
    const folded = expandedPx - reserve < FOLD_MIN_PATH_PX
    const cellPx = expandedPx + (folded ? SAVING_PX : 0)
    out.push({ cellPx, folded, fit: fitWhereRow({ ...row, cellPx, folded }) })
  }
  return out
}

describe('fitWhereRow — the fold order', () => {
  it('gives things up in the order 1h lists, never taking one back', () => {
    for (const row of [
      { ...FEATURE, lines: SPLIT },
      { ...WORST, lines: WORST_SPLIT },
    ]) {
      const stages = sweep(row).map((s) => s.fit.stage)
      for (let i = 1; i < stages.length; i++) expect(stages[i]).toBeGreaterThanOrEqual(stages[i - 1])
    }
    // The worst case walks every step on the way down.
    expect(new Set(sweep({ ...WORST, lines: WORST_SPLIT }).map((s) => s.fit.stage))).toEqual(
      new Set([0, 1, 2, 3, 4, 5]),
    )
  })

  it('lets the path yield to its leaf before anything else goes', () => {
    const steps = sweep({ ...FEATURE, lines: SPLIT })
    const inline = steps.filter((s) => s.fit.stage === 0)
    expect(inline[0].fit.path).toBe(FEATURE.path)
    const last = inline[inline.length - 1].fit
    // truncateHead snaps to a slash, so the leaf can come in under the floor.
    expect(last.path.length).toBeLessThanOrEqual(WHERE_PATH_LEAF_CH)
    expect(last.path.endsWith('/orbital')).toBe(true)
    expect(last.branch).toBe(FEATURE.branch)
    expect(last.lines).toEqual(SPLIT)
  })

  it('collapses split to the total before the strip folds, and never splits a folded strip', () => {
    const steps = sweep({ ...FEATURE, lines: SPLIT })
    const firstFolded = steps.findIndex((s) => s.folded)
    const firstTotal = steps.findIndex((s) => s.fit.lines.length === 1)
    expect(firstTotal).toBeGreaterThan(-1)
    expect(firstTotal).toBeLessThan(firstFolded)
    expect(steps.filter((s) => s.folded).every((s) => s.fit.lines.length <= 1)).toBe(true)
    // …even with room to spare, as in the hysteresis band after a fold.
    expect(fitWhereRow({ ...FEATURE, lines: SPLIT, cellPx: 700, folded: true }).lines).toEqual([SPLIT[0]])
  })

  it('folds the strip only once the row no longer fits whole at the total', () => {
    const row = { ...FEATURE, lines: SPLIT }
    const reserve = whereFoldReservePx(row)
    // Wherever the fold would still hold open, the row needs no cut.
    for (let cellPx = 700; cellPx - reserve >= FOLD_MIN_PATH_PX + FOLD_HYSTERESIS_PX; cellPx--) {
      expect(fitWhereRow({ ...row, cellPx, folded: false }).stage).toBeLessThanOrEqual(1)
    }
    // And at the fold point the branch is still whole.
    const atFold = sweep(row).find((s) => s.folded)!
    expect(atFold.fit.stage).toBe(2)
    expect(atFold.fit.branch).toBe(FEATURE.branch)
  })

  it('cuts the branch in the middle after the fold, not below its floor while the lines are on the row', () => {
    const steps = sweep({ ...WORST, lines: WORST_SPLIT })
    const cut = steps.filter((s) => s.fit.stage === 3)
    expect(cut.length).toBeGreaterThan(0)
    expect(cut.every((s) => s.folded)).toBe(true)
    for (const s of cut) {
      expect(s.fit.branch).toContain('…')
      expect(s.fit.branch.length).toBeGreaterThanOrEqual(WHERE_BRANCH_CUT_CH)
      expect(s.fit.lines).toEqual([WORST_SPLIT[0]])
    }
  })

  it('moves the lines into the branch tooltip rather than dropping them, at step 4', () => {
    const moved = sweep({ ...WORST, lines: WORST_SPLIT }).filter((s) => s.fit.stage === 4)
    expect(moved.length).toBeGreaterThan(0)
    for (const s of moved) {
      expect(s.fit.lines).toEqual([])
      expect(s.fit.linesMoved).toBe(true)
      expect(s.fit.branch.length).toBeGreaterThanOrEqual(WHERE_BRANCH_CUT_CH)
    }
  })

  it('goes to the last resort only when nothing else is left', () => {
    const last = fitWhereRow({ ...WORST, lines: WORST_SPLIT, cellPx: 140, folded: true })
    expect(last.stage).toBe(5)
    expect(last.path).toBe('…')
    expect(last.branch.length).toBe(WHERE_BRANCH_FLOOR_CH)
    expect(last.linesMoved).toBe(true)
  })

  it('never drops the #PR, at any width', () => {
    for (const row of [
      { ...FEATURE, lines: SPLIT },
      { ...WORST, lines: WORST_SPLIT },
      { ...WORST, lines: [] },
    ]) {
      for (const s of sweep(row, 700, 40)) expect(s.fit.pr).toBe(row.pr)
    }
  })

  it('fits what it draws inside the cell, down to the last resort', () => {
    for (const s of sweep({ ...WORST, lines: WORST_SPLIT })) {
      if (s.fit.stage === 5) continue
      const text = (s.fit.path.length + s.fit.branch.length) * CHAR_PX
      const pr = SUFFIX_GAP_PX + s.fit.pr.length * CHAR_PX
      const lines = s.fit.lines.length > 0 ? SUFFIX_GAP_PX + lineGroupsPx(s.fit.lines) : 0
      expect(text + pr + lines).toBeLessThanOrEqual(s.cellPx - WORST.markPx)
    }
  })

  it('without line changes, never reports them moved', () => {
    for (const s of sweep({ ...WORST, lines: [] })) expect(s.fit.linesMoved).toBe(false)
  })
})

describe('fitWhereRow — both off, or nothing to show', () => {
  it("is today's split, width for width, and reserves nothing for the fold", () => {
    const row = { path: WORST.path, branch: WORST.branch, markPx: WORST.markPx, pr: '', lines: [] }
    expect(whereFoldReservePx(row)).toBe(0)
    for (let cellPx = 700; cellPx >= 60; cellPx--) {
      for (const folded of [false, true]) {
        const fit = fitWhereRow({ ...row, cellPx, folded })
        const room = Math.max(0, Math.floor((cellPx - row.markPx) / CHAR_PX))
        expect({ path: fit.path, branch: fit.branch }).toEqual(splitWhereRow(row.path, row.branch, room))
        expect(fit.lines).toEqual([])
      }
    }
  })
})
