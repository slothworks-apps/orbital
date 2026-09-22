import type { SessionStatsDetail, StatsRollup } from '../lib/types'

/**
 * The two numbers every session surface starts from — the drilldown's tiles
 * (10b), the detail-panel row and the quick dialog (10f/10g). One module
 * because "busy" and "idle" are claims about the same session, and three
 * screens deriving them separately is how two of them end up disagreeing.
 */

/** The four time categories summed. Never the wall clock (10e). */
export function busyMsOf(rollup: StatsRollup): number {
  return rollup.apiMs + rollup.localToolMs + rollup.mcpMs + rollup.subagentMs
}

export interface SessionSpan {
  /** Wall clock from the first entry to the last, or null when either is unmeasured. */
  elapsedMs: number | null
  /** What is left of the clock once busy time is taken out; null with no span. */
  idleMs: number | null
}

/**
 * The session's wall clock against its busy time. Tool calls can overlap, so
 * busy may legitimately exceed the clock — idle is then zero rather than a
 * negative number (controller ruling), and a session that ran parallel tools
 * honestly reports none.
 */
export function spanOf(session: SessionStatsDetail['session'], busyMs: number): SessionSpan {
  const elapsedMs =
    session.firstAt !== null && session.lastAt !== null ? session.lastAt - session.firstAt : null
  return { elapsedMs, idleMs: elapsedMs === null ? null : Math.max(0, elapsedMs - busyMs) }
}
