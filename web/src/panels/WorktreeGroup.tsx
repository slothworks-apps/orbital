import { useId } from 'react'
import { shortenPath } from '../lib/format'
import { useNow } from '../lib/useNow'
import type { WorktreeChoice } from '../lib/useWorktreeChoice'
import type { Tag } from '../lib/types'
import {
  BASE_GROUPS,
  baseMatches,
  baseNote,
  baseRows,
  occupancyHint,
  prTarget,
  worktreePathLine,
  type FetchState,
  type WorktreeRepo,
} from '../lib/worktree'
import { Toggle } from '../ui/Checkbox'
import { Collapse } from '../ui/Collapse'
import { UNFOLD_TIMING } from '../ui/motion'
import { Select, type SelectOption, type SelectSearch } from '../ui/Select'
import { ForkMark } from './WhereLine'

/** Worktree Group: folded, the block pulls up by the group's gap, so it takes no room at all. */
const FOLDED_PULL_PX = -10
/** `local · 2 h old` reads in hours at the finest it needs. */
const AGE_TICK_MS = 60_000
/** Worktree Group: the branch list under the search scrolls past this height. */
const BRANCH_LIST_MAX_HEIGHT = 178

/** BASE's search (canvas 63c): over every local and remote branch, under the main checkout's and the default. */
const BASE_SEARCH: SelectSearch<string> = {
  group: BASE_GROUPS.all,
  placeholder: 'Search local and remote branches',
  match: baseMatches,
  empty: (query) => `No branch matches “${query}”`,
  maxHeight: BRANCH_LIST_MAX_HEIGHT,
}

/**
 * BASE's options (Worktree Group: the list's rows): the picker's rows, a
 * remote's `origin/` stepped back, the main checkout's and the default's note
 * under the name and `local`/`remote` on the right, and the field's note for
 * whichever is chosen.
 */
function baseOptions(repo: WorktreeRepo, fetch: FetchState, now: number): SelectOption<string>[] {
  return baseRows(repo, fetch).map((row) => ({
    value: row.value,
    label: row.label,
    group: row.group,
    labelLead: 'origin/',
    ...(row.group === BASE_GROUPS.all ? { trail: row.sub } : { sub: row.sub }),
    triggerTrail: baseNote(row.value, fetch, repo.fetchedAt, now),
  }))
}

/**
 * BRANCH's box (Worktree Group component): 9px/12px inside a 9px radius over
 * the well, mono 12px, so it lines up with BASE's `branch` field under it.
 * The edge is the soft error ink while an error stands.
 */
function branchBox(error: boolean): string {
  return [
    'w-full min-w-0 rounded-[9px] border bg-space/60 px-3 py-[9px] font-mono fs-12 text-ink-100 outline-none transition-[border-color] duration-[180ms] ease-[ease]',
    error ? 'border-danger-pale/50' : 'border-line/18',
  ].join(' ')
}

const SUB_LABEL = 'font-mono fs-9.5 tracking-[0.14em] text-ink-900/55'

/**
 * New session's WORKTREE group (spec 2026-11-02-work-in-a-worktree-design §
 * The WORKTREE group; canvas `Worktree Group` component, imported by 63a–63c),
 * under PROJECT DIRECTORY. Drawn only for a git repository (`choice.repo`).
 *
 * - A1 quiet: the WORKTREE kicker and the switch, one 18px line.
 * - A2 occupied: who works in the checkout and on which branch; their tag dot
 *   is the line's only colour, never a warning hue. Off by hand, it adds the
 *   consequence once.
 * - A3 on: BRANCH and BASE stacked, the PR target when the base is not the
 *   default, and where the worktree will be.
 * - A4: errors inline, each with its one fix; Launch waits meanwhile.
 *
 * The only motion: the switch (`SWITCH_MS`), the unfold (`UNFOLD_TIMING`)
 * and the dropdown's arrival, each played once. BRANCH and BASE stay mounted
 * while the switch is off, so what was typed survives turning it off and on.
 */
