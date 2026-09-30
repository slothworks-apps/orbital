import { useState } from 'react'
import type { StatsDayBusy } from '../lib/types'
import {
  DAY_BAR_MAX_WIDTH,
  DAY_BAR_MIN_GAP,
  DAY_PLOT_HEIGHT,
  PANEL_CLASS,
  PANEL_LABEL_CLASS,
  TIME_CATEGORIES,
} from './constants'
import { formatStatsDuration } from './format'
import { WaitSwatch } from './WaitParts'

/**
 * BUSY TIME PER DAY (canvas 10a): one stacked column per day, API wait at the
 * base, hovering lifts the whole column and names the day's four durations.
 *
 * The scale has no fixed unit — the tallest day fills the plot and the single
 * guide sits at half of it, labelled with what that half is. A fixed "2h"
 * gridline would flatten a quiet week into nothing.
 */

/** Local `YYYY-MM-DD` to a local Date — `new Date(key)` would read it as UTC. */
function dayDate(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/**
 * Axis ticks: weekday initials while a week fits, day-of-month beyond that,
 * and only every nth label once they would collide.
 */
function tickLabel(key: string, index: number, count: number): string {
  if (count > 15 && index % Math.ceil(count / 10) !== 0) return ''
  const date = dayDate(key)
  if (count <= 7) {
    return date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()
  }
  return String(date.getDate())
}

function tooltipHeading(key: string): string {
  return dayDate(key)
    .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    .toUpperCase()
}

function DayTooltip({ day, flip, showWaits }: { day: StatsDayBusy; flip: boolean; showWaits: boolean }) {
  return (
    <div
      role="tooltip"
      style={flip ? { right: 56, bottom: 14 } : { left: 56, bottom: 14 }}
      className="absolute z-10 w-[196px] rounded-[10px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] px-3 py-2.5 shadow-[0_18px_44px_rgba(0,0,0,.6)]"
    >
      <div className="font-mono text-[10px] tracking-[0.14em] text-[rgba(160,190,225,.6)]">
        {tooltipHeading(day.day)}
      </div>
      <div className="mt-2 flex flex-col gap-[5px] font-mono text-[11px] text-text-bright">
        {TIME_CATEGORIES.map((category) => (
          <div key={category.field} className="flex items-center gap-2">
            <span className="block h-2 w-2 rounded-[2px]" style={{ background: category.color }} />
            {category.label}
            <span className="flex-1" />
            {formatStatsDuration(day[category.field])}
          </div>
        ))}
        <div className="mt-1 flex border-t border-[rgba(150,205,255,.12)] pt-1.5 text-[rgba(160,190,225,.8)]">
          busy
          <span className="flex-1" />
          {formatStatsDuration(day.busyMs)}
        </div>
        {/* Under busy, never in it: the columns stay work only (10i). */}
        {showWaits && (
          <div className="flex items-center gap-2 text-[rgba(160,190,225,.65)]">
            <WaitSwatch hatched />
            waiting on you
            <span className="flex-1" />
            {formatStatsDuration(day.humanWaitMs)}
          </div>
        )}
      </div>
    </div>
  )
}

export function BusyPerDayChart({ days, showWaits }: { days: StatsDayBusy[]; showWaits: boolean }) {
  const [hovered, setHovered] = useState<string | null>(null)

  const peak = days.reduce((max, day) => Math.max(max, day.busyMs), 0)
  const scale = peak > 0 ? DAY_PLOT_HEIGHT / peak : 0
  // A column never wider than the canvas's own, and narrow enough that the
  // widest window still keeps a gap between its days.
  const width = `min(${DAY_BAR_MAX_WIDTH}px, calc((100% - ${(days.length - 1) * DAY_BAR_MIN_GAP}px) / ${Math.max(1, days.length)}))`

  return (
    <section aria-label="Busy time per day" className={`${PANEL_CLASS} flex flex-col px-5 pb-3.5 pt-4`}>
      <div className="flex items-baseline gap-[14px]">
        <div className={PANEL_LABEL_CLASS}>BUSY TIME PER DAY</div>
        <span className="flex-1" />
        <div className="font-mono text-[10px] text-[rgba(160,190,225,.45)]">
          stacked · API wait at the base
        </div>
      </div>

      <div className="relative mt-3.5" style={{ height: DAY_PLOT_HEIGHT }}>
        <div className="absolute inset-x-0 bottom-0 h-px bg-[rgba(150,205,255,.18)]" />
        {peak > 0 && (
          <>
            <div
              className="absolute inset-x-0 h-px bg-[rgba(150,205,255,.07)]"
              style={{ bottom: DAY_PLOT_HEIGHT / 2 }}
            />
            <div
              className="absolute left-0 font-mono text-[9.5px] text-[rgba(160,190,225,.4)]"
              style={{ bottom: DAY_PLOT_HEIGHT / 2 + 3 }}
            >
              {formatStatsDuration(peak / 2)}
            </div>
          </>
        )}

        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between">
          {days.map((day, index) => {
            // Top-down, so the base of the stack is the last child — which is
            // what puts API wait on the axis (10a).
            const segments = [...TIME_CATEGORIES].reverse().map((category) => ({
              category,
              height: day[category.field] > 0 ? Math.max(1, Math.round(day[category.field] * scale)) : 0,
            }))
            const drawn = segments.filter((s) => s.height > 0)
            const first = drawn[0]?.category.field
            const last = drawn[drawn.length - 1]?.category.field
            const isHovered = hovered === day.day

            return (
              <div
                key={day.day}
                tabIndex={0}
                aria-label={`${tooltipHeading(day.day)}: busy ${formatStatsDuration(day.busyMs)}`}
                onMouseEnter={() => setHovered(day.day)}
                onMouseLeave={() => setHovered((h) => (h === day.day ? null : h))}
                onFocus={() => setHovered(day.day)}
                onBlur={() => setHovered((h) => (h === day.day ? null : h))}
                style={{
                  width,
                  // 10e: a 1px outline plus a 26px cyan glow, on the whole
                  // column rather than the segment under the cursor.
                  boxShadow: isHovered
                    ? '0 0 0 1px rgba(150,205,255,.3), 0 0 26px rgba(89,228,243,.18)'
                    : undefined,
                }}
                className="relative flex flex-col outline-none transition-[box-shadow] duration-[120ms] hover:duration-[80ms] focus-visible:duration-[80ms]"
              >
                {segments.map(({ category, height }) => (
                  <div
                    key={category.field}
                    style={{ height, background: category.color }}
                    className={[
                      category.field === first ? 'rounded-t-[2px]' : '',
                      category.field === last ? 'rounded-b-[2px]' : '',
                    ].join(' ')}
                  />
                ))}
                {isHovered && <DayTooltip day={day} flip={index > days.length - 3} showWaits={showWaits} />}
              </div>
            )
          })}
        </div>
      </div>

      <div className="mt-2 flex justify-between font-mono text-[10px] text-[rgba(160,190,225,.5)]">
        {days.map((day, index) => (
          <span
            key={day.day}
            style={{ width }}
            className={`text-center ${hovered === day.day ? 'text-text-soft' : ''}`}
          >
            {tickLabel(day.day, index, days.length)}
          </span>
        ))}
      </div>
    </section>
  )
}
