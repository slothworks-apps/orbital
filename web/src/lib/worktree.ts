import { spacedAgo } from './devices'
import type { DirectoryRow } from './directorySearch'
import type { SessionStatus } from './types'

/**
 * Work in a worktree (spec 2026-11-02-work-in-a-worktree-design; canvas
 * `Feature - Work in a worktree` 63a–63h): the wire shapes and the pure rules
 * the desktop dialog, the detail panel and the phone share. Nothing here
 * draws; every sentence the feature shows is composed here so the phone says
 * exactly what the desktop says.
 */

/** One live session in the checkout the dialog's directory resolves to. */
export interface WorktreeOccupant {
  sessionId: string
  title: string
  tagId: number | string | null
  branch: string | null
}

/** `GET /api/worktree/options?cwd=&machine=`. */
export type WorktreeOptions =
  | { git: false }
  | {
      git: true
      repoRoot: string
      treeRoot: string
      defaultBranch: string
      currentBranch: string | null
      occupants: WorktreeOccupant[]
      /** The form the repository's branch names take, `feat/` say: the BRANCH placeholder. */
      branchForm: string
      /** Remote ones as `origin/x`. */
      branches: { local: string[]; remote: string[] }
      /** When `origin` was last fetched, or null when never. */
      fetchedAt: number | null
      /** The switch starts on: the checkout is occupied and the setting allows it. */
      autoOn: boolean
    }

export type WorktreeRepo = Extract<WorktreeOptions, { git: true }>

/** `POST /api/worktree/fetch`. */
export type WorktreeFetchResult =
  | { ok: true; fetchedAt: number }
  | { ok: false; error: 'offline' | 'auth' | 'other'; message: string }

/** The four cleanup variants (canvas 63f). */
export type WorktreeVariant = 'c1' | 'c2a' | 'c2b' | 'c3'

/** `GET /api/sessions/:id/worktree`. */
export interface WorktreeState {
  path: string
  /** The worktree directory's name. */
  leaf: string
  branch: string | null
  pr: { number: number; state: 'open' | 'draft' | 'merged' | 'closed' } | null
  pushed: boolean
  uncommittedFiles: number
  unpushedCommits: number
  sharedWith: string[]
  variant: WorktreeVariant
  removable: boolean
  /** Removing it ends the session first (an Orbital session that has not ended). */
  endsSession: boolean
  /** Keep was pressed for this worktree: the panel strip stays away. */
  dismissed: boolean
}

/** What `POST /api/sessions` refuses a worktree launch with. */
export type WorktreeLaunchError = 'worktree_branch_exists' | 'worktree_invalid_branch' | 'worktree_failed'

/** `POST /api/sessions/:id/worktree/remove` refusals. */
export type WorktreeRemoveRefusal = 'worktree_shared' | 'worktree_live_terminal' | 'worktree_dirty'

/** `POST /api/sessions/:id/end`'s `removeWorktree`. */
export type RemoveWorktreeMode = 'clean' | 'force'

/** The worktree part of a launch: `POST /api/sessions`'s `worktree`. */
export interface WorktreeLaunch {
  base: string
  branch?: string
}

/** Whether a reply is a `WorktreeState` — a Mac without the route answers something else, or nothing. */
export function isWorktreeState(value: unknown): value is WorktreeState {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<WorktreeState>
  return typeof v.path === 'string' && typeof v.variant === 'string' && typeof v.removable === 'boolean'
}

