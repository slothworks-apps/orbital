import type { StatsAutoCompact } from '../lib/types'
import { PANEL_CLASS, PANEL_LABEL_CLASS } from './constants'
import { formatCost, formatPercent, formatStatsDuration, formatTokens } from './format'

/**
 * AUTO-COMPACT: whether the experiment pays (spec
 * 2026-10-10-auto-compact-between-turns-design § Stats). The saving is an
 * estimate, and the panel says so; the comparison below it is measured, and
 * says what it compares.
 */
export function AutoCompactPanel({ stats }: { stats: StatsAutoCompact }) {
  const net = stats.compactions > 0 ? stats.netUsd : null
  const perCompaction = stats.compactions > 0 ? stats.rereads / stats.compactions : null

  return (
    <section
      aria-label="Auto-compact"
      className={`${PANEL_CLASS} flex flex-col gap-3 px-5 pb-4 pt-4`}
    >
      <div className="flex items-baseline gap-[14px]">
        <div className={PANEL_LABEL_CLASS}>AUTO-COMPACT</div>
        <div
          className={`font-mono text-[15px] ${net !== null && net < 0 ? 'text-[#ffbb7b]' : 'text-text-bright'}`}
        >
          {net === null
            ? '—'
            : `${net < 0 ? '−' : ''}${formatCost(Math.abs(net))} ${net < 0 ? 'lost' : 'saved'}`}
        </div>
        {stats.netPct !== null && (
          <div className="font-mono text-[10.5px] text-[rgba(160,190,225,.7)]">
            {formatPercent(Math.abs(stats.netPct))} {stats.netPct < 0 ? 'more' : 'less'} in those
            sessions · estimate
          </div>
        )}
      </div>

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 font-mono text-[11.5px]">
        <dt className="text-[rgba(160,190,225,.6)]">Compactions</dt>
        <dd className="text-[rgba(214,228,246,.9)]">
          {stats.compactions} by Orbital
          {stats.avgPreTokens !== null &&
            stats.avgPostTokens !== null &&
            ` · ${formatTokens(stats.avgPreTokens)} → ${formatTokens(stats.avgPostTokens)} on average`}
          {stats.avgDurationMs !== null && ` · ${formatStatsDuration(stats.avgDurationMs)} each`}
          {stats.otherCompactions > 0 && ` · ${stats.otherCompactions} others`}
        </dd>

        <dt className="text-[rgba(160,190,225,.6)]">Saving</dt>
        <dd className="text-[rgba(214,228,246,.9)]">
          {formatCost(stats.savedUsd)} not read later − {formatCost(stats.costUsd)} the compactions
          cost
        </dd>

        <dt className="text-[rgba(160,190,225,.6)]">Re-read after</dt>
        <dd className="text-[rgba(214,228,246,.9)]">
          {stats.rereads} files
          {perCompaction !== null && ` · ${perCompaction.toFixed(1)} per compaction`}
          <span className="text-[rgba(160,190,225,.5)]">
            {' '}
            · read before, needed again in the next turn
          </span>
        </dd>

        <dt className="text-[rgba(160,190,225,.6)]">Orbital sessions</dt>
        <dd className="flex flex-col gap-0.5 text-[rgba(214,228,246,.9)]">
          <span>with it · {groupLine(stats.withAutoCompact)}</span>
          <span>without · {groupLine(stats.withoutAutoCompact)}</span>
        </dd>
      </dl>
    </section>
  )
}

function groupLine(group: StatsAutoCompact['withAutoCompact']): string {
  const parts = [`${group.sessions} sessions`]
  if (group.costPerTurn !== null) parts.push(`${formatCost(group.costPerTurn)} per turn`)
  if (group.avgContextTokens !== null)
    parts.push(`${formatTokens(group.avgContextTokens)} context per request`)
  return parts.join(' · ')
}
