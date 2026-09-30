import type { ReactNode } from 'react'
import type { StatsTotals, StatsWindow } from '../lib/types'
import { PANEL_CLASS, PANEL_LABEL_CLASS, TIME_CATEGORIES, TRACK_COLOR } from './constants'
import { waitCountLine, windowWaitCounts } from './humanWait'
import { WaitTile } from './WaitParts'
import {
  formatCostAmount,
  formatDeltaPercent,
  formatPercent,
  formatStatsDuration,
  formatTokens,
  splitTokens,
} from './format'

/**
 * The dashboard's stat tiles (canvas 10a, 10i): total tokens, cost, agent
 * busy time with its four-way split, and the time spent waiting on the user
 * beside it — a count by default, the time too with the switch on.
 *
 * Widths are 10i's own 244 / 244 / 674 / 162 over its 1360px content column,
 * expressed as flex weights so the row keeps those proportions at any window
 * size instead of pinning the page to a 1440px artboard.
 */

function Tile({
  label,
  weight,
  aside,
  children,
}: {
  label: string
  weight: number
  aside?: string
  children: ReactNode
}) {
  return (
    <section
      aria-label={label}
      style={{ flex: `${weight} 1 0` }}
      className={`${PANEL_CLASS} min-w-0 px-[18px] py-4`}
    >
      <div className="flex items-baseline gap-[14px]">
        <div className={PANEL_LABEL_CLASS}>{label}</div>
        {aside !== undefined && (
          <>
            <span className="flex-1" />
            <div className="font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">{aside}</div>
          </>
        )}
      </div>
      {children}
    </section>
  )
}

/** 10e's hero numeral: mono 40/1 at −.02em, the unit at 24 and .75 alpha. */
function Hero({
  value,
  unit,
  unitLeading = false,
}: {
  value: string
  unit?: string
  unitLeading?: boolean
}) {
  const unitSpan = unit ? (
    <span className="text-[24px] text-[rgba(200,225,255,.75)]">{unit}</span>
  ) : null
  return (
    <div className="mt-2.5 font-mono text-[40px] leading-none tracking-[-0.02em] text-text-bright">
      {unitLeading && unitSpan}
      {value}
      {!unitLeading && unitSpan}
    </div>
  )
}

const SUB_LINE_CLASS = 'mt-2.5 flex gap-[14px] font-mono text-[10.5px] text-[rgba(160,190,225,.7)]'

export function StatsTiles({
  totals,
  costDeltaPct,
  window: statsWindow,
  showWaits,
}: {
  totals: StatsTotals
  costDeltaPct: number | null
  window: StatsWindow
  showWaits: boolean
}) {
  const waits = windowWaitCounts(totals)
  // "in" is everything that was priced as input — fresh, cached and written —
  // which is the number the cached ratio below is a share of.
  const inputTotal = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens
  const tokens = splitTokens(inputTotal + totals.outputTokens)

  const busy = totals.busyMs
  const share = (ms: number) => (busy > 0 ? ms / busy : 0)

  return (
    <div className="flex gap-3">
      <Tile label="TOTAL TOKENS" weight={244}>
        <Hero value={tokens.value} unit={tokens.unit} />
        <div className={SUB_LINE_CLASS}>
          <span>in {formatTokens(inputTotal)}</span>
          <span>out {formatTokens(totals.outputTokens)}</span>
          {totals.cachedRatio !== null && (
            <span className="text-accent">cached {formatPercent(totals.cachedRatio)}</span>
          )}
        </div>
      </Tile>

      <Tile label="COST" weight={244}>
        <Hero value={formatCostAmount(totals.costTotal)} unit="$" unitLeading />
        <div className={SUB_LINE_CLASS}>
          {totals.costPerSession !== null && (
            <span>${formatCostAmount(totals.costPerSession)} / session</span>
          )}
          {costDeltaPct !== null && (
            // Amber for a window that cost more than the one before it (10a);
            // a fall is left in the sub-line's own ink — the canvas gives no
            // treatment to a saving, and inventing a green one would read as
            // a goal nobody set.
            <span className={costDeltaPct > 0 ? 'text-[#ffbb7b]' : undefined}>
              {formatDeltaPercent(costDeltaPct)} vs prev {statsWindow}
            </span>
          )}
        </div>
      </Tile>

      <Tile
        label="AGENT BUSY TIME"
        weight={674}
        aside={`of ${formatStatsDuration(totals.wallClockMs)} wall clock`}
      >
        <div className="mt-2 flex items-end gap-[26px]">
          <div className="font-mono text-[40px] leading-none tracking-[-0.02em] text-text-bright">
            {formatStatsDuration(busy)}
          </div>
          <div className="min-w-0 flex-1">
            <div
              className="flex h-2.5 overflow-hidden rounded-[3px]"
              style={{ background: TRACK_COLOR }}
            >
              {TIME_CATEGORIES.map((category) => (
                <div
                  key={category.field}
                  style={{
                    width: `${share(totals[category.field]) * 100}%`,
                    background: category.color,
                  }}
                />
              ))}
            </div>
            <div className="mt-[9px] flex flex-wrap gap-[18px] font-mono text-[10.5px] text-[rgba(160,190,225,.8)]">
              {TIME_CATEGORIES.map((category) => (
                <span key={category.field} className="flex items-center gap-1.5">
                  <span
                    className="block h-2 w-2 rounded-[2px]"
                    style={{ background: category.color }}
                  />
                  {category.label} {formatStatsDuration(totals[category.field])} ·{' '}
                  {formatPercent(share(totals[category.field]))}
                </span>
              ))}
            </div>
          </div>
        </div>
      </Tile>

      <WaitTile
        variant="dashboard"
        timeShown={showWaits}
        ms={totals.humanWaitMs}
        countLine={waitCountLine(waits)}
        // 10e: in a range that mixes terminal and Orbital-run sessions, the
        // permission count covers the Orbital ones only, and the tile says so.
        footnote={
          waits.permissions !== null && totals.timedSessionCount < totals.sessionCount
            ? 'Orbital sessions only'
            : undefined
        }
      />
    </div>
  )
}
