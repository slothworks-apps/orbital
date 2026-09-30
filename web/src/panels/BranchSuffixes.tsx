import type { ReactNode } from 'react'
import {
  addedText,
  prChecksText,
  prReviewText,
  prStateText,
  prUrlText,
  removedText,
} from '../lib/branchStatus'
import type { LineGroup } from '../lib/branchStatus'
import { DIFF_ADDED_INK_CLASS, DIFF_REMOVED_INK_CLASS } from '../lib/diff'
import type { BranchLines, BranchPr } from '../lib/types'
import { LINE_GROUP_GAP_PX, LINE_PAIR_GAP_PX, RING_PX } from './whereFit'

/**
 * The pieces the header's pull request and line changes are drawn from
 * (canvas `Feature - Branch status` 1a, 1e, 1h), shared by the row and by the
 * preview under Settings → Appearance → "Line changes in the header" (1g).
 */

/** 1h: the ring's stroke — the one mark that means "uncommitted". */
function Ring({ dimmed = false }: { dimmed?: boolean }) {
  return (
    <span
      aria-hidden
      className="box-border block flex-none rounded-full border-[1.2px] border-[rgba(160,190,225,.85)]"
      style={{ width: RING_PX, height: RING_PX, opacity: dimmed ? 0 : 1 }}
    />
  )
}

/** The `+n −n` groups, in the transcript's diff pair. */
export function LineGroups({ groups }: { groups: LineGroup[] }) {
  return (
    <span className="flex flex-none items-center font-mono text-[11px]" style={{ gap: LINE_GROUP_GAP_PX }}>
      {groups.map((g, i) => (
        <span key={i} className="flex items-center" style={{ gap: LINE_PAIR_GAP_PX }}>
          {g.uncommitted && <Ring />}
          <span className={DIFF_ADDED_INK_CLASS}>{addedText(g.added)}</span>
          <span className={DIFF_REMOVED_INK_CLASS}>{removedText(g.removed)}</span>
        </span>
      ))}
    </span>
  )
}

const TIP_LABEL = 'text-[9.5px] tracking-[.14em] text-[rgba(160,190,225,.6)]'
const TIP_RULE = 'border-t border-[rgba(150,205,255,.1)]'

/** 1e: the PR bubble — number, then state · review · checks, then where the click goes. */
export function PrTooltipContent({ pr }: { pr: BranchPr }) {
  const row = (label: string, value: string) => (
    <>
      <span className={TIP_LABEL}>{label}</span>
      <span className="text-text-bright">{value}</span>
    </>
  )
  return (
    <>
      <span className="flex items-baseline gap-2 font-mono">
        <span className="text-[11px] text-text-bright">Pull request #{pr.number}</span>
        <span className="flex-1" />
        <span className="text-[10px] text-[rgba(160,190,225,.6)]">↗ GitHub</span>
      </span>
      <span className="grid grid-cols-[58px_minmax(0,1fr)] items-baseline gap-x-2.5 gap-y-1.5 font-mono text-[11px] leading-[1.4]">
        {row('STATE', prStateText(pr))}
        {row('REVIEW', prReviewText(pr))}
        {row('CHECKS', prChecksText(pr))}
      </span>
      <span className={`${TIP_RULE} pt-2 font-mono text-[10px] text-[rgba(160,190,225,.6)] [overflow-wrap:anywhere]`}>
        click opens {prUrlText(pr.url)}
      </span>
    </>
  )
}

interface LinesTipProps {
  lines: BranchLines
  /** The branch, or the sha when `detached`. */
  branch: string
  detached: boolean
}

/**
 * 1e: "against <parent>", committed and uncommitted, the total. No parent:
 * the one uncommitted row and the sentence that says why. The same split in
 * branch and split mode — the bubble always names both parts.
 */
export function LinesTooltipContent({ lines, branch, detached }: LinesTipProps) {
  const { committed, uncommitted, parent } = lines
  const row = (label: string, ring: boolean, added: number, removed: number, total = false): ReactNode => (
    <span className={`flex items-center gap-1.5 font-mono text-[11px] ${total ? `${TIP_RULE} pt-[7px]` : ''}`}>
      {total ? <span className="block flex-none" style={{ width: RING_PX }} /> : <Ring dimmed={!ring} />}
      <span className={`flex-1 ${total ? 'text-text-bright' : 'text-[rgba(200,220,245,.8)]'}`}>{label}</span>
      <span className={`min-w-[48px] text-right ${DIFF_ADDED_INK_CLASS}`}>{addedText(added)}</span>
      <span className={`min-w-[40px] text-right ${DIFF_REMOVED_INK_CLASS}`}>{removedText(removed)}</span>
    </span>
  )
  return (
    <span className="flex flex-col gap-[7px]">
      <span className="flex items-baseline gap-2 font-mono">
        <span className={TIP_LABEL}>LINE CHANGES</span>
        <span className="flex-1" />
        <span className="text-[10.5px] text-text-bright">
          {parent ? `against ${parent}` : `on ${branch}, no parent`}
        </span>
      </span>
      {parent && row('committed', false, committed.added, committed.removed)}
      {row('uncommitted', true, uncommitted.added, uncommitted.removed)}
      {parent
        ? row(
            'total',
            false,
            committed.added + uncommitted.added,
            committed.removed + uncommitted.removed,
            true,
          )
        : (
          <span className={`${TIP_RULE} pt-[7px] text-[11.5px] leading-[1.45] text-[rgba(190,212,238,.75)] [text-wrap:pretty]`}>
            {/* 1e draws the default branch's sentence; a detached HEAD has no
                parent either (spec § Line changes), so it gets its own first
                clause and the same reason. */}
            {detached ? 'HEAD is detached' : 'This is the default branch'}: there is nothing to compare commits
            against, so only uncommitted work is counted.
          </span>
        )}
    </span>
  )
}

/** 1e, BRANCH · LINES MOVED IN: the full name, a hairline, the lines under it. */
export function BranchLinesTooltipContent(props: LinesTipProps) {
  return (
    <>
      <span className="font-mono text-[11px] leading-[1.45] text-text-bright [overflow-wrap:anywhere]">{props.branch}</span>
      <span className="block h-px bg-[rgba(150,205,255,.1)]" />
      <LinesTooltipContent {...props} />
    </>
  )
}
