import { useState } from 'react'
import type { StatsHumanRow, StatsToolLeaderboard, StatsTotals } from '../lib/types'
import {
  CHARS_PER_TOKEN,
  LEADERBOARD_ROW_PITCH,
  LOCAL_TOOL_COLOR,
  MCP_COLOR,
  PANEL_CLASS,
  PANEL_LABEL_CLASS,
  TRACK_COLOR,
} from './constants'
import { formatPercent, formatStatsDuration, formatTokens, formatToolName } from './format'
import { Segmented } from '../ui/Segmented'
import {
  LEADERBOARD_VISIBLE_ROWS,
  leaderboardBars,
  type LeaderboardBar,
  type LeaderboardTab as Tab,
} from './leaderboard'
import { Scroller } from './Scroller'
import { YouChip } from './WaitParts'

/**
 * TOOL LEADERBOARD (canvas 10a): the window's tools ranked by the time they
 * cost or by the result volume they poured into the context, with the MCP
 * ones badged.
 *
 * Bars are normalised to the leading row and the printed share is the honest
 * one — the two are not the same number, see `leaderboard.ts` and its ADR.
 * Four rows are shown (Ruling 16); the rest of the endpoint's ranking is a
 * scroll away, under the same fade the findings feed uses, so the panel keeps
 * the canvas's height.
 *
 * The canvas draws the `slowest` tab only. `most expensive` reuses its
 * columns, swapping the share and the TOTAL column over to result tokens —
 * the ranking the endpoint returns under that name.
 *
 * With the switch on, the waits on the user follow the ranked list as a YOU
 * group (10i): never ranked with the tools, no share bar, and only on the
 * slowest tab — they have time, not result tokens.
 */

const COLUMNS = 'grid-cols-[230px_1fr_78px_78px_72px]'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'slowest', label: 'slowest' },
  { id: 'mostExpensive', label: 'most expensive' },
]

export function ToolLeaderboard({
  leaderboard,
  totals,
  showWaits,
}: {
  leaderboard: StatsToolLeaderboard
  totals: StatsTotals
  showWaits: boolean
}) {
  const [tab, setTab] = useState<Tab>('slowest')
  const bars = leaderboardBars(
    tab === 'slowest' ? leaderboard.slowest : leaderboard.mostExpensive,
    tab,
    totals
  )

  return (
    <section aria-label="Tool leaderboard" className={`${PANEL_CLASS} flex flex-col px-5 pb-2.5 pt-4`}>
      <div className="flex items-baseline gap-[14px]">
        <div className={PANEL_LABEL_CLASS}>TOOL LEADERBOARD</div>
        <span className="flex-1" />
        <Segmented
          label="Rank tools by"
          size="tab"
          options={TABS.map((entry) => ({ value: entry.id, label: entry.label }))}
          value={tab}
          onChange={setTab}
        />
      </div>

      <div
        className={`mt-2.5 grid ${COLUMNS} items-center gap-x-[14px] border-b border-[rgba(150,205,255,.08)] pb-[7px] font-mono text-[9.5px] tracking-[0.14em] text-[rgba(160,190,225,.45)]`}
      >
        <span>TOOL</span>
        <span>{tab === 'slowest' ? 'SHARE OF TOOL TIME' : 'SHARE OF RESULT TOKENS'}</span>
        <span className="text-right">CALLS</span>
        <span className="text-right">p50</span>
        <span className="text-right">TOTAL</span>
      </div>

      {bars.length === 0 ? (
        <div className="pt-[9px] font-mono text-[11.5px] text-[rgba(160,190,225,.6)]">
          no tool calls in this window
        </div>
      ) : (
        <Scroller
          // The cap is a height, not a slice: every row the endpoint ranked
          // stays reachable by scrolling, and the row peeking under the fade
          // is what says so.
          style={{ maxHeight: LEADERBOARD_VISIBLE_ROWS * LEADERBOARD_ROW_PITCH }}
          className={`grid ${COLUMNS} items-center gap-x-[14px] gap-y-[9px] pt-[9px] font-mono text-[11.5px] text-text-bright`}
        >
          {bars.map((bar) => (
            <Row key={`${tab}-${bar.row.tool}`} bar={bar} tab={tab} />
          ))}
        </Scroller>
      )}

      {showWaits && tab === 'slowest' && leaderboard.human.length > 0 && (
        <div
          className={`mt-[9px] grid ${COLUMNS} items-center gap-x-[14px] gap-y-[5px] border-t border-dashed border-[rgba(160,190,225,.2)] pt-2 font-mono text-[11.5px] text-[rgba(200,220,245,.7)]`}
        >
          {leaderboard.human.map((row) => (
            <HumanRow
              key={row.tool}
              row={row}
              partial={totals.timedSessionCount < totals.sessionCount}
            />
          ))}
        </div>
      )}
    </section>
  )
}

