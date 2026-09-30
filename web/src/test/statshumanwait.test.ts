import { describe, it, expect } from 'vitest'
import type { StatsRollup } from '../lib/types'
import { sessionWaitCounts, waitCountLine } from '../stats/humanWait'

const stat = (calls: number) => ({ calls, errors: 0, ms: 0, resultChars: 0, buckets: [] })

function rollup(patch: Partial<StatsRollup>): StatsRollup {
  return {
    humanBreakdown: {},
    permissionBreakdown: {},
    permissionTimed: true,
    ...patch,
  } as StatsRollup
}

describe('waitCountLine', () => {
  it('counts questions, plans and permissions, singular where there is one', () => {
    expect(waitCountLine({ questions: 14, plans: 3, permissions: 38 })).toBe(
      'asked you 14× · 3 plan approvals · 38 permissions'
    )
    expect(waitCountLine({ questions: 2, plans: 1, permissions: 1 })).toBe(
      'asked you 2× · 1 plan approval · 1 permission'
    )
  })

  it('leaves permissions out, not zeroed, where prompts were not timed', () => {
    expect(waitCountLine({ questions: 1, plans: 1, permissions: null })).toBe(
      'asked you 1× · 1 plan approval'
    )
  })
})

describe('sessionWaitCounts', () => {
  it('sums permission waits across the prompted tools of a timed session', () => {
    const counts = sessionWaitCounts(
      rollup({
        humanBreakdown: { AskUserQuestion: stat(2), ExitPlanMode: stat(1) },
        permissionBreakdown: { Bash: stat(2), Edit: stat(1) },
      })
    )
    expect(counts).toEqual({ questions: 2, plans: 1, permissions: 3 })
  })

  it('has no permission count for a terminal session', () => {
    expect(sessionWaitCounts(rollup({ permissionTimed: false })).permissions).toBeNull()
  })
})
