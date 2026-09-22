import { useId } from 'react'
import type { StatsCacheRatioDay } from '../lib/types'
import { CACHE_PLOT_HEIGHT, CACHE_TARGET_RATIO, PANEL_CLASS, PANEL_LABEL_CLASS } from './constants'
import { formatPercent, formatPoints } from './format'

/**
 * CACHE HIT RATIO (canvas 10a): the window's trend against the ≥80% target
 * guide. Plain SVG over a 0–100% domain, which is what puts the guide exactly
 * where the canvas draws it.
 *
 * Days the endpoint reports as null (nothing priced that day) are dropped
 * rather than drawn as zero — a day with no input has no ratio, and a dip to
 * the floor would read as a cache that collapsed.
 */

/** The `viewBox` width; the path is stretched to the panel by `preserveAspectRatio`. */
const PLOT_WIDTH = 840

function shortDay(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    .toUpperCase()
}

export function CacheRatioChart({
  series,
  ratio,
}: {
  series: StatsCacheRatioDay[]
  /** The window's own ratio — the headline number, not the last point. */
  ratio: number | null
}) {
  // `useId` puts colons in its value, which `url(#…)` cannot carry reliably.
  const gradientId = `cache-fill-${useId().replace(/:/g, '')}`
  const points = series.filter(
    (point): point is { day: string; ratio: number } => point.ratio !== null
  )

  const x = (index: number) =>
    points.length < 2 ? PLOT_WIDTH / 2 : (index / (points.length - 1)) * PLOT_WIDTH
  const y = (value: number) => (1 - value) * CACHE_PLOT_HEIGHT
  const coordinates = points.map((point, index) => `${x(index)},${y(point.ratio)}`).join(' ')

  const first = points[0]
  const last = points[points.length - 1]
  const trend = first && last && first !== last ? last.ratio - first.ratio : null

  return (
    <section aria-label="Cache hit ratio" className={`${PANEL_CLASS} flex flex-col px-5 pb-3 pt-4`}>
      <div className="flex items-baseline gap-[14px]">
        <div className={PANEL_LABEL_CLASS}>CACHE HIT RATIO</div>
        <div className="font-mono text-[15px] text-text-bright">
          {ratio === null ? '—' : formatPercent(ratio)}
        </div>
        {trend !== null && (
          // Amber for a ratio that fell over the window (10a); a rise is left
          // in the panel's own ink.
          <div className={`font-mono text-[10.5px] ${trend < 0 ? 'text-[#ffbb7b]' : 'text-[rgba(160,190,225,.7)]'}`}>
            {formatPoints(trend)} this window
          </div>
        )}
        <span className="flex-1" />
        <div className="font-mono text-[10px] text-[rgba(160,190,225,.45)]">
          cached input ÷ total input · target ≥ {formatPercent(CACHE_TARGET_RATIO)}
        </div>
      </div>

      <div className="relative mt-2.5" style={{ height: CACHE_PLOT_HEIGHT }}>
        <div
          className="absolute inset-x-0 h-px bg-[rgba(150,205,255,.07)]"
          style={{ top: y(CACHE_TARGET_RATIO) }}
        />
        <div
          className="absolute right-0 font-mono text-[9.5px] text-[rgba(160,190,225,.4)]"
          style={{ top: Math.max(0, y(CACHE_TARGET_RATIO) - 8) }}
        >
          {formatPercent(CACHE_TARGET_RATIO)}
        </div>
        <div className="absolute inset-x-0 bottom-0 h-px bg-[rgba(150,205,255,.18)]" />

        {points.length > 0 && (
          <svg
            aria-hidden
            viewBox={`0 0 ${PLOT_WIDTH} ${CACHE_PLOT_HEIGHT}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#59e4f3" stopOpacity=".22" />
                <stop offset="100%" stopColor="#59e4f3" stopOpacity="0" />
              </linearGradient>
            </defs>
            {points.length > 1 && (
              <>
                <path
                  d={`M${coordinates.split(' ').join(' L')} L${PLOT_WIDTH},${CACHE_PLOT_HEIGHT} L0,${CACHE_PLOT_HEIGHT} Z`}
                  fill={`url(#${gradientId})`}
                />
                <polyline
                  points={coordinates}
                  fill="none"
                  stroke="#59e4f3"
                  strokeWidth="1.5"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
            {points.length === 1 && (
              <circle cx={x(0)} cy={y(points[0].ratio)} r="2" fill="#59e4f3" />
            )}
          </svg>
        )}

        <div className="absolute inset-x-0 -bottom-0.5 flex justify-between font-mono text-[10px] text-[rgba(160,190,225,.45)]">
          <span>{first ? `${shortDay(first.day)} · ${formatPercent(first.ratio)}` : ''}</span>
          <span>
            {last && last !== first ? `${shortDay(last.day)} · ${formatPercent(last.ratio)}` : ''}
          </span>
        </div>
      </div>
    </section>
  )
}
