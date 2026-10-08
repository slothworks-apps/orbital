import type { ReactElement } from 'react'
import type { GitMark } from '../../lib/whereForm'

/**
 * The git marks the phone draws (canvas `Feature - Git worktree` 2h): the
 * tree before a worktree session's branch and before the compact count, and
 * the three marks of the list of trees. Drawn as the desktop draws them
 * (`panels/WhereLine.tsx`), in the marks' own ink — never a colour of the
 * line's.
 */

const MARK_INK = 'rgba(160,190,225,.75)'
const STROKE = 1.4

function TrunkMark() {
  return (
    <span aria-hidden className="relative block flex-none" style={{ width: 8, height: 12, color: MARK_INK }}>
      <span className="absolute rounded-[1px] bg-current" style={{ left: 3.3, top: 0, width: STROKE, height: 12 }} />
      <span className="absolute rounded-full bg-current" style={{ left: 1, top: 3, width: 6, height: 6 }} />
    </span>
  )
}

function ForkMark() {
  return (
    <span aria-hidden className="relative block flex-none" style={{ width: 10, height: 12, color: MARK_INK }}>
      <span className="absolute rounded-[1px] bg-current" style={{ left: 1, top: 0, width: STROKE, height: 12 }} />
      <span
        className="absolute box-border"
        style={{
          left: 1,
          top: 4.4,
          width: 6.8,
          height: 4.8,
          borderRight: `${STROKE}px solid currentColor`,
          borderBottom: `${STROKE}px solid currentColor`,
          borderBottomRightRadius: 5,
        }}
      />
      <span
        className="absolute box-border rounded-full"
        style={{ left: 5.1, top: 0, width: 4.6, height: 4.6, border: `${STROKE}px solid currentColor` }}
      />
    </span>
  )
}

export function TreeMark() {
  return (
    <span aria-hidden className="relative block flex-none" style={{ width: 13, height: 13, color: MARK_INK }}>
      <span className="absolute rounded-[1px] bg-current" style={{ left: 5.8, top: 4.2, width: STROKE, height: 8.8 }} />
      <span
        className="absolute box-border rounded-full"
        style={{ left: 4.2, top: 0, width: 4.6, height: 4.6, border: `${STROKE}px solid currentColor` }}
      />
      <span
        className="absolute rounded-[1px] bg-current"
        style={{ left: 5.8, top: 3.6, width: STROKE, height: 4.6, transformOrigin: '50% 100%', transform: 'rotate(-48deg)' }}
      />
      <span
        className="absolute box-border rounded-full"
        style={{ left: 0.2, top: 2.6, width: 4.2, height: 4.2, border: `${STROKE}px solid currentColor` }}
      />
      <span
        className="absolute rounded-[1px] bg-current"
        style={{ left: 5.8, top: 6.4, width: STROKE, height: 4.4, transformOrigin: '50% 100%', transform: 'rotate(48deg)' }}
      />
      <span
        className="absolute box-border rounded-full"
        style={{ left: 8.6, top: 5.2, width: 4.2, height: 4.2, border: `${STROKE}px solid currentColor` }}
      />
    </span>
  )
}

const MARKS = { trunk: TrunkMark, fork: ForkMark, tree: TreeMark } satisfies Record<GitMark, () => ReactElement>

/** 2h's sheet: where each mark sits in its 13 × 13 column. */
const LIST_MARK_OFFSET: Record<GitMark, { left: number; top: number }> = {
  trunk: { left: 2.5, top: 0.5 },
  fork: { left: 1.5, top: 0.5 },
  tree: { left: 0, top: 0 },
}

/** A tree's mark in the sheet's 13 × 13 column. */
export function ListMark({ mark }: { mark: GitMark }) {
  const Drawn = MARKS[mark]
  return (
    <span aria-hidden className="relative block flex-none" style={{ width: 13, height: 13 }}>
      <span className="absolute" style={LIST_MARK_OFFSET[mark]}>
        <Drawn />
      </span>
    </span>
  )
}
