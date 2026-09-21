import type { CSSProperties } from 'react'
import { tagColor } from '../lib/types'
import type { SessionStatus } from '../lib/types'

export type BadgeProps =
  | {
      variant: 'status'
      value: SessionStatus
      /** Tag hue tinting a working badge (canvas 1b). */
      hue?: number
      /**
       * A server restart cut this session's turn short (spec
       * 2026-09-21-session-autoheal-design). A modifier rather than a status
       * of its own: the session really is waiting for input, and this says
       * why. It reads `INTERRUPTED`, keeps the needs-input chip's treatment,
       * and drops the blinking dot — nothing is happening; something stopped.
       */
      interrupted?: boolean
    }
  | { variant: 'count'; value: number; label?: string }
  | { variant: 'model'; value: string; /** Accent outline + focus ring, for the chip that opens the switcher. */ interactive?: boolean }

const statusLabel: Record<SessionStatus, string> = {
  working: 'WORKING',
  needs_input: 'NEEDS INPUT',
  idle: 'IDLE',
  ended: 'ENDED',
}

// Canvas 1b: squared-off mono chips (radius 5px), quiet dark fill, hue-tinted
// border + blinking dot while working.
const baseClass =
  'inline-flex items-center gap-1.5 rounded-[5px] border px-[9px] py-1 font-mono text-[10.5px] tracking-[0.04em]'

export function Badge(props: BadgeProps) {
  if (props.variant === 'status') {
    const { value, hue, interrupted } = props
    const busy = value === 'working' || value === 'needs_input'
    // The interrupted chip keeps needs-input's white treatment (which is what
    // `tint === undefined` selects below), so the hue tint is dropped along
    // with the dot.
    const tint = busy && !interrupted && hue !== undefined ? tagColor(hue) : undefined
    // 1b tints only the BORDER with the session's tag hue, at 40% — the label
    // itself stays the fixed accent, so the badge reads as one family across
    // tags rather than restating the hue twice.
    const style: CSSProperties | undefined =
      tint && hue !== undefined
        ? {
            borderColor: `oklch(80% 0.13 ${hue} / 0.4)`,
            color: 'var(--color-accent)',
            letterSpacing: '0.08em',
          }
        : undefined
    const stateClass =
      interrupted || (value === 'needs_input' && !tint)
        ? 'border-white text-white bg-white/10'
        : value === 'ended'
          ? 'border-panel-border text-text-muted opacity-60'
          : busy
            ? 'border-panel-border text-text-soft'
            : 'border-panel-border text-text-muted'

    return (
      <span
        data-variant="status"
        data-status={interrupted ? 'interrupted' : value}
        style={style}
        className={`${baseClass} ${tint ? '' : stateClass}`}
      >
        {busy && !interrupted && (
          <span
            aria-hidden
            className="orbital-pulse h-1.5 w-1.5 rounded-full"
            style={{ background: tint ?? 'currentColor', boxShadow: tint ? `0 0 8px ${tint}` : undefined }}
          />
        )}
        {interrupted ? 'INTERRUPTED' : statusLabel[value]}
      </span>
    )
  }

  if (props.variant === 'model') {
    // Canvas 4a: the same squared mono chip as the status badge beside it,
    // accent-outlined while it is a control you can open. The `▾` is drawn here (not by the
    // caller) so it can carry its own muted, smaller-than-the-label style and
    // only ever shows up on the interactive (switcher) chip.
    return (
      <span
        data-variant="model"
        className={`${baseClass} ${
          props.interactive
            ? 'border-accent/60 bg-accent/8 text-text-bright shadow-[0_0_0_3px_rgba(89,228,243,.1)]'
            : // The canvas's quiet-chip literal — `border-panel-border` is
              // `.14`, not `.2`, so the token can't stand in for it without
              // the chip reading a shade fainter than the artboard.
              'border-[rgba(150,205,255,.2)] bg-[rgba(4,8,16,.5)] text-[rgba(220,235,255,.85)]'
        }`}
      >
        {props.value}
        {props.interactive && (
          <span aria-hidden className="ml-[7px] text-[9px] text-[rgba(160,190,225,.6)]">
            ▾
          </span>
        )}
      </span>
    )
  }

  return (
    <span data-variant="count" className={`${baseClass} border-panel-border text-text-soft`}>
      {props.value}
      {props.label ? ` ${props.label}` : ''}
    </span>
  )
}
