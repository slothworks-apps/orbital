import type { SessionStatus } from '../lib/types'
import { tagColor } from '../lib/types'

export interface StatusDotProps {
  status: SessionStatus
  /** Tag hue for the dot's base color. Status is expressed via motion/accents only, never by changing this hue. */
  hue?: number
}

const neutral = 'rgb(160 190 225 / 0.7)'

export function StatusDot({ status, hue }: StatusDotProps) {
  const baseColor = hue !== undefined ? tagColor(hue) : neutral

  return (
    <span
      data-status={status}
      className={[
        'relative inline-flex h-2.5 w-2.5 rounded-full',
        status === 'ended' ? 'opacity-40 ring-1 ring-inset ring-text-muted' : '',
        status === 'working' ? 'orbital-pulse' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        background: status === 'ended' ? 'transparent' : baseColor,
        borderColor: status === 'ended' ? baseColor : undefined,
      }}
    >
      {status === 'needs_input' && (
        <span aria-hidden className="orbital-pulse absolute -inset-[3px] rounded-full border border-white" />
      )}
    </span>
  )
}