const HUMAN_LABELS: Record<StatsHumanRow['tool'], { name: string; note: string }> = {
  AskUserQuestion: { name: 'AskUserQuestion', note: 'waiting on you · not tool time, not ranked' },
  ExitPlanMode: { name: 'ExitPlanMode', note: 'plan approval · not tool time, not ranked' },
  permission: { name: 'permission prompts', note: '' },
}

/**
 * One wait in the YOU group. The permission row says which tools were
 * prompted instead of what it is — and, in a range that also holds terminal
 * sessions, that its count covers the Orbital-run ones only (10e).
 */
function HumanRow({ row, partial }: { row: StatsHumanRow; partial: boolean }) {
  const label = HUMAN_LABELS[row.tool]
  const note =
    row.tool === 'permission'
      ? [
          ...(partial ? ['Orbital sessions only'] : []),
          ...Object.entries(row.byTool)
            .sort(([, a], [, b]) => b - a)
            .map(([tool, calls]) => `${formatToolName(tool)} ${calls}`),
        ].join(' · ')
      : label.note
  return (
    <>
      <span className="flex min-w-0 items-center gap-[7px]">
        <YouChip />
        <span className="truncate">{label.name}</span>
      </span>
      <span className="truncate text-[10px] text-[rgba(160,190,225,.5)]">{note}</span>
      <span className="text-right">{formatTokens(row.calls)}</span>
      <span className="text-right">{row.p50Ms === null ? '—' : formatStatsDuration(row.p50Ms)}</span>
      <span className="text-right">{formatStatsDuration(row.ms)}</span>
    </>
  )
}

function Row({ bar, tab }: { bar: LeaderboardBar; tab: Tab }) {
  const { row, width, share } = bar
  return (
    <>
      <span className="flex min-w-0 items-center gap-[7px]">
        {row.isMcp ? (
          <span className="rounded-[4px] border border-[rgba(255,187,123,.45)] px-[5px] py-px text-[8.5px] tracking-[0.1em] text-[#ffbb7b]">
            MCP
          </span>
        ) : (
          <span className="block w-[26px]" />
        )}
        <span className="truncate">{formatToolName(row.tool)}</span>
      </span>
      <span className="flex items-center gap-2.5">
        <span className="block h-[5px] flex-1 rounded-[3px]" style={{ background: TRACK_COLOR }}>
          <span
            className="block h-[5px] rounded-[3px]"
            style={{
              width: `${width * 100}%`,
              background: row.isMcp ? MCP_COLOR : LOCAL_TOOL_COLOR,
            }}
          />
        </span>
        {/* The bar ranks, this says how much — the heading names this number. */}
        <span className="w-[34px] shrink-0 text-right text-[10px] text-[rgba(160,190,225,.6)]">
          {formatPercent(share)}
        </span>
      </span>
      <span className="text-right text-[rgba(200,225,255,.75)]">{formatTokens(row.calls)}</span>
      <span className="text-right">{row.p50Ms === null ? '—' : formatStatsDuration(row.p50Ms)}</span>
      <span className="text-right">
        {tab === 'slowest'
          ? formatStatsDuration(row.ms)
          : formatTokens(row.resultChars / CHARS_PER_TOKEN)}
      </span>
    </>
  )
}
