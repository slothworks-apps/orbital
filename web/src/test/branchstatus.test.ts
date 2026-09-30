import { describe, it, expect } from 'vitest'
import { addedText, formatLineCount, lineGroups, prChecksText, removedText } from '../lib/branchStatus'
import type { BranchLines, BranchPr } from '../lib/types'

describe('formatLineCount', () => {
  it('prints counts under ten thousand whole', () => {
    expect(formatLineCount(0)).toBe('0')
    expect(formatLineCount(9999)).toBe('9999')
  })

  it('shortens from ten thousand up, to one decimal of k, dropping a bare .0', () => {
    expect(formatLineCount(10_000)).toBe('10k')
    expect(formatLineCount(12_420)).toBe('12.4k')
    expect(formatLineCount(12_460)).toBe('12.5k')
    expect(formatLineCount(99_960)).toBe('100k')
  })

  it('signs removals with a real minus, not a hyphen', () => {
    expect(addedText(120)).toBe('+120')
    expect(removedText(34)).toBe('−34')
    expect(removedText(34)).not.toContain('-')
  })
})

const FEATURE: BranchLines = {
  parent: 'main',
  committed: { added: 112, removed: 32 },
  uncommitted: { added: 8, removed: 2 },
}

describe('lineGroups', () => {
  it('draws one total in branch mode, committed and uncommitted together', () => {
    expect(lineGroups(FEATURE, 'branch')).toEqual([{ added: 120, removed: 34, uncommitted: false }])
  })

  it('adds the uncommitted part after the total in split mode', () => {
    expect(lineGroups(FEATURE, 'split')).toEqual([
      { added: 120, removed: 34, uncommitted: false },
      { added: 8, removed: 2, uncommitted: true },
    ])
  })

  it('shows split as the total alone when nothing is uncommitted', () => {
    const clean = { ...FEATURE, uncommitted: { added: 0, removed: 0 } }
    expect(lineGroups(clean, 'split')).toEqual([{ added: 112, removed: 32, uncommitted: false }])
  })

  it('without a parent, counts the uncommitted work alone, ringed, in either mode', () => {
    const main: BranchLines = { parent: null, committed: { added: 0, removed: 0 }, uncommitted: { added: 8, removed: 2 } }
    const ringed = [{ added: 8, removed: 2, uncommitted: true }]
    expect(lineGroups(main, 'branch')).toEqual(ringed)
    expect(lineGroups(main, 'split')).toEqual(ringed)
  })

  it('draws nothing with nothing changed, or with the setting off', () => {
    const none = { parent: 'main', committed: { added: 0, removed: 0 }, uncommitted: { added: 0, removed: 0 } }
    expect(lineGroups(none, 'split')).toEqual([])
    expect(lineGroups({ ...none, parent: null }, 'branch')).toEqual([])
    expect(lineGroups(FEATURE, 'off')).toEqual([])
    expect(lineGroups(undefined, 'split')).toEqual([])
  })
})

describe('prChecksText', () => {
  const pr = (checks: BranchPr['checks']): BranchPr => ({
    number: 1,
    url: 'https://github.com/o/r/pull/1',
    state: 'open',
    review: null,
    checks,
    base: 'main',
  })

  it('names only the kinds that have a count', () => {
    expect(prChecksText(pr({ passed: 8, failed: 0, pending: 3 }))).toBe('8 passed · 3 running')
    expect(prChecksText(pr({ passed: 12, failed: 1, pending: 2 }))).toBe('12 passed · 1 failed · 2 running')
  })

  it('says none when there are no checks, rather than an empty row', () => {
    expect(prChecksText(pr(null))).toBe('none')
    expect(prChecksText(pr({ passed: 0, failed: 0, pending: 0 }))).toBe('none')
  })
})
