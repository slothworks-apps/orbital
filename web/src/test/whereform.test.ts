import { describe, it, expect } from 'vitest'
import type { GitLocation, OtherTree } from '../lib/types'
import {
  TREES_LIST_BRANCH_CH,
  TREES_LIST_MAX_ROWS,
  leafOf,
  treeList,
  treesAriaLabel,
  treesCompactText,
  treesCountText,
  treesHeadText,
  whereFormOf,
} from '../lib/whereForm'

const git = (over: Partial<GitLocation> = {}): GitLocation => ({
  ref: 'main',
  detached: false,
  worktree: false,
  defaultBranch: true,
  ...over,
})
const tree = (name: string, over: Partial<OtherTree> = {}): OtherTree => ({
  root: `/r/orbital/.claude/worktrees/${name}`,
  git: git({ ref: `fix/${name}`, worktree: true, defaultBranch: false }),
  agents: [`Work on ${name}`],
  ...over,
})

describe('whereFormOf', () => {
  it('is plain with no other tree, whatever the reading', () => {
    expect(whereFormOf(git(), [])).toEqual({ kind: 'plain' })
    expect(whereFormOf(git(), undefined)).toEqual({ kind: 'plain' })
    expect(whereFormOf(null, [])).toEqual({ kind: 'plain' })
  })

  it('drops the branch on the default branch in the main checkout', () => {
    expect(whereFormOf(git(), [tree('a'), tree('b')])).toEqual({ kind: 'trees', count: 2 })
  })

  it('keeps the branch on a branch or in a worktree of its own', () => {
    const others = [tree('a')]
    expect(whereFormOf(git({ ref: 'feat/x', defaultBranch: false }), others)).toEqual({ kind: 'branch', count: 1 })
    expect(whereFormOf(git({ ref: 'x', worktree: true, defaultBranch: false }), others)).toEqual({
      kind: 'branch',
      count: 1,
    })
    // A detached HEAD in the main checkout is not the default branch.
    expect(whereFormOf(git({ ref: '7dd4938', detached: true, defaultBranch: false }), others)).toEqual({
      kind: 'branch',
      count: 1,
    })
  })

  it('counts without a reading of its own, as form A', () => {
    expect(whereFormOf(null, [tree('a')])).toEqual({ kind: 'branch', count: 1 })
  })
})

describe('the wording', () => {
  it('says plus in form A, not in form B, and singular for one', () => {
    expect(treesCountText({ kind: 'branch', count: 3 })).toBe('+3 worktrees')
    expect(treesCountText({ kind: 'branch', count: 1 })).toBe('+1 worktree')
    expect(treesCountText({ kind: 'trees', count: 3 })).toBe('3 worktrees')
    expect(treesCountText({ kind: 'plain' })).toBe('')
    expect(treesCompactText({ kind: 'branch', count: 3 })).toBe('+3')
    expect(treesCompactText({ kind: 'trees', count: 3 })).toBe('3')
    expect(treesHeadText({ kind: 'branch', count: 1 })).toBe('1 other worktree')
    expect(treesHeadText({ kind: 'trees', count: 2 })).toBe('2 worktrees')
  })

  it('names every tree in the accessible label, by directory when it has no reading', () => {
    const others = [tree('a', { agents: ['One', 'Two'] }), tree('b', { git: null })]
    expect(treesAriaLabel({ kind: 'branch', count: 2 }, others)).toBe(
      'Running subagents in 2 other worktrees: fix/a (One; Two), b (Work on b)',
    )
  })
})

describe('treeList', () => {
  it('caps the rows and counts the rest', () => {
    const many = Array.from({ length: TREES_LIST_MAX_ROWS + 2 }, (_, i) => tree(`t${i}`))
    const list = treeList(many)
    expect(list.rows.map((r) => r.dir)).toEqual(many.slice(0, TREES_LIST_MAX_ROWS).map((t) => leafOf(t.root)))
    expect(list.more).toBe(2)
    expect(treeList(many.slice(0, TREES_LIST_MAX_ROWS)).more).toBe(0)
  })

  it("marks each tree by its own git and names the main checkout by the repository's name", () => {
    const list = treeList([
      { root: '/r/orbital', git: git(), agents: ['Run the suite'] },
      { root: '/r/orbital/', git: git({ ref: 'feat/x', defaultBranch: false }), agents: [] },
      tree('a'),
      tree('b', { git: null }),
    ])
    expect(list.rows.map((r) => [r.mark, r.branch, r.dir])).toEqual([
      ['trunk', 'main', 'orbital'],
      ['fork', 'feat/x', 'orbital'],
      ['tree', 'fix/a', 'a'],
      ['tree', '', 'b'],
    ])
  })

  it('cuts a long branch in the middle', () => {
    const long = 'feat/stats-export-csv-and-json-and-more'
    const [row] = treeList([tree('s', { git: git({ ref: long, worktree: true, defaultBranch: false }) })]).rows
    expect(row.branch).toHaveLength(TREES_LIST_BRANCH_CH)
    expect(row.branch).toContain('…')
    expect(row.branch.startsWith('feat/')).toBe(true)
  })
})
