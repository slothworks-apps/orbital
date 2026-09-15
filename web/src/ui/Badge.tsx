import type { PermissionMode, SessionStatus } from '../lib/types'

export type BadgeProps =
  | { variant: 'status'; value: SessionStatus }
  | { variant: 'mode'; value: PermissionMode }
  | { variant: 'count'; value: number; label?: string }

const statusLabel: Record<SessionStatus, string> = {
  working: 'WORKING',
  needs_input: 'NEEDS INPUT',
  idle: 'IDLE',
  ended: 'ENDED',
}

const modeLabel: Record<PermissionMode, string> = {
  plan: 'PLAN',
  acceptEdits: 'ACCEPT EDITS',
  bypassPermissions: 'BYPASS PERMISSIONS',
}

const baseClass =
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-mono tracking-wide'

export function Badge(props: BadgeProps) {
  if (props.variant === 'status') {
    const { value } = props
    const stateClass =
      value === 'needs_input'
        ? 'border-white text-white bg-white/10'
        : value === 'ended'
          ? 'border-panel-border text-text-muted opacity-60'
          : 'border-panel-border text-text-soft'

    return (
      <span data-variant="status" data-status={value} className={`${baseClass} ${stateClass}`}>
        {value === 'working' && (
          <span aria-hidden className="orbital-pulse h-1.5 w-1.5 rounded-full bg-text-soft" />
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
        className={`${baseClass} border-panel-border text-text-soft`}
      >
        {modeLabel[props.value]}
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
