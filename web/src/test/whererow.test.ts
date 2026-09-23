import { describe, it, expect } from 'vitest'
import {
  splitWhereRow,
  truncateHead,
  truncateMiddle,
  WHERE_BRANCH_CAP_CH,
  WHERE_BRANCH_FLOOR_CH,
  WHERE_PATH_FLOOR_CH,
} from '../lib/format'

const PATH = '~/work/platform/auth-service'
const BRANCH = 'feature/interactive-decisions-and-questions'

describe('truncateHead', () => {
  it('leaves a path that fits alone', () => {
    expect(truncateHead(PATH, PATH.length)).toBe(PATH)
  })

  it('cuts the front and snaps to a slash', () => {
    expect(truncateHead(PATH, 20)).toBe('…/auth-service')
  })

  it('cuts without snapping when the snap would leave too little', () => {
    // Snapping here would spend most of the budget on the separator and
    // leave a stub nobody could identify the directory by.
    expect(truncateHead('~/a/verylongdirectoryname', 12)).toBe('…rectoryname')
  })
})

describe('truncateMiddle', () => {
  it('keeps the prefix and the tail, which is what tells branches apart', () => {
    expect(truncateMiddle(BRANCH, 21)).toBe('feature/in…-questions')
  })

  it('leaves a branch that fits alone', () => {
    expect(truncateMiddle('main', 10)).toBe('main')
  })
})

describe('splitWhereRow', () => {
  it('shows both whole when they fit', () => {
    const fit = splitWhereRow('~/P/orbital', 'main', 40)
    expect(fit).toEqual({ path: '~/P/orbital', branch: 'main' })
  })

  it('cuts the path first, leaving the branch whole', () => {
    const fit = splitWhereRow(PATH, 'main', 24)
    expect(fit.branch).toBe('main')
    expect(fit.path.startsWith('…')).toBe(true)
  })

  it('caps the branch even when there is room, so it cannot eat the path', () => {
    const fit = splitWhereRow(PATH, BRANCH, PATH.length + WHERE_BRANCH_CAP_CH + 4)
    expect(fit.branch.length).toBeLessThanOrEqual(WHERE_BRANCH_CAP_CH)
    expect(fit.path.length).toBeGreaterThanOrEqual(WHERE_PATH_FLOOR_CH)
  })

  it('stops shrinking the branch at its floor', () => {
    // The narrowest the panel goes; both parts still have to be readable.
    const fit = splitWhereRow(PATH, BRANCH, 20)
    expect(fit.branch.length).toBe(WHERE_BRANCH_FLOOR_CH)
    expect(fit.branch).toContain('…')
  })

  it('gives the whole row to the path when there is no branch to show', () => {
    expect(splitWhereRow(PATH, '', 40)).toEqual({ path: PATH, branch: '' })
  })

  it('never lets a short branch be cut for a long path', () => {
    const fit = splitWhereRow(PATH, 'main', 18)
    expect(fit.branch).toBe('main')
  })
})
