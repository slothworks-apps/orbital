import type { StatsRollup, StatsTotals } from '../lib/types'

/**
 * Time a session spent waiting on the user inside tool calls — a question, a
 * plan approval, a permission prompt (spec 2026-09-30-human-wait-tools-design).
 * It is never work: the four time categories and busy time never contain it,
 * with the switch on or off. By default a surface shows only how often the
 * session needed the user; the switch adds the time, beside the split.
 */

/**
 * "Show time spent waiting on you" — a persisted preference, not a filter:
 * a server setting, never in the URL query (10e). `/stats` owns the switch;
 * the quick dialog follows it and has none of its own.
 */
export const STATS_SHOW_HUMAN_WAIT_KEY = 'stats_show_human_wait'

export function showHumanWait(settings: Record<string, string | undefined>): boolean {
  return settings[STATS_SHOW_HUMAN_WAIT_KEY] === 'true'
}

export const QUESTION_TOOL = 'AskUserQuestion'
export const PLAN_TOOL = 'ExitPlanMode'

export interface WaitCounts {
  questions: number
  plans: number
  /** Null where prompts were not timed — a terminal session, or a range with no Orbital-run one. */
  permissions: number | null
}

export function sessionWaitCounts(rollup: StatsRollup): WaitCounts {
  const permissions = Object.values(rollup.permissionBreakdown ?? {}).reduce(
    (sum, stat) => sum + stat.calls,
    0
  )
  return {
    questions: rollup.humanBreakdown?.[QUESTION_TOOL]?.calls ?? 0,
    plans: rollup.humanBreakdown?.[PLAN_TOOL]?.calls ?? 0,
    permissions: rollup.permissionTimed ? permissions : null,
  }
}

export function windowWaitCounts(totals: StatsTotals): WaitCounts {
  return {
    questions: totals.questionCount,
    plans: totals.planCount,
    permissions: totals.timedSessionCount > 0 ? totals.permissionCount : null,
  }
}

/**
 * "asked you 14× · 3 plan approvals · 38 permissions" (10k). The permissions
 * part is left out, not zeroed, where prompts were not timed: a terminal
 * session cannot tell an approved prompt from none at all.
 */
export function waitCountLine(counts: WaitCounts): string {
  const parts = [
    `asked you ${counts.questions}×`,
    `${counts.plans} ${counts.plans === 1 ? 'plan approval' : 'plan approvals'}`,
  ]
  if (counts.permissions !== null) {
    parts.push(`${counts.permissions} ${counts.permissions === 1 ? 'permission' : 'permissions'}`)
  }
  return parts.join(' · ')
}
