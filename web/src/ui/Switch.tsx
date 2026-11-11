import { swatch } from '../lib/palette'

/*
 * The harness's switches (canvas 30b), New session's Feeling lucky (65a) and
 * its progress list row (67f): a `role="switch"` button, for rows that lay
 * out their own words. `Toggle` (`./Checkbox`) is the settings' switch, a
 * checkbox underneath with its label beside it.
 */

/**
 * The switch's track and knob, drawn only: `sm` is canvas 30b's 26 × 14 with
 * a 10 px knob; `md` is New session's Feeling lucky row (65a), 32 × 18 with a
 * 14 px knob and a glow while on. The caller owns the role and the click.
 */
export function SwitchTrack({ on, size = 'sm' }: { on: boolean; size?: 'sm' | 'md' }) {
  const md = size === 'md'
  return (
    <span
      aria-hidden
      className={[
        'relative block shrink-0',
        // 65a eases the track's colour along with the knob; 30b only moves the knob.
        md ? 'h-[18px] w-8 rounded-[9px] transition-[background-color,box-shadow] duration-150 ease-out' : 'h-[14px] w-[26px] rounded-[7px]',
      ].join(' ')}
      style={{
        background: on ? swatch('accent') : swatch('line', 0.16),
        boxShadow: md && on ? `0 0 10px ${swatch('accent', 0.5)}` : undefined,
      }}
    >
      <span
        className={[
          'absolute top-[2px] block rounded-full transition-[left] duration-150 ease-out',
          md ? 'size-[14px]' : 'size-[10px]',
        ].join(' ')}
        style={{ left: on ? (md ? 16 : 14) : 2, background: on ? swatch('space-deep') : swatch('ink-500', 0.7) }}
      />
    </span>
  )
}

/** Canvas 30b's switch: 26 × 14, a 10 px knob; acts at once, never confirmed (30f). */
export function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 fs-12 text-ink-200/88">
      <SwitchButton on={on} label={label} onChange={onChange} />
      {label}
    </label>
  )
}

/** The switch itself, for a row that lays out its own words (New session's progress list, canvas 67f). */
export function SwitchButton({
  on,
  label,
  onChange,
  className = '',
}: {
  on: boolean
  label: string
  onChange: (on: boolean) => void
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`block shrink-0 ${className}`}
    >
      <SwitchTrack on={on} />
    </button>
  )
}