/** Whether a reply is a repository's options. Anything else, an older Mac's `{}` included, hides the group. */
export function isWorktreeRepo(value: unknown): value is WorktreeRepo {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<WorktreeRepo>
  return v.git === true && typeof v.defaultBranch === 'string' && Array.isArray(v.branches?.local)
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// ---------------------------------------------------------------------------
// RECENT

/** Where linked worktrees live, relative to the repository root. */
const WORKTREES_SEGMENT = '/.claude/worktrees/'

/**
 * The repository a directory under `<repo>/.claude/worktrees/<x>` belongs to,
 * or the directory itself. A subdirectory inside the worktree maps to the
 * repository too: RECENT is about where to start, not about the tree.
 */
export function repoOfWorktreeDir(dir: string): string {
  const at = dir.indexOf(WORKTREES_SEGMENT)
  if (at <= 0) return dir
  const leaf = dir.slice(at + WORKTREES_SEGMENT.length).split('/')[0]
  return leaf ? dir.slice(0, at) : dir
}

/**
 * New session's RECENT pills (spec § The home of a worktree session): a
 * directory under `<repo>/.claude/worktrees/` shows as the repository, and a
 * repository appears once, at its most recent place.
 */
export function recentDirectories(rows: readonly DirectoryRow[]): DirectoryRow[] {
  const seen = new Set<string>()
  const out: DirectoryRow[] = []
  for (const row of rows) {
    const cwd = repoOfWorktreeDir(row.cwd)
    if (seen.has(cwd)) continue
    seen.add(cwd)
    out.push(cwd === row.cwd ? row : { ...row, cwd })
  }
  return out
}

// ---------------------------------------------------------------------------
// BRANCH and BASE

/** The directory a branch name gives the worktree: its last segment. */
export function worktreeLeaf(branch: string): string {
  return branch.split('/').filter(Boolean).pop() ?? ''
}

const stripRemote = (ref: string) => ref.replace(/^origin\//, '')

export type BranchProblem =
  | { kind: 'spaces'; text: string }
  | { kind: 'exists'; text: string; base: string }

/**
 * What is wrong with a typed BRANCH, checked as the user types (canvas 63c
 * A4): spaces, or a name that already exists here or on `origin`. An existing
 * name offers *Base on it*, which bases on that branch — the local one when
 * there is one. Empty is fine: Orbital names the branch at launch.
 */
export function branchProblem(typed: string, branches: WorktreeRepo['branches']): BranchProblem | null {
  const name = typed.trim()
  if (!name) return null
  if (/\s/.test(name)) return { kind: 'spaces', text: 'Branch names can’t contain spaces.' }
  const local = branches.local.includes(name)
  const remote = branches.remote.includes(`origin/${name}`)
  if (!local && !remote) return null
  return {
    kind: 'exists',
    text: `${name} already exists. Pick another name, or base on it.`,
    base: local ? name : `origin/${name}`,
  }
}

/** Where `origin` stands for the dialog: being fetched, fetched, or the fetch failed. */
export type FetchState =
  | { state: 'idle' }
  | { state: 'fetching' }
  | { state: 'fetched'; at: number }
  | { state: 'failed'; error: 'offline' | 'auth' | 'other'; message: string }

/** The default base: `origin/<default branch>`. */
export function defaultBase(repo: Pick<WorktreeRepo, 'defaultBranch'>): string {
  return `origin/${repo.defaultBranch}`
}

/** The sentence a failed fetch shows under BASE (canvas 63c A4). */
export function fetchFailureText(error: 'offline' | 'auth' | 'other'): string {
  if (error === 'offline') return 'Couldn’t fetch origin. You seem to be offline.'
  if (error === 'auth') return 'Couldn’t fetch origin. Git could not sign in to it.'
  return 'Couldn’t fetch origin.'
}

/**
 * The note beside the chosen base on the BASE field (canvas 63a: `origin/main
 * · fetched`; 63c A4: `local · 2 h old` once local main stands in for a
 * failed fetch).
 */
export function baseNote(base: string, fetch: FetchState, fetchedAt: number | null, now: number): string {
  if (base.startsWith('origin/')) {
    if (fetch.state === 'fetching') return 'fetching…'
    if (fetch.state === 'failed') return 'not fetched'
    return 'fetched'
  }
  const at = fetch.state === 'fetched' ? fetch.at : fetchedAt
  if (fetch.state === 'failed' && at !== null) {
    const age = spacedAgo(at, now)
    return age === 'now' ? 'local' : `local · ${age} old`
  }
  return 'local'
}

export interface BaseRow {
  value: string
  label: string
  /** Mono note on the row's right. */
  sub?: string
  group: string
}

export const BASE_GROUPS = {
  current: 'MAIN CHECKOUT IS ON NOW',
  default: 'DEFAULT',
  all: 'ALL BRANCHES',
} as const

/**
 * The BASE picker's rows, in the canvas's order (63c): the branch the main
 * checkout is on when it is not the default (named after the session working
 * there, for stacking on its work), then the default, then every other local
 * and remote branch. A value is listed once, in its first place.
 */
export function baseRows(repo: WorktreeRepo, fetch: FetchState): BaseRow[] {
  const rows: BaseRow[] = []
  const seen = new Set<string>()
  const add = (row: BaseRow) => {
    if (seen.has(row.value)) return
    seen.add(row.value)
    rows.push(row)
  }
  const current = repo.currentBranch
  if (current && current !== repo.defaultBranch) {
    const occupant = repo.occupants.find((o) => !o.branch || o.branch === current) ?? repo.occupants[0]
    add({
      value: current,
      label: current,
      sub: occupant ? `${occupant.title} · stack on its work` : 'stack on its work',
      group: BASE_GROUPS.current,
    })
  }
  add({
    value: defaultBase(repo),
    label: defaultBase(repo),
    sub:
      fetch.state === 'failed'
        ? fetch.error === 'offline'
          ? 'couldn’t fetch · offline'
          : 'couldn’t fetch'
        : fetch.state === 'fetching'
          ? 'fetching…'
          : 'fetched when you turned this on',
    group: BASE_GROUPS.default,
  })
  for (const name of repo.branches.local) add({ value: name, label: name, sub: 'local', group: BASE_GROUPS.all })
  for (const name of repo.branches.remote) add({ value: name, label: name, sub: 'remote', group: BASE_GROUPS.all })
  return rows
}

/** The branch a PR opened from the worktree targets, when that is not the default (canvas 63c); null otherwise. */
export function prTarget(base: string, defaultBranch: string): string | null {
  const target = stripRemote(base)
  return target === defaultBranch ? null : target
}

/** The footer summary's worktree part (spec § The footer summary). */
export function worktreeSummary(branch: string, base: string): string {
  const name = branch.trim()
  return name ? `worktree ${worktreeLeaf(name)} from ${base}` : `worktree from ${base} · Orbital names the branch at launch`
}

/**
 * The group's last line (Worktree Group component): where the worktree will
 * be, under the main checkout's root. With BRANCH empty its name is not known
 * yet, so the line says who names it.
 */
export function worktreePathLine(repoRoot: string, branch: string): string {
  const leaf = worktreeLeaf(branch.trim())
  return leaf
    ? `→ ${repoRoot}/.claude/worktrees/${leaf}`
    : `→ ${repoRoot}/.claude/worktrees/… · Orbital names the branch at launch`
}

/**
 * The occupancy hint's words around the session's name and the branch (canvas 63b A2):
 * where the checkout is and, once the switch has been turned off by hand, the
 * consequence, once.
 */
export function occupancyCopy(
  occupants: number,
  branch: string | null,
  switchedOff: boolean,
): { lead: string; branch: string | null; tail: string } {
  const others = occupants > 1 ? ` and ${plural(occupants - 1, 'other', 'others')}` : ''
  const verb = occupants > 1 ? 'are' : 'is'
  return {
    lead: `${others} ${verb} working here${branch ? ' on ' : ''}`,
    branch,
    tail: switchedOff ? '. This session would share its branch and files.' : '.',
  }
}

/** A launch refused for its worktree: the code and the server's sentence, or null for any other failure. */
export function worktreeLaunchError(err: unknown): { error: WorktreeLaunchError; message: string } | null {
  if (!(err instanceof Error)) return null
  try {
    const body = JSON.parse(err.message) as { error?: unknown; message?: unknown }
    if (
      body.error === 'worktree_branch_exists' ||
      body.error === 'worktree_invalid_branch' ||
      body.error === 'worktree_failed'
    ) {
      return { error: body.error, message: typeof body.message === 'string' ? body.message : '' }
    }
  } catch {
    // Not a JSON body: not the worktree's refusal.
  }
  return null
}

// ---------------------------------------------------------------------------
// Cleanup

/** The variant's line under "Remove worktree?" and under End's row (canvas 63f, 63h). */
export function variantLine(state: Pick<WorktreeState, 'variant' | 'pr' | 'pushed' | 'uncommittedFiles' | 'unpushedCommits'>): string {
  switch (state.variant) {
    case 'c2a':
      return `${plural(state.uncommittedFiles, 'file', 'files')} uncommitted`
    case 'c2b':
      return `${plural(state.unpushedCommits, 'commit', 'commits')} unpushed · branch stays on this Mac`
    case 'c3':
      return ''
    case 'c1':
      if (state.pr) return `Branch stays on GitHub · PR #${state.pr.number} ${state.pr.state === 'draft' ? 'draft' : state.pr.state}`
      return state.pushed ? 'Branch stays on GitHub' : 'Branch stays on this Mac'
  }
}

/** Whether End offers the "Also remove worktree" row (canvas 63h): every removable worktree but C3. */
export function endOffersRemoval(state: WorktreeState | null): state is WorktreeState {
  return state !== null && state.removable && state.variant !== 'c3'
}

/** The row is ticked when End opens only when nothing would be lost (63h). */
export function endRowStartsTicked(state: WorktreeState): boolean {
  return state.variant === 'c1'
}

/** What End's row and button say for this tick (63h): C2a ticked names the loss. */
export function endRowCopy(state: WorktreeState, ticked: boolean): { line: string; loses: boolean; endLabel: string } {
  const loses = ticked && state.variant === 'c2a'
  return {
    line: loses ? `Discards ${plural(state.uncommittedFiles, 'uncommitted file', 'uncommitted files')}` : variantLine(state),
    loses,
    endLabel: loses ? 'End and discard' : 'End session',
  }
}

/** What End sends for its row: nothing unticked, `force` only where uncommitted files go with it. */
export function endRemoveMode(state: WorktreeState | null, ticked: boolean): RemoveWorktreeMode | undefined {
  if (!endOffersRemoval(state) || !ticked) return undefined
  return state.variant === 'c2a' ? 'force' : 'clean'
}

/**
 * Whether the detail panel shows the cleanup strip (canvas 63e; spec § Where
 * it is offered, 2): the session is not working, its branch is pushed and
 * has a PR, nobody else is in the tree, and Keep has not been pressed.
 */
export function stripShown(status: SessionStatus, state: WorktreeState | null): state is WorktreeState {
  return (
    state !== null &&
    status !== 'working' &&
    state.pr !== null &&
    state.pushed &&
    state.removable &&
    state.variant !== 'c3' &&
    !state.dismissed
  )
}

export type ChoiceFill = 'filled' | 'plain' | 'loses'

/**
 * The strip's two buttons (canvas 63e/63f): always Keep, then Remove; only
 * the fill moves. C1 fills Remove; C2 fills Keep, and C2a's Remove names the
 * discard in the soft error ink. A session that has not ended is ended first.
 */
export function cleanupChoice(state: Pick<WorktreeState, 'variant' | 'endsSession'>): {
  keep: ChoiceFill
  remove: ChoiceFill
  removeLabel: string
  force: boolean
} {
  const ends = state.endsSession
  if (state.variant === 'c2a') {
    return { keep: 'filled', remove: 'loses', removeLabel: ends ? 'End, discard, remove' : 'Discard, remove', force: true }
  }
  const removeLabel = ends ? 'End and remove' : 'Remove'
  if (state.variant === 'c2b') return { keep: 'filled', remove: 'plain', removeLabel, force: false }
  return { keep: 'plain', remove: 'filled', removeLabel, force: false }
}

/** The one line left after a press (canvas 63e). */
export function cleanupAfterText(action: 'removed' | 'kept', state: Pick<WorktreeState, 'branch' | 'pushed'>): string {
  if (action === 'kept') return 'Kept. ⋯ → Remove worktree when you’re done with it.'
  if (!state.branch) return 'Worktree removed.'
  return `Worktree removed. Branch ${state.branch} stays ${state.pushed ? 'on GitHub' : 'on this Mac'}.`
}
