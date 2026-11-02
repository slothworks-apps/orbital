import { describe, expect, it } from 'vitest'
import { BASE_GROUPS, type BaseRow, type WorktreeState } from '../lib/worktree'
import { baseSheetLines, cleanupRowPlace, cleanupSheetButtons } from '../mobile/worktree'

const state = (over: Partial<WorktreeState> = {}): WorktreeState => ({
  path: '/r/.claude/worktrees/x',
  leaf: 'x',
  branch: 'feat/x',
  pr: { number: 7, state: 'open' },
  pushed: true,
  uncommittedFiles: 0,
  unpushedCommits: 0,
  sharedWith: [],
  variant: 'c1',
  removable: true,
  endsSession: false,
  dismissed: false,
  ...over,
})

describe('cleanupRowPlace', () => {
  it('puts the row under an ended session’s transcript', () => {
    expect(cleanupRowPlace('ended', state())).toBe('tail')
  })

  it('puts it under the where line of a session that has not ended, open PR included', () => {
    expect(cleanupRowPlace('idle', state())).toBe('header')
    expect(cleanupRowPlace('needs_input', state({ pr: { number: 7, state: 'merged' } }))).toBe('header')
  })

  it('follows the desktop strip: never while working, without a PR, unpushed, shared or kept', () => {
    const merged = { pr: { number: 7, state: 'merged' as const } }
    expect(cleanupRowPlace('working', state(merged))).toBeNull()
    expect(cleanupRowPlace('ended', state({ pr: null }))).toBeNull()
    expect(cleanupRowPlace('ended', state({ pushed: false }))).toBeNull()
    expect(cleanupRowPlace('ended', state({ variant: 'c3' }))).toBeNull()
    expect(cleanupRowPlace('ended', state({ dismissed: true }))).toBeNull()
    expect(cleanupRowPlace('ended', null)).toBeNull()
  })
})

describe('cleanupSheetButtons', () => {
  it('puts the filled choice on top: Remove when nothing is lost, Keep otherwise', () => {
    expect(cleanupSheetButtons(state()).order).toEqual(['remove', 'keep'])
    expect(cleanupSheetButtons(state({ variant: 'c2b' })).order).toEqual(['keep', 'remove'])
    const dirty = cleanupSheetButtons(state({ variant: 'c2a' }))
    expect(dirty.order).toEqual(['keep', 'remove'])
    expect(dirty.removeLoses).toBe(true)
  })

  it('names what Remove does on the phone’s full-width button', () => {
    expect(cleanupSheetButtons(state()).removeLabel).toBe('Remove worktree')
    expect(cleanupSheetButtons(state({ endsSession: true })).removeLabel).toBe('End and remove')
    expect(cleanupSheetButtons(state({ variant: 'c2a' })).removeLabel).toBe('Discard, remove')
  })
})

describe('baseSheetLines', () => {
  const rows: BaseRow[] = [
    { value: 'fix/a', label: 'fix/a', sub: 'A · stack on its work', group: BASE_GROUPS.current },
    { value: 'origin/main', label: 'origin/main', group: BASE_GROUPS.default },
    { value: 'feat/b', label: 'feat/b', sub: 'local', group: BASE_GROUPS.all },
    { value: 'origin/feat/c', label: 'origin/feat/c', sub: 'remote', group: BASE_GROUPS.all },
  ]

  it('keeps the picker’s order, each group under one caption', () => {
    expect(baseSheetLines(rows, '').map((l) => (l.kind === 'caption' ? l.label : l.row.value))).toEqual([
      BASE_GROUPS.current, 'fix/a', BASE_GROUPS.default, 'origin/main', BASE_GROUPS.all, 'feat/b', 'origin/feat/c',
    ])
  })

  it('narrows by the search, case aside, and drops a caption with nothing under it', () => {
    expect(baseSheetLines(rows, ' FEAT ').map((l) => (l.kind === 'caption' ? l.label : l.row.value))).toEqual([
      BASE_GROUPS.all, 'feat/b', 'origin/feat/c',
    ])
    expect(baseSheetLines(rows, 'nothing')).toEqual([])
  })
})
