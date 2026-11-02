import {
  WORKTREES_DIR,
  leafOf,
  repoOfWorktreeDir,
  stripOrigin,
  type EndSessionResult,
  type EndWithWorktreeRequest,
  type WorktreeFetchError,
  type WorktreeLaunchError,
  type WorktreeOccupant,
  type WorktreeOptions,
  type WorktreeRemoveRefusal,
  type WorktreeRemoveRequest,
  type WorktreeState,
} from '@orbital/shared/worktree'
import { spacedAgo } from './devices'
import type { DirectoryRow } from './directorySearch'
import { tagColor, type SessionStatus, type Tag } from './types'

/**
 * Work in a worktree (spec 2026-11-02-work-in-a-worktree-design; canvas
 * `Feature - Work in a worktree` 63a–63h): the UI's rules and copy, which the
 * desktop dialog, the detail panel and the phone share. The wire shapes, the
 * paths and the variant rule are `@orbital/shared/worktree`'s, agreed with
 * the Mac. Nothing here draws; every sentence the feature shows is composed
 * here so the phone says exactly what the desktop says.
 */

export type WorktreeRepo = Extract<WorktreeOptions, { git: true }>

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
  | { state: 'failed'; error: WorktreeFetchError; message: string }

/** The default base: `origin/<default branch>`. */
export function defaultBase(repo: Pick<WorktreeRepo, 'defaultBranch'>): string {
  return `origin/${repo.defaultBranch}`
}

/** The sentence a failed fetch shows under BASE (canvas 63c A4). */
export function fetchFailureText(error: WorktreeFetchError): string {
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
  const target = stripOrigin(base)
  return target === defaultBranch ? null : target
}

/** The footer summary's worktree part (spec § The footer summary). */
export function worktreeSummary(branch: string, base: string): string {
  const name = branch.trim()
  return name ? `worktree ${leafOf(name)} from ${base}` : `worktree from ${base} · Orbital names the branch at launch`
}

/**
 * The group's last line (Worktree Group component): where the worktree will
 * be, under the main checkout's root. With BRANCH empty its name is not known
 * yet, so the line says who names it.
 */
export function worktreePathLine(repoRoot: string, branch: string): string {
  const name = branch.trim()
  return name
    ? `→ ${repoRoot}/${WORKTREES_DIR}/${leafOf(name)}`
    : `→ ${repoRoot}/${WORKTREES_DIR}/… · Orbital names the branch at launch`
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

/** The occupancy hint (canvas 63b A2) as both the desktop and the phone draw it. */
export interface OccupancyHint {
  /** The first occupant's title, or a stand-in. */
  name: string
  /** Its tag's colour, the line's only colour; null without a tag. */
  dot: string | null
  lead: string
  branch: string | null
  tail: string
}

/**
 * The occupancy hint for a repository, or null when nobody works in its
 * checkout: the first occupant named, with its tag's colour, and the branch
 * it is on (the checkout's, when the occupant's own is not known).
 */
export function occupancyHint(
  repo: Pick<WorktreeRepo, 'occupants' | 'currentBranch'>,
  switchedOffByHand: boolean,
  tags: readonly Tag[],
): OccupancyHint | null {
  const occupant: WorktreeOccupant | undefined = repo.occupants[0]
  if (!occupant) return null
  const tag = occupant.tagId === null ? undefined : tags.find((t) => String(t.id) === occupant.tagId)
  return {
    name: occupant.title || 'A session',
    dot: tag ? tagColor(tag.hue) : null,
    ...occupancyCopy(repo.occupants.length, occupant.branch ?? repo.currentBranch, switchedOffByHand),
  }
}

/** Whether a BASE row matches the picker's search: anywhere in its name, case aside. */
export function baseMatches(row: Pick<BaseRow, 'label'>, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || row.label.toLowerCase().includes(q)
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

/** Whether the worktree can be offered for removal at all: removable, and nobody else is in it (not C3). */
export function removalOffered(state: WorktreeState | null): state is WorktreeState {
  return state !== null && state.removable && state.variant !== 'c3'
}

/** Whether End offers the "Also remove worktree" row (canvas 63h): every removable worktree but C3. */
export const endOffersRemoval = removalOffered

/**
 * The row is ticked when End opens only when the work is done (spec § Where
 * it is offered, 1): nothing local would be lost (C1) and the PR is merged or
 * closed. A session waiting on review keeps its folder unless asked.
 */
export function endRowStartsTicked(state: Pick<WorktreeState, 'variant' | 'pr'>): boolean {
  return state.variant === 'c1' && (state.pr?.state === 'merged' || state.pr?.state === 'closed')
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

/**
 * What End sends for its row: nothing unticked; ticked, the removal —
 * `force` only where uncommitted files go with it — and the path the row
 * showed, so a worktree that changed under the dialog is refused rather
 * than removed.
 */
export function endRequest(state: WorktreeState | null, ticked: boolean): EndWithWorktreeRequest {
  if (!endOffersRemoval(state) || !ticked) return {}
  return { removeWorktree: state.variant === 'c2a' ? 'force' : 'clean', worktreePath: state.path }
}

/** What a removal or an End that removes may answer: done, or refused before anything happened. */
export type EndAnswer = EndSessionResult | { error: WorktreeRemoveRefusal }

/** Whether End was refused, so nothing ended (`worktree_state_changed`, say). */
export function endRefused(answer: EndAnswer): answer is { error: WorktreeRemoveRefusal } {
  return !('ok' in answer)
}

/**
 * The note after an End that went through but whose worktree stayed (git
 * refused, or the session no longer works in one); null otherwise. The
 * session did end: this is never said as a failed End.
 */
export function endedWorktreeNote(answer: EndAnswer): string | null {
  if (endRefused(answer) || answer.worktreeRemoved !== false) return null
  const why = answer.message.trim()
  return `Session ended. The worktree stayed${why ? `: ${why}` : '.'}`
}

/** What a refused removal says (the server's 404 and 409s): the state moved since it was read. */
export const REFUSALS: Record<WorktreeRemoveRefusal, string> = {
  not_worktree: 'The session no longer works in a worktree.',
  worktree_shared: 'Another session is working in this worktree now.',
  worktree_live_terminal: 'A terminal session is still running in this worktree.',
  worktree_dirty: 'The worktree has uncommitted changes now.',
  worktree_state_changed: 'The worktree changed since this was shown. Look again before removing it.',
}

/**
 * What a removal sends: exactly what the user was shown — whether it ends
 * the session ("End and remove"), whether it discards ("Discard, remove") —
 * and the path they confirmed. The server refuses with
 * `worktree_state_changed` when either no longer holds.
 */
export function removeRequest(state: Pick<WorktreeState, 'variant' | 'endsSession' | 'path'>): WorktreeRemoveRequest {
  return { force: cleanupChoice(state).force, endSession: state.endsSession, path: state.path }
}

/**
 * Whether the detail panel shows the cleanup strip (canvas 63e; spec § Where
 * it is offered, 2): only for an ended session — a live one never shows it,
 * so its transcript does not jump — whose branch is pushed and has a PR,
 * when nobody else is in the tree and Keep has not been pressed. A live
 * session's worktree goes through End or ⋯ → Remove worktree.
 */
export function stripShown(status: SessionStatus, state: WorktreeState | null): state is WorktreeState {
  return status === 'ended' && removalOffered(state) && state.pr !== null && state.pushed && !state.dismissed
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
