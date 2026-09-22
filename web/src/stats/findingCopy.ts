import type { SessionStatsDetail, StatsFinding } from '../lib/types'
import { CHARS_PER_TOKEN, RESOLVED_CLEAN_SESSIONS, RESOLVED_TTL_DAYS } from './constants'
import { formatPercent, formatStatsDuration, formatTokens, formatToolName } from './format'

/**
 * A finding's two lines of copy (canvas 10d: every card states its rule, its
 * severity, its session and the measured evidence). The endpoint sends the
 * rule and the raw numbers only — the sentence is the UI's job, and it is
 * here rather than in the card so the drilldown and the quick dialog print
 * the same finding the same way.
 *
 * Evidence keys differ per rule and arrive as `unknown`, so every read goes
 * through the accessors below: a rule whose evidence is missing a field
 * degrades to a vaguer sentence instead of printing `undefined`.
 */

export interface FindingCopy {
  headline: string
  evidence: string
  /** Shown where a card's session link would be, for a finding that has no session. */
  scope?: string
  /**
   * What the rule looks for, in one sentence — what 10b's "why this fired"
   * reveals. Deliberately without the thresholds: they are server constants,
   * and a number copied here would drift from the one that actually fired.
   */
  why?: string
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Joins the parts that are actually known with the canvas's middot separator. */
function line(...parts: Array<string | null>): string {
  return parts.filter((p): p is string => p !== null).join(' · ')
}

/** One sentence per rule, keyed by rule id — see `FindingCopy.why`. */
const WHY: Record<string, string> = {
  'cache-burn':
    'Fires when most of a session pays full price for input the prompt cache should have served — usually because something near the top of the prompt keeps changing.',
  'obese-tool-result':
    'Fires when a single tool result is large enough to take a noticeable share of the context window, and of every request that follows it.',
  'error-loop':
    'Fires when the same call fails with the same input several times in a row — the retries cost tokens and cannot succeed.',
  'slow-mcp':
    'Fires when one MCP tool answers slowly across enough calls for the wait to be the server, not one bad request.',
}

export function findingCopy(finding: StatsFinding): FindingCopy {
  const copy = measuredCopy(finding)
  const why = WHY[finding.rule]
  // A resolved finding is a record of a rule that stopped firing — "fires
  // when…" would be answering a question its card does not raise.
  if (why === undefined || finding.severity === 'resolved') return copy
  return { ...copy, why }
}

/**
 * The turn a rule blames, as the entry uuid the transcript gave it — the key
 * the drilldown matches against `turns[].uuid` (ADR
 * `a-rule-names-its-turn-by-uuid`). Null for a rule that names no turn, and
 * for the window-level ones, which are not about a turn at all.
 */
export function findingTurnUuid(evidence: Record<string, unknown>): string | null {
  return text(evidence.firstTurnUuid) ?? text(evidence.turnUuid)
}

/**
 * A session-detail finding in the feed's shape. `GET /api/stats/sessions/:id`
 * sends the rule, the severity and the evidence only — the session it belongs
 * to is the one already being read — while `findingCopy` and the cards take
 * the feed's `StatsFinding`. The drilldown (10b) and the quick dialog (10f)
 * both need the conversion, so it lives with the copy rather than in either.
 */
export function withSession(
  finding: SessionStatsDetail['findings'][number],
  session: SessionStatsDetail['session'],
  now: number = Date.now()
): StatsFinding {
  return {
    ...finding,
    sessionId: session.id,
    title: session.title,
    projectDir: session.projectDir,
    // A live session has not ended yet, so its findings were measured now.
    when: session.lastAt ?? now,
  }
}

function measuredCopy(finding: StatsFinding): FindingCopy {
  const e = finding.evidence

  if (finding.severity === 'resolved') {
    return {
      headline: `${finding.rule} no longer fires`,
      evidence: `last ${RESOLVED_CLEAN_SESSIONS} sessions clean · drops off in ${RESOLVED_TTL_DAYS}d`,
    }
  }

  switch (finding.rule) {
    case 'cache-burn': {
      const affected = num(e.turnsAffected)
      const total = num(e.totalTurns)
      const ratio = num(e.hitRatio)
      const uncached = num(e.uncachedInputTokens)
      return {
        headline:
          affected !== null && total !== null
            ? `Prompt cache invalidated on ${affected} of ${total} turns`
            : 'Prompt cache invalidated on most turns',
        evidence: line(
          uncached !== null ? `${formatTokens(uncached)} tokens of uncached input` : null,
          ratio !== null ? `cache hit ${formatPercent(ratio)}` : null
        ),
      }
    }

    case 'obese-tool-result': {
      const tool = text(e.tool)
      const tokens = num(e.estimatedTokens)
      const chars = num(e.chars)
      return {
        headline:
          tokens !== null
            ? `One ${tool ? formatToolName(tool) : 'tool'} result added ${formatTokens(tokens)} tokens to the window`
            : `One ${tool ? formatToolName(tool) : 'tool'} result overran the window`,
        evidence: line(
          chars !== null ? `${formatTokens(chars)} characters in a single result` : null,
          `estimated at ${CHARS_PER_TOKEN} characters per token`
        ),
      }
    }

    case 'error-loop': {
      const tool = text(e.tool)
      const count = num(e.count)
      return {
        headline:
          count !== null
            ? `Same failing ${tool ? formatToolName(tool) : 'tool'} call retried ${count}× in a row`
            : `The same failing ${tool ? formatToolName(tool) : 'tool'} call repeated`,
        evidence: line(
          tool !== null ? formatToolName(tool) : null,
          'identical input, error each time'
        ),
      }
    }

    case 'slow-mcp': {
      const tool = text(e.tool)
      const p50 = num(e.p50Ms)
      const calls = num(e.calls)
      const totalMs = num(e.totalMs)
      const share = num(e.shareOfMcpTime)
      const sessions = num(e.sessionCount)
      return {
        headline:
          tool !== null && p50 !== null
            ? // `≈`: `histogramP50` returns the geometric midpoint of a bucket,
              // not a measured value, so the figure is an estimate to a factor
              // of the bucket width — the sign keeps it from reading as exact.
              `${formatToolName(tool)} p50 ≈ ${formatStatsDuration(p50)}`
            : 'An MCP tool is answering slowly',
        evidence: line(
          calls !== null ? `${calls} calls` : null,
          totalMs !== null ? `${formatStatsDuration(totalMs)} total` : null,
          share !== null ? `${formatPercent(share)} of all MCP time` : null
        ),
        scope: sessions !== null ? `server-wide · ${sessions} sessions` : 'server-wide',
      }
    }

    default:
      // A rule this build has no copy for still gets a readable card rather
      // than a blank one — the server may ship a rule before the web does.
      return { headline: finding.rule, evidence: '' }
  }
}
