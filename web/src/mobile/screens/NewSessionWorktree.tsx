import { useState, type CSSProperties } from 'react'
import { useNow } from '../../lib/useNow'
import type { WorktreeChoice } from '../../lib/useWorktreeChoice'
import { tagColor, type Tag } from '../../lib/types'
import { baseNote, baseRows, occupancyCopy, prTarget } from '../../lib/worktree'
import { prefersReducedMotion } from '../../ui/usePresence'
import { FieldLabel, SheetPresence } from '../ui'
import { BaseSheet } from '../where/BaseSheet'

/** BRANCH and BASE unfold under the switch over this long (canvas 63a, the desktop's clock). */
const UNFOLD_MS = 260
const UNFOLD_EASE = 'cubic-bezier(.2,.8,.25,1)'
/** 63g: the switch's track and knob travel over this long. */
const SWITCH_MS = 180
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
 * so turning it on unfolds them rather than making them appear.
 */
export function NewSessionWorktree({ choice, tags }: { choice: WorktreeChoice; tags: readonly Tag[] }) {
  const [baseSheet, setBaseSheet] = useState(false)
  const now = useNow(choice.fetch.state === 'failed', AGE_TICK_MS)
  const repo = choice.repo
  if (!repo) return null

  const occupant = repo.occupants[0]
  const occupantTag = occupant ? tags.find((t) => String(t.id) === String(occupant.tagId)) : undefined
  const hint = occupant
    ? occupancyCopy(repo.occupants.length, occupant.branch ?? repo.currentBranch, choice.switchedOffByHand)
    : null
  const branchProblem = choice.problems.find((p) => p.field === 'branch')
  const target = choice.on ? prTarget(choice.base, repo.defaultBranch) : null
  const reduced = prefersReducedMotion()
  const fold: CSSProperties = {
    gridTemplateRows: choice.on ? '1fr' : '0fr',
    opacity: choice.on ? 1 : 0,
    transition: reduced ? 'none' : `grid-template-rows ${UNFOLD_MS}ms ${UNFOLD_EASE}, opacity ${UNFOLD_MS}ms ${UNFOLD_EASE}`,
  }
  const travel = reduced ? 'none' : `${SWITCH_MS}ms ease`

  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Worktree">
      <FieldLabel>WORKTREE</FieldLabel>
      {/* 63g: the grouped list, a 14px radius under a .14 hairline over the well. */}
      <div className="overflow-hidden rounded-[14px] border border-line/14 bg-space/50">
        <button
          type="button"
          role="switch"
          aria-checked={choice.on}
          onClick={() => choice.setOn(!choice.on)}
          className="flex min-h-13 w-full items-center gap-3 px-3.5 text-left fs-14.5 font-semibold text-ink-100"
        >
          <span className="flex-1">Work in a worktree</span>
          {/* 63g: a 44 × 26 track, a 20px knob 3px in. */}
          <span
            aria-hidden
            className={['relative block h-[26px] w-11 flex-none rounded-[13px]', choice.on ? 'bg-accent' : 'bg-line/16'].join(' ')}
            style={{ transition: `background-color ${travel}` }}
          >
            <span
              className={[
                'absolute top-[3px] block h-5 w-5 rounded-full',
                choice.on ? 'left-[21px] bg-space-deep' : 'left-[3px] bg-ink-200/80',
              ].join(' ')}
              style={{ transition: reduced ? 'none' : `left ${travel}, background-color ${travel}` }}
            />
          </span>
        </button>
        <div className="grid" style={fold} inert={!choice.on || undefined}>
          <div className="min-h-0 overflow-hidden">
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
          </div>
        </div>
      </div>
      {hint && occupant && (
        // 63g: the desktop's line, muted, the session's own tag dot its only colour.
        <p className="flex items-start gap-2 px-1 fs-12.5 leading-[1.45] text-ink-900/75 [text-wrap:pretty]">
          <span
            aria-hidden
            className="mt-1.5 block h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: occupantTag ? tagColor(occupantTag.hue) : 'var(--state-neutral)' }}
          />
          <span>
            <span className="font-semibold text-ink-100">{occupant.title || 'A session'}</span>
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