export function WorktreeGroup({ choice, tags }: { choice: WorktreeChoice; tags: readonly Tag[] }) {
  const ids = useId()
  const repo = choice.repo
  const now = useNow(choice.fetch.state === 'failed', AGE_TICK_MS)
  if (!repo) return null

  const hint = occupancyHint(repo, choice.switchedOffByHand, tags)
  const branchProblem = choice.problems.find((p) => p.field === 'branch')
  const baseProblem = choice.problems.find((p) => p.field === 'base')
  const target = prTarget(choice.base, repo.defaultBranch)

  return (
    <div className="flex flex-col gap-2.5" role="group" aria-label="Worktree">
      <div className="flex min-h-[18px] items-center gap-2">
        <span className="font-mono fs-10 tracking-[0.16em] text-ink-900/60">WORKTREE</span>
        <span aria-hidden className="flex-1" />
        <Toggle variant="leading" label="Work in a worktree" checked={choice.on} onChange={choice.setOn} />
      </div>
      {hint && (
        // A2: muted ink, the session's own tag dot, no icon.
        <p className="-mt-[3px] flex items-center gap-2 fs-12 leading-[1.45] text-ink-900/75 [text-wrap:pretty]">
          <span
            aria-hidden
            className="block h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: hint.dot ?? 'currentColor' }}
          />
          <span>
            <span className="font-semibold text-ink-100">{hint.name}</span>
            {hint.lead}
            {hint.branch && <span className="font-mono fs-11 text-ink-600/85">{hint.branch}</span>}
            {hint.tail}
          </span>
        </p>
      )}
      <Collapse
        open={choice.on}
        keepMounted
        unclip
        pull={FOLDED_PULL_PX}
        timing={UNFOLD_TIMING}
        className="min-w-0 grid-cols-[minmax(0,1fr)]"
      >
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex min-w-0 flex-col gap-2.5">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className={`flex gap-1.5 ${SUB_LABEL}`}>
                BRANCH
                {!choice.branch.trim() && <span className="tracking-[0.04em] text-ink-900/45">· optional</span>}
              </span>
              <input
                id={`${ids}-branch`}
                type="text"
                spellCheck={false}
                autoComplete="off"
                aria-label="New branch name"
                aria-invalid={branchProblem !== undefined || undefined}
                placeholder={`${repo.branchForm}…`}
                value={choice.branch}
                onChange={(e) => choice.setBranch(e.target.value)}
                className={`${branchBox(branchProblem !== undefined)} placeholder:text-ink-900/45`}
              />
            </label>
            <div className="flex min-w-0 flex-col gap-1.5">
              <span id={`${ids}-base`} className={SUB_LABEL}>
                BASE
              </span>
              <Select
                variant="branch"
                className="w-full"
                aria-labelledby={`${ids}-base`}
                options={baseOptions(repo, choice.fetch, now)}
                value={choice.base}
                placeholder={choice.base}
                invalid={baseProblem !== undefined}
                search={BASE_SEARCH}
                onChange={choice.setBase}
              />
            </div>
          </div>
          {choice.problems.map((problem) => (
            // A4: the soft error ink, a mono `!`, the one fix in the accent.
            <p
              key={problem.field}
              role="alert"
              className="flex items-baseline gap-2 fs-12 leading-[1.45] text-danger-pale"
            >
              <span aria-hidden className="font-mono fs-11">
                !
              </span>
              <span className="flex-1">{problem.text}</span>
              {problem.action && (
                <button
                  type="button"
                  onClick={problem.action.run}
                  className="flex-none fs-12 font-semibold text-accent hover:text-ink-300"
                >
                  {problem.action.label}
                </button>
              )}
            </p>
          ))}
          {target && (
            // A3 stacked base: neutral ink with the fork mark.
            <p className="flex items-center gap-2 fs-12 text-ink-900/75">
              <ForkMark ink="currentColor" />
              <span>
                The PR will target <span className="font-mono fs-11 text-ink-600/85">{target}</span>, not{' '}
                {repo.defaultBranch}.
              </span>
            </p>
          )}
          <div className="truncate font-mono fs-10.5 text-ink-900/50">
            {worktreePathLine(shortenPath(repo.repoRoot), choice.branch)}
          </div>
        </div>
      </Collapse>
    </div>
  )
}
