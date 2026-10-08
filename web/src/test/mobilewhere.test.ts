import { describe, expect, it } from 'vitest'
import type { WhereForm } from '../lib/whereForm'
import { BRANCH_FLOOR_CH, PROJECT_FLOOR_CH, charPxOf, fitWhere, type WhereFitInput } from '../mobile/where/fit'

const formA: WhereForm = { kind: 'branch', count: 3 }
const formB: WhereForm = { kind: 'trees', count: 7 }
const plain: WhereForm = { kind: 'plain' }

function fit(availPx: number | null, patch: Partial<WhereFitInput> = {}) {
  return fitWhere({
    project: 'orbital', branch: 'feature/header-pull-request-and-line-changes', inWorktree: false, form: formA,
    availPx, charPx: charPxOf(11), caretPx: 0, ...patch,
  })
}

/** Every width from wide to narrow, in 1 px steps. */
const widths = Array.from({ length: 500 }, (_, i) => 520 - i)

describe('the phone’s where line (canvas 2h, what gives way)', () => {
  it('draws everything in full before it is measured', () => {
    expect(fit(null)).toEqual({ stage: 0, project: 'orbital', branch: 'feature/header-pull-request-and-line-changes', count: 'full' })
  })

  it('gives way in order — the count’s word, then the branch, then the project — and never drops the count', () => {
    let last = 0
    for (const w of widths) {
      const f = fit(w)
      expect(f.stage).toBeGreaterThanOrEqual(last)
      last = f.stage
      expect(f.count).not.toBe('none')
      if (f.stage >= 1) expect(f.count).toBe('compact')
      if (f.stage < 2) expect(f.branch).toBe('feature/header-pull-request-and-line-changes')
      if (f.stage < 3) expect(f.project).toBe('orbital')
      expect(f.branch.length).toBeGreaterThanOrEqual(BRANCH_FLOOR_CH)
      expect(f.project.length).toBeGreaterThanOrEqual(PROJECT_FLOOR_CH)
    }
    expect(last).toBe(3)
  })

  it('cuts the branch in the middle and the project at its tail', () => {
    const branchCut = widths.map((w) => fit(w)).find((f) => f.stage === 2)!
    expect(branchCut.branch).toMatch(/^feature\/.*….*changes$/)
    const projectCut = fit(264, { project: 'platform-billing-service' })
    expect(projectCut.stage).toBe(3)
    expect(projectCut.project).toMatch(/^platform-.*…$/)
  })

  it('form B draws no branch, and its count only loses its word', () => {
    expect(fit(400, { form: formB, branch: 'main' })).toMatchObject({ stage: 0, branch: '', count: 'full' })
    expect(fit(140, { form: formB, branch: 'main', project: 'auth-service' })).toMatchObject({
      stage: 1, project: 'auth-service', count: 'compact',
    })
  })

  it('the header’s caret makes the count go compact sooner', () => {
    const at = widths.find((w) => fit(w).stage === 1)!
    expect(fit(at + 1).count).toBe('full')
    expect(fit(at + 1, { caretPx: 13 }).count).toBe('compact')
  })

  it('without a count only the branch gives way', () => {
    const f = fit(200, { form: plain })
    expect(f).toMatchObject({ stage: 2, project: 'orbital', count: 'none' })
    expect(f.branch).toContain('…')
    expect(fit(60, { form: plain }).branch.length).toBe(BRANCH_FLOOR_CH)
  })
})
