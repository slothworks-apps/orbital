import { describe, expect, it } from 'vitest'
import {
  baseNote,
  baseRows,
  branchProblem,
  cleanupChoice,
  endRemoveMode,
  endRowCopy,
  endRowStartsTicked,
  prTarget,
  recentDirectories,
  repoOfWorktreeDir,
  stripShown,
  variantLine,
  worktreeLaunchError,
  type WorktreeRepo,
  type WorktreeState,
} from '../lib/worktree'

const repo: WorktreeRepo = {
  git: true,
  repoRoot: '/r/orbital',
  treeRoot: '/r/orbital',
  defaultBranch: 'main',
  currentBranch: 'fix/tray-flicker',
  occupants: [{ sessionId: 'a', title: 'Fixing tray flicker', tagId: 1, branch: 'fix/tray-flicker' }],
  branchForm: 'feat/',
  branches: {
    local: ['main', 'fix/tray-flicker', 'feat/desk-theme'],
    remote: ['origin/main', 'origin/fix/tray-flicker', 'origin/release/1.9'],
  },
  fetchedAt: null,
  autoOn: true,
}

const state = (patch: Partial<WorktreeState> = {}): WorktreeState => ({
  path: '/r/orbital/.claude/worktrees/tray',
  leaf: 'tray',
  branch: 'feat/tray',
  pr: { number: 1312, state: 'open' },
  pushed: true,
  uncommittedFiles: 0,
  unpushedCommits: 0,
  sharedWith: [],
  variant: 'c1',
  removable: true,
  endsSession: false,
  dismissed: false,
  ...patch,
})

describe('recentDirectories', () => {
  it('shows a worktree directory, or one inside it, as its repository', () => {
    expect(repoOfWorktreeDir('/r/orbital/.claude/worktrees/tray')).toBe('/r/orbital')
    expect(repoOfWorktreeDir('/r/orbital/.claude/worktrees/tray/server')).toBe('/r/orbital')
    expect(repoOfWorktreeDir('/r/orbital/.claude/worktrees/')).toBe('/r/orbital/.claude/worktrees/')
    expect(repoOfWorktreeDir('/r/orbital/.claude')).toBe('/r/orbital/.claude')
  })

  it('lists a repository once, where it was most recent', () => {
    const rows = recentDirectories([
      { cwd: '/r/orbital/.claude/worktrees/a', lastModel: 'm1', lastAt: 3 },
      { cwd: '/r/notes', lastModel: null, lastAt: 2 },
      { cwd: '/r/orbital', lastModel: 'm2', lastAt: 1 },
      { cwd: '/r/orbital/.claude/worktrees/b', lastModel: null, lastAt: 0 },
    ])
    expect(rows.map((r) => r.cwd)).toEqual(['/r/orbital', '/r/notes'])
    expect(rows[0].lastModel).toBe('m1')
  })
})

describe('branchProblem', () => {
  it('lets an empty or new name through', () => {
    expect(branchProblem('', repo.branches)).toBeNull()
    expect(branchProblem('  ', repo.branches)).toBeNull()
    expect(branchProblem('feat/new', repo.branches)).toBeNull()
  })

  it('refuses spaces', () => {
    expect(branchProblem('feat/two words', repo.branches)?.kind).toBe('spaces')
  })

  it('offers to base on a name that exists, the local branch first', () => {
    expect(branchProblem('feat/desk-theme', repo.branches)).toMatchObject({ kind: 'exists', base: 'feat/desk-theme' })
    expect(branchProblem('release/1.9', repo.branches)).toMatchObject({ kind: 'exists', base: 'origin/release/1.9' })
  })
})

describe('baseRows', () => {
  it('lists the main checkout’s branch first, then the default, then every other branch once', () => {
    const rows = baseRows(repo, { state: 'idle' })
    expect(rows.map((r) => r.value)).toEqual([
      'fix/tray-flicker',
      'origin/main',
      'main',
      'feat/desk-theme',
      'origin/fix/tray-flicker',
      'origin/release/1.9',
    ])
    expect(rows[0].sub).toBe('Fixing tray flicker · stack on its work')
  })

  it('has no stacking row when the checkout is on the default branch', () => {
    const rows = baseRows({ ...repo, currentBranch: 'main', occupants: [] }, { state: 'idle' })
    expect(rows[0].value).toBe('origin/main')
  })

  it('says a failed fetch on the default row', () => {
    const rows = baseRows(repo, { state: 'failed', error: 'offline', message: '' })
    expect(rows.find((r) => r.value === 'origin/main')?.sub).toBe('couldn’t fetch · offline')
  })
})

describe('baseNote and prTarget', () => {
  const hour = 3_600_000
  it('names a remote base’s fetch and local main’s age once the fetch failed', () => {
    expect(baseNote('origin/main', { state: 'fetched', at: 0 }, null, 0)).toBe('fetched')
    expect(baseNote('origin/main', { state: 'failed', error: 'offline', message: '' }, null, 0)).toBe('not fetched')
    expect(baseNote('main', { state: 'failed', error: 'offline', message: '' }, 0, 2 * hour)).toBe('local · 2 h old')
    expect(baseNote('main', { state: 'fetched', at: 0 }, null, 2 * hour)).toBe('local')
  })

  it('names the PR target only off the default', () => {
    expect(prTarget('origin/main', 'main')).toBeNull()
    expect(prTarget('main', 'main')).toBeNull()
    expect(prTarget('fix/tray-flicker', 'main')).toBe('fix/tray-flicker')
    expect(prTarget('origin/release/1.9', 'main')).toBe('release/1.9')
  })
})

