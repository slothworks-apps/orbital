import { useState } from 'react'
import { useNow } from '../../lib/useNow'
import type { WorktreeChoice } from '../../lib/useWorktreeChoice'
import type { Tag } from '../../lib/types'
import { baseNote, baseRows, occupancyHint, prTarget } from '../../lib/worktree'
import { Collapse } from '../../ui/Collapse'
import { UNFOLD_TIMING } from '../../ui/motion'
import { FieldLabel, SheetPresence, Toggle } from '../ui'
import { BaseSheet } from '../where/BaseSheet'

/** `local · 2 h old` reads in hours at the finest it needs. */
const AGE_TICK_MS = 60_000

const HAIRLINE = 'border-t border-line/10'

/**
 * New session's WORKTREE group on the phone (spec 2026-11-02-work-in-a-worktree-design
 * § The phone; canvas 63g): one grouped list under DIRECTORY — the switch row,
 * then BRANCH (edited in place) and BASE (opens `BaseSheet`) as 52px rows —
 * with the desktop's hint line, errors and PR-target note under it. Drawn
 * only for a git repository; the caller leaves it out otherwise.
 *
 * BRANCH and BASE stay mounted while the switch is off, folded to no height,
 * so turning it on unfolds them rather than making them appear — on the
 * desktop's clock (`UNFOLD_TIMING`).
 */
export function NewSessionWorktree({ choice, tags }: { choice: WorktreeChoice; tags: readonly Tag[] }) {
  const [baseSheet, setBaseSheet] = useState(false)
  const now = useNow(choice.fetch.state === 'failed', AGE_TICK_MS)
  const repo = choice.repo
  if (!repo) return null

  const hint = occupancyHint(repo, choice.switchedOffByHand, tags)
  const branchProblem = choice.problems.find((p) => p.field === 'branch')
  const target = choice.on ? prTarget(choice.base, repo.defaultBranch) : null

  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Worktree">
      <FieldLabel>WORKTREE</FieldLabel>
      {/* 63g: the grouped list, a 14px radius under a .14 hairline over the well. */}
      <div className="overflow-hidden rounded-[14px] border border-line/14 bg-space/50">
        {/* 63g: the row's label, then the 44 × 26 switch. */}
        <div className="flex min-h-13 items-center gap-3 pl-3.5 pr-0.5">
          {/* 63g: the whole row is the tap target; the switch carries the name for a screen reader. */}
          <span
            aria-hidden
            onClick={() => choice.setOn(!choice.on)}
            className="flex min-h-13 flex-1 cursor-pointer items-center fs-14.5 font-semibold text-ink-100"
          >
            Work in a worktree
          </span>
          <Toggle size="lg" label="Work in a worktree" checked={choice.on} onChange={choice.setOn} />
        </div>
        <Collapse open={choice.on} keepMounted timing={UNFOLD_TIMING}>
          <label className={['flex min-h-13 items-center gap-3 px-3.5', HAIRLINE].join(' ')}>
            <span className="w-14 flex-none font-mono fs-10 tracking-[0.14em] text-ink-900/60">BRANCH</span>
            <input
              aria-label="Branch"
              aria-invalid={branchProblem !== undefined || undefined}
              value={choice.branch}
              onChange={(e) => choice.setBranch(e.target.value)}
              // Only the form: Orbital names the branch at launch (spec § BRANCH).
              placeholder={`${repo.branchForm}…`}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className={[
                'h-11 min-w-0 flex-1 bg-transparent font-mono fs-13 outline-none placeholder:text-ink-900/45',
                branchProblem ? 'text-danger-pale' : 'text-ink-100',
              ].join(' ')}
            />
            {!choice.branch.trim() && <span className="shrink-0 font-mono fs-11 text-ink-900/55">optional</span>}
          </label>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setBaseSheet(true)}
            className={['flex min-h-13 w-full items-center gap-3 px-3.5 text-left', HAIRLINE].join(' ')}
          >
            <span className="w-14 flex-none font-mono fs-10 tracking-[0.14em] text-ink-900/60">BASE</span>
            <span className="min-w-0 flex-1 truncate font-mono fs-13 text-ink-100">{choice.base}</span>
            <span className="shrink-0 font-mono fs-11 text-ink-900/55">
              {baseNote(choice.base, choice.fetch, repo.fetchedAt, now)}
            </span>
            <span aria-hidden className="shrink-0 fs-18 text-ink-900/60">
              ›
            </span>
          </button>
        </Collapse>
      </div>
      {hint && (
        // 63g: the desktop's line, muted, the session's own tag dot its only colour.
        <p className="flex items-start gap-2 px-1 fs-12.5 leading-[1.45] text-ink-900/75 [text-wrap:pretty]">
          <span
            aria-hidden
            className="mt-1.5 block h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: hint.dot ?? 'var(--state-neutral)' }}
          />
          <span>
            <span className="font-semibold text-ink-100">{hint.name}</span>
            {hint.lead}
            {hint.branch && <span className="font-mono fs-11.5">{hint.branch}</span>}
            {hint.tail}
          </span>
        </p>
      )}
      {choice.on &&
        choice.problems.map((problem) => (
          // 63c A4: the soft error ink, the one fix beside it as a touch-sized text button.
          <p key={problem.field} role="alert" className="flex flex-wrap items-center gap-x-2 px-1 fs-12.5 leading-[1.45] text-danger-pale">
            <span>{problem.text}</span>
            {problem.action && (
              <button
                type="button"
                onClick={problem.action.run}
                className="-my-3 h-11 font-semibold text-ink-100 underline decoration-dashed underline-offset-4"
              >
                {problem.action.label}
              </button>
            )}
          </p>
        ))}
      {target && (
        <p className="px-1 fs-12.5 leading-[1.45] text-ink-900/75">
          The PR will target <span className="font-mono fs-11.5">{target}</span>, not {repo.defaultBranch}.
        </p>
      )}
      <SheetPresence>
        {baseSheet && (
          <BaseSheet
            rows={baseRows(repo, choice.fetch)}
            value={choice.base}
            onPick={(value) => {
              choice.setBase(value)
              setBaseSheet(false)
            }}
            onClose={() => setBaseSheet(false)}
          />
        )}
      </SheetPresence>
    </div>
  )
}
