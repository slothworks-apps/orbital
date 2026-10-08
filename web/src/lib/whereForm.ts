import { truncateMiddle } from './format'
import type { GitLocation, OtherTree } from './types'

/**
 * Which form a session's "where" reading takes, and the words and rows it is
 * drawn from (spec 2026-10-07-live-working-tree-design § 5; canvas `Feature -
 * Git worktree` turn 2, 2e). Pure, and shared: the desktop header
 * (`panels/WhereLine.tsx`) and the phone read the same decision, so the two
 * can never disagree about which form a session is in.
 *
 * - `plain` — no running subagent works in another tree: the reading as it
 *   always was.
 * - `branch` (2e form A) — the mark, the branch and its suffixes, then
 *   "+N worktrees".
 * - `trees` (2e form B) — the session sits on the default branch in the main
 *   checkout, where the branch says nothing about where the work is: only
 *   "N worktrees", no plus, and no mark, branch or suffixes.
 */
export type WhereForm = { kind: 'plain' } | { kind: 'branch'; count: number } | { kind: 'trees'; count: number }

export function whereFormOf(
  git: GitLocation | null | undefined,
  otherTrees: readonly OtherTree[] | undefined,
): WhereForm {
  const count = otherTrees?.length ?? 0
  if (count === 0) return { kind: 'plain' }
  if (git && git.defaultBranch && !git.worktree) return { kind: 'trees', count }
  return { kind: 'branch', count }
}

/** Which mark a git reading draws. Picked on the client, never sent by the server. */
export type GitMark = 'trunk' | 'fork' | 'tree'

/** Turn 1's rule: tree for a worktree; in the main checkout trunk on the default branch or a detached HEAD, fork otherwise. */
export function markOf(git: GitLocation): GitMark {
  if (git.worktree) return 'tree'
  return git.detached || git.defaultBranch ? 'trunk' : 'fork'
}

const plural = (n: number) => (n === 1 ? '' : 's')

/**
 * The count as the row spells it out (2e read-out): "+3 worktrees" in form A
 * — the plus says "in addition to this tree" — and "3 worktrees" in form B.
 * Empty for `plain`, which draws nothing.
 */
export function treesCountText(form: WhereForm): string {
  if (form.kind === 'plain') return ''
  const words = `${form.count} worktree${plural(form.count)}`
  return form.kind === 'branch' ? `+${words}` : words
}

/** The compact count, drawn after a tree mark (2e compact form): "+3" in form A, "3" in form B. */
export function treesCompactText(form: WhereForm): string {
  if (form.kind === 'plain') return ''
  return form.kind === 'branch' ? `+${form.count}` : String(form.count)
}

/** The list's head (2e tooltip): "3 other worktrees" in form A, "3 worktrees" in form B. */
export function treesHeadText(form: WhereForm): string {
  if (form.kind === 'plain') return ''
  const other = form.kind === 'branch' ? 'other ' : ''
  return `${form.count} ${other}worktree${plural(form.count)}`
}

/** 2e overflow: the list shows this many trees, then "+N more". */
export const TREES_LIST_MAX_ROWS = 5
/** 2e tooltip row: the branch is middle-cut to this many characters. */
export const TREES_LIST_BRANCH_CH = 22

/** One tree as the list draws it. */
export interface TreeRow {
  root: string
  /** By that tree's own git; a tree with no reading draws the worktree mark. */
  mark: GitMark
  /** The branch middle-cut to `TREES_LIST_BRANCH_CH` (the sha when detached); empty without a reading. */
  branch: string
  /** The root's last segment — the worktree's directory, or the repository's name for its main checkout (2k). */
  dir: string
  /** The running subagents' task descriptions, one line each. */
  agents: string[]
}

export interface TreeList {
  rows: TreeRow[]
  /** How many trees did not fit — the "+N more" line; 0 draws none. */
  more: number
}

/** The last segment of a path, ignoring a trailing slash. */
export function leafOf(root: string): string {
  const trimmed = root.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/** The trees as the list draws them, in the server's order (most recently started first), capped at `TREES_LIST_MAX_ROWS`. */
export function treeList(otherTrees: readonly OtherTree[] | undefined): TreeList {
  const trees = otherTrees ?? []
  return {
    rows: trees.slice(0, TREES_LIST_MAX_ROWS).map((tree) => ({
      root: tree.root,
      mark: tree.git ? markOf(tree.git) : 'tree',
      branch: tree.git ? truncateMiddle(tree.git.ref, TREES_LIST_BRANCH_CH) : '',
      dir: leafOf(tree.root),
      agents: tree.agents,
    })),
    more: Math.max(0, trees.length - TREES_LIST_MAX_ROWS),
  }
}

/** The "+N more" line under a capped list. */
export function treesMoreText(more: number): string {
  return `+${more} more`
}

/**
 * The read-out's accessible name (2e): "Running subagents in 3 other
 * worktrees: fix/tray-flicker (Reproduce the tray flicker), …". Every tree,
 * not just the listed ones, with its full branch — a tree without a reading
 * is named by its directory.
 */
export function treesAriaLabel(form: WhereForm, otherTrees: readonly OtherTree[] | undefined): string {
  if (form.kind === 'plain') return ''
  const trees = (otherTrees ?? []).map((tree) => `${tree.git?.ref ?? leafOf(tree.root)} (${tree.agents.join('; ')})`)
  return `Running subagents in ${treesHeadText(form)}: ${trees.join(', ')}`
}
