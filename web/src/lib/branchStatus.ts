import type { BranchLines, BranchPr } from './types'

/**
 * What the detail header draws from `session.branch` (spec
 * 2026-09-30-branch-pr-and-line-changes-design; canvas `Feature - Branch
 * status`). Pure: the fold math in `panels/whereFit.ts` and the suffixes in
 * `panels/BranchSuffixes.tsx` both read from here.
 */

/** `header_line_changes`. Anything unreadable is off, the default. */
export type LinesMode = 'off' | 'branch' | 'split'

/**
 * One `+n −n` run on the row. `uncommitted` draws the hollow ring in front of
 * it — the ring means "not committed yet" and nothing else (canvas 1h).
 */
export interface LineGroup {
  added: number
  removed: number
  uncommitted: boolean
}

/** From this count up a number is shortened (canvas 1h, `12.4k`). */
const LINE_COUNT_SHORT_FROM = 10_000

/** A count as the row prints it: whole below `LINE_COUNT_SHORT_FROM`, one decimal of k above. */
export function formatLineCount(n: number): string {
  if (n < LINE_COUNT_SHORT_FROM) return String(n)
  return `${(Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`
}

/** The minus is U+2212, not a hyphen: the hyphen sits lower and reads as a dash (canvas 1h). */
export const addedText = (n: number) => `+${formatLineCount(n)}`
export const removedText = (n: number) => `−${formatLineCount(n)}`

/**
 * The groups the row draws in full, before any fold step takes one away.
 *
 * - No parent (default branch, detached HEAD): one group, the uncommitted
 *   work alone, with the ring — branch and split look the same here (1b-7).
 * - Otherwise the total; `split` adds the uncommitted part after it, only
 *   when there is any (1b-8).
 * - Nothing changed: no group, so nothing is drawn and no slot is kept.
 */
export function lineGroups(lines: BranchLines | undefined, mode: LinesMode): LineGroup[] {
  if (!lines || mode === 'off') return []
  const { committed, uncommitted } = lines
  const hasUncommitted = uncommitted.added > 0 || uncommitted.removed > 0
  if (lines.parent === null) {
    return hasUncommitted ? [{ ...uncommitted, uncommitted: true }] : []
  }
  const total = {
    added: committed.added + uncommitted.added,
    removed: committed.removed + uncommitted.removed,
    uncommitted: false,
  }
  if (total.added === 0 && total.removed === 0) return []
  return mode === 'split' && hasUncommitted ? [total, { ...uncommitted, uncommitted: true }] : [total]
}

/** The groups as words, for the where-cell's `aria-label` — the lines are not a control. */
export function linesReadout(groups: LineGroup[]): string {
  return groups
    .map((g) => `${g.uncommitted ? 'uncommitted ' : ''}+${g.added} −${g.removed}`)
    .join(', ')
}

/** The PR tooltip's STATE row (canvas 1e). A merged PR names what it went into. */
export function prStateText(pr: BranchPr): string {
  switch (pr.state) {
    case 'merged':
      return `merged into ${pr.base}`
    case 'closed':
      return 'closed, not merged'
    default:
      return pr.state
  }
}

/** REVIEW row (canvas 1e); no decision reads "none" (spec § Pull request). */
export function prReviewText(pr: BranchPr): string {
  switch (pr.review) {
    case 'approved':
      return 'approved'
    case 'changes_requested':
      return 'changes requested'
    case 'review_required':
      return 'review required'
    default:
      return 'none'
  }
}

/**
 * CHECKS row (canvas 1e): only the kinds that have a count, so "8 passed · 3
 * running". No checks reads "none" and the row stays, so the tooltip keeps a
 * fixed height (1e, PR · CLOSED).
 */
export function prChecksText(pr: BranchPr): string {
  const c = pr.checks
  if (!c) return 'none'
  const parts = [
    c.passed > 0 ? `${c.passed} passed` : '',
    c.failed > 0 ? `${c.failed} failed` : '',
    c.pending > 0 ? `${c.pending} running` : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'none'
}

/** The URL as the tooltip's last line names it — without the scheme (canvas 1e). */
export function prUrlText(url: string): string {
  return url.replace(/^https?:\/\//, '')
}

/** The #PR button's accessible name: everything the tooltip says, in one sentence (canvas 1a). */
export function prAriaLabel(pr: BranchPr): string {
  return `Pull request #${pr.number}: ${prStateText(pr)}, ${prReviewText(pr)}, checks ${prChecksText(pr)}. Opens on GitHub.`
}
