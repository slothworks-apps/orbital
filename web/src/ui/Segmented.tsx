import type { ReactNode } from 'react'

/**
 * Which of the segmented control's three sizes this is.
 *
 * Named for where it is used rather than S/M/L, because the three do not
 * order: `row` has the largest type and the tightest horizontal padding,
 * `filter` the reverse. They are three separate canvas measurements, not
 * three steps of one scale, so a t-shirt name would be a lie the next person
 * has to discover.
 */
export type SegmentedSize = 'tab' | 'filter' | 'row'

const SIZES = {
  /** canvas 10a — tabs inside a panel heading (the tool leaderboard's). */
  tab: { shell: 'rounded-[7px]', item: 'px-[11px] py-[5px] text-[10.5px]' },
  /** canvas 10a — the stats filter bar. */
  filter: { shell: 'rounded-lg', item: 'px-3.5 py-[7px] text-[11.5px]' },
  /** canvas 1h — a control in the settings dialog's 320px column. */
  row: { shell: 'rounded-lg', item: 'px-3 py-[7px] text-xs' },
} as const satisfies Record<SegmentedSize, unknown>

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  /**
   * What assistive tech announces, when `label` is a glyph rather than a
   * word. Defaults to the label.
   */
  ariaLabel?: string
}

export interface SegmentedProps<T extends string> {
  /** Names the group. Required: a bare row of buttons is not a control. */
  label: string
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  size?: SegmentedSize
  /**
   * Floor for each segment's width, in px. For a stepper whose labels are
   * single characters, where the segments would otherwise be as ragged as
   * the glyphs in them.
   */
  minItemWidth?: number
  /** Layout only, per web/CLAUDE.md — the chrome is this component's. */
  className?: string
}

/**
 * One choice out of a few, all of them visible at once (canvas 1h's steppers,
 * 10a's window filter and panel tabs).
 *
 * It is `aria-pressed` buttons inside a `role="group"` rather than a radio
 * group: that is the shape all three of the hand-rolled copies this replaces
 * already had, and it is the one that matches what the control looks like —
 * a row of toggles where exactly one is down.
 *
 * `Select` remains the answer whenever the options do not all fit on the
 * line, or there are more than a handful of them.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 'row',
  minItemWidth,
  className,
}: SegmentedProps<T>) {
  const s = SIZES[size]
  return (
    <div
      role="group"
      aria-label={label}
      className={[
        'inline-flex overflow-hidden border border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.5)]',
        s.shell,
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {options.map((option, index) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            aria-label={option.ariaLabel}
            onClick={() => onChange(option.value)}
            className={[
              'cursor-pointer text-center font-mono transition-colors',
              s.item,
              // The divider belongs to the segment on its right, so the
              // shell's own border is never doubled at either end.
              index > 0 ? 'border-l border-[rgba(150,205,255,.12)]' : '',
              // Selection is a tint, an ink and a weight — three channels, so
              // it survives both colour blindness and the neutral hover
              // underneath it. NOT the accent as a fill: 1h and 10a draw this
              // one filled, which made it the single loudest selected state in
              // the app while every other control that picks one of a few
              // (ModeCards, ModelCards, Select's rows) tints. See the ADR.
              active
                ? 'bg-accent/10 font-semibold text-accent'
                : 'bg-transparent text-[rgba(220,235,255,.85)] hover:bg-white/5',
            ]
              .filter(Boolean)
              .join(' ')}
            style={minItemWidth ? { minWidth: `${minItemWidth}px` } : undefined}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