describe('worktreeLaunchError', () => {
  it('reads the worktree refusals and nothing else', () => {
    expect(worktreeLaunchError(new Error(JSON.stringify({ error: 'worktree_branch_exists', message: 'x exists' })))).toEqual({
      error: 'worktree_branch_exists',
      message: 'x exists',
    })
    expect(worktreeLaunchError(new Error(JSON.stringify({ error: 'no_such_directory' })))).toBeNull()
    expect(worktreeLaunchError(new Error('Internal Server Error'))).toBeNull()
  })
})

describe('variantLine', () => {
  it('says what stays, or what would be lost, with the right plural', () => {
    expect(variantLine(state())).toBe('Branch stays on GitHub · PR #1312 open')
    expect(variantLine(state({ pr: { number: 7, state: 'merged' } }))).toBe('Branch stays on GitHub · PR #7 merged')
    expect(variantLine(state({ pr: null, pushed: false }))).toBe('Branch stays on this Mac')
    expect(variantLine(state({ variant: 'c2a', uncommittedFiles: 1 }))).toBe('1 file uncommitted')
    expect(variantLine(state({ variant: 'c2a', uncommittedFiles: 3 }))).toBe('3 files uncommitted')
    expect(variantLine(state({ variant: 'c2b', unpushedCommits: 1 }))).toBe('1 commit unpushed · branch stays on this Mac')
    expect(variantLine(state({ variant: 'c2b', unpushedCommits: 2 }))).toBe('2 commits unpushed · branch stays on this Mac')
  })
})

describe('End’s worktree row', () => {
  it('starts ticked only when nothing would be lost', () => {
    expect(endRowStartsTicked(state())).toBe(true)
    expect(endRowStartsTicked(state({ variant: 'c2a', uncommittedFiles: 3 }))).toBe(false)
    expect(endRowStartsTicked(state({ variant: 'c2b', unpushedCommits: 2 }))).toBe(false)
  })

  it('names the discard and forces only for uncommitted files, ticked', () => {
    const dirty = state({ variant: 'c2a', uncommittedFiles: 3 })
    expect(endRowCopy(dirty, true)).toEqual({ line: 'Discards 3 uncommitted files', loses: true, endLabel: 'End and discard' })
    expect(endRowCopy(dirty, false).endLabel).toBe('End session')
    expect(endRemoveMode(dirty, true)).toBe('force')
    expect(endRemoveMode(dirty, false)).toBeUndefined()
    expect(endRemoveMode(state({ variant: 'c2b', unpushedCommits: 1 }), true)).toBe('clean')
    expect(endRemoveMode(state(), true)).toBe('clean')
  })

  it('offers nothing while another session is in the tree or the tree cannot go', () => {
    expect(endRemoveMode(state({ variant: 'c3' }), true)).toBeUndefined()
    expect(endRemoveMode(state({ removable: false }), true)).toBeUndefined()
    expect(endRemoveMode(null, true)).toBeUndefined()
  })
})

describe('stripShown', () => {
  it('shows for a resting session whose pushed branch has a PR', () => {
    expect(stripShown('idle', state())).toBe(true)
    expect(stripShown('ended', state())).toBe(true)
    expect(stripShown('needs_input', state())).toBe(true)
  })

  it('stays away while working, without a PR or a push, in C3, unremovable or kept', () => {
    expect(stripShown('working', state())).toBe(false)
    expect(stripShown('idle', state({ pr: null }))).toBe(false)
    expect(stripShown('idle', state({ pushed: false }))).toBe(false)
    expect(stripShown('idle', state({ variant: 'c3' }))).toBe(false)
    expect(stripShown('idle', state({ removable: false }))).toBe(false)
    expect(stripShown('idle', state({ dismissed: true }))).toBe(false)
    expect(stripShown('idle', null)).toBe(false)
  })
})

describe('cleanupChoice', () => {
  it('keeps the order and moves the fill; ends first where the session has not ended', () => {
    expect(cleanupChoice({ variant: 'c1', endsSession: false })).toEqual({ keep: 'plain', remove: 'filled', removeLabel: 'Remove', force: false })
    expect(cleanupChoice({ variant: 'c2a', endsSession: false })).toEqual({ keep: 'filled', remove: 'loses', removeLabel: 'Discard, remove', force: true })
    expect(cleanupChoice({ variant: 'c2b', endsSession: false })).toEqual({ keep: 'filled', remove: 'plain', removeLabel: 'Remove', force: false })
    expect(cleanupChoice({ variant: 'c1', endsSession: true }).removeLabel).toBe('End and remove')
    expect(cleanupChoice({ variant: 'c2a', endsSession: true }).removeLabel).toBe('End, discard, remove')
  })
})
