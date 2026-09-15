import type { CSSProperties } from 'react'
import { tagColor } from '../lib/types'
import type { PermissionMode, SessionStatus } from '../lib/types'

export type BadgeProps =
  | { variant: 'status'; value: SessionStatus; /** Tag hue tinting a working badge (canvas 1b). */ hue?: number }
  | { variant: 'mode'; value: PermissionMode }
  | { variant: 'count'; value: number; label?: string }

const statusLabel: Record<SessionStatus, string> = {
  working: 'WORKING',
  needs_input: 'NEEDS INPUT',
  idle: 'IDLE',
  ended: 'ENDED',
}

// Canvas 1b: squared-off mono chips (radius 5px), quiet dark fill for the
// permission mode, hue-tinted border + blinking dot while working.
const baseClass =
  'inline-flex items-center gap-1.5 rounded-[5px] border px-2 py-0.5 font-mono text-[10.5px] tracking-[0.04em]'

export function Badge(props: BadgeProps) {
  if (props.variant === 'status') {
    const { value, hue } = props
    const busy = value === 'working' || value === 'needs_input'
    const tint = busy && hue !== undefined ? tagColor(hue) : undefined
    const style: CSSProperties | undefined = tint
      ? { borderColor: tint, color: tint, letterSpacing: '0.08em' }
      : undefined
    const stateClass =
      value === 'needs_input' && !tint
        ? 'border-white text-white bg-white/10'
        : value === 'ended'
          ? 'border-panel-border text-text-muted opacity-60'
          : busy
            ? 'border-panel-border text-text-soft'
            : 'border-panel-border text-text-muted'

    return (
      <span data-variant="status" data-status={value} style={style} className={`${baseClass} ${tint ? '' : stateClass}`}>
        {busy && (
          <span
            aria-hidden
            className="orbital-pulse h-1.5 w-1.5 rounded-full"
            style={{ background: tint ?? 'currentColor', boxShadow: tint ? `0 0 8px ${tint}` : undefined }}
          />
        )}
        {statusLabel[value]}
      </span>
    )
  }

  if (props.variant === 'mode') {
    return (
      <span
        data-variant="mode"
        data-mode={props.value}
        className={`${baseClass} border-[rgba(150,205,255,.2)] bg-[rgba(4,8,16,.5)] text-[rgba(220,235,255,.85)]`}
      >
        {props.value}
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
