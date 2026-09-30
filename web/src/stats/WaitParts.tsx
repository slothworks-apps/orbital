import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { WAIT_HATCH, WAIT_OUTLINE } from './constants'
import { formatStatsDuration } from './format'
import { STATS_SHOW_HUMAN_WAIT_KEY, showHumanWait } from './humanWait'

/**
 * The pieces every stats surface draws for time spent waiting on the user
 * (canvas 10i–10k). Shared so the dashboard, the drilldown and the quick
 * dialog cannot drift apart on what a wait looks like.
 */

/**
 * The switch's state on `/stats`, read from and written to the server setting.
 * Off until the setting has loaded — the default, so nothing flips on screen
 * for anyone who never turned it on. A failed write puts the switch back.
 */
export function useShowHumanWait(): [boolean, (next: boolean) => void] {
  const [on, setOn] = useState(false)

  useEffect(() => {
    let live = true
    api.getSettings().then(
      (settings) => {
        if (live) setOn(showHumanWait(settings))
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [])

  const set = useCallback((next: boolean) => {
    setOn(next)
    api
      .patchSettings({ [STATS_SHOW_HUMAN_WAIT_KEY]: next ? 'true' : 'false' })
      .catch(() => setOn(!next))
  }, [])

  return [on, set]
}

/**
 * 10k's swatch: hatched where the time is shown, a dashed outline where only
 * the count is.
 */
export function WaitSwatch({ hatched, size = 8 }: { hatched: boolean; size?: number }) {
  return (
    <span
      aria-hidden
      className="block shrink-0 rounded-[2px] box-border"
      style={{
        width: size,
        height: size,
        border: `1px ${hatched ? 'solid' : 'dashed'} ${WAIT_OUTLINE}`,
        background: hatched ? WAIT_HATCH : undefined,
      }}
    />
  )
}

/** "Show time spent waiting on you" — the right end of the `/stats` filter row (10i, 10k). */
export function WaitSwitch({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={[
        'flex cursor-pointer items-center gap-2.5 rounded-lg border py-1.5 pl-3 pr-2.5 font-mono text-[11.5px]',
        on
          ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
          : 'border-[rgba(150,205,255,.14)] text-[rgba(220,235,255,.8)]',
      ].join(' ')}
    >
      Show time spent waiting on you
      <span
        aria-hidden
        className="relative box-border block h-4 w-7 rounded-full border"
        style={
          on
            ? { borderColor: 'oklch(85% .12 205 / .6)', background: 'oklch(85% .12 205 / .3)' }
            : { borderColor: 'rgba(150,205,255,.25)' }
        }
      >
        <span
          className="absolute top-0.5 block h-2.5 w-2.5 rounded-full"
          style={
            on
              ? { right: 2, background: 'oklch(85% .12 205)' }
              : { left: 2, background: 'rgba(160,190,225,.6)' }
          }
        />
      </span>
    </button>
  )
}

/**
 * WAITING ON YOU — the tile in the slot beside the busy split, in both states
 * (10k): the count alone, or the time with the count under it. Never the
 * panel gradient: a dashed outline on a darker fill says "not work".
 *
 * `dashboard` is 10i's 162px tile, `drilldown` 10j's narrower 138px one.
 */
export function WaitTile({
  variant,
  timeShown,
  ms,
  countLine,
  footnote,
}: {
  variant: 'dashboard' | 'drilldown'
  timeShown: boolean
  ms: number
  countLine: string
  /** "* Orbital sessions only", in a range where the permission count is partial. */
  footnote?: string
}) {
  const dashboard = variant === 'dashboard'
  return (
    <section
      aria-label="Waiting on you"
      style={{ flex: `${dashboard ? 162 : 138} 1 0` }}
      className={[
        'box-border min-w-0 rounded-[14px] border border-dashed border-[rgba(160,190,225,.28)] bg-[rgba(4,8,16,.35)] py-3.5',
        dashboard ? 'px-4' : 'px-3.5',
      ].join(' ')}
    >
      <div
        className={[
          'flex items-center font-mono text-[rgba(160,190,225,.6)]',
          dashboard
            ? 'gap-[7px] text-[10px] tracking-[0.18em]'
            : 'gap-1.5 whitespace-nowrap text-[9.5px] tracking-[0.04em]',
        ].join(' ')}
      >
        <WaitSwatch hatched={timeShown} />
        WAITING ON YOU
      </div>
      {timeShown ? (
        <>
          <div
            className={`mt-2 font-mono leading-none tracking-[-0.02em] text-[rgba(200,220,245,.8)] ${
              dashboard ? 'text-[24px]' : 'text-[22px]'
            }`}
          >
            {formatStatsDuration(ms)}
          </div>
          <div className="mt-1.5 font-mono text-[10px] leading-[1.35] text-[rgba(160,190,225,.7)]">
            <CountLine line={countLine} starred={footnote !== undefined} />
          </div>
        </>
      ) : (
        <div
          className={`font-mono leading-[1.5] text-[rgba(200,220,245,.85)] ${
            dashboard ? 'mt-3 text-[13px]' : 'mt-2.5 text-[12px]'
          }`}
        >
          <CountLine line={countLine} starred={footnote !== undefined} />
        </div>
      )}
      {footnote !== undefined && (
        <div className="mt-[3px] font-mono text-[9px] text-[rgba(160,190,225,.45)]">* {footnote}</div>
      )}
    </section>
  )
}

/**
 * The count line, allowed to wrap only between its parts: a tile this narrow
 * would otherwise break "· 3⏎plan approvals" and part a number from its noun.
 */
function CountLine({ line, starred }: { line: string; starred: boolean }) {
  const parts = line.split(' · ')
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          <span className="whitespace-nowrap">
            {part}
            {starred && i === parts.length - 1 && '*'}
          </span>
        </span>
      ))}
    </>
  )
}

/** The YOU chip of the leaderboard's wait group: dashed and neutral, never a category hue (10e). */
export function YouChip() {
  return (
    <span className="rounded-[4px] border border-dashed border-[rgba(160,190,225,.45)] px-[5px] py-px text-[8.5px] tracking-[0.1em] text-[rgba(200,220,245,.8)]">
      YOU
    </span>
  )
}

/** Two slashes and a dashed hairline — the break a wait cuts into a lane, at legend size (10j). */
export function BreakGlyph() {
  return (
    <span aria-hidden className="flex items-center gap-[3px]">
      <span className="block h-[9px] w-px rotate-[20deg] bg-[rgba(160,190,225,.6)]" />
      <span className="block w-2 border-t border-dashed border-[rgba(160,190,225,.6)]" />
      <span className="block h-[9px] w-px rotate-[20deg] bg-[rgba(160,190,225,.6)]" />
    </span>
  )
}
