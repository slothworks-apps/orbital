import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react'
import { tagColor } from '../lib/types'

export interface ChipProps {
  label: string
  active?: boolean
  /** Hue (0-360). When given, the dot and border are tinted via tagColor(hue) — never via a state/hue swap. */
  hue?: number
  onClick?: () => void
  onRemove?: () => void
}

export function Chip({ label, active = false, hue, onClick, onRemove }: ChipProps) {
  const interactive = Boolean(onClick)
  const style: CSSProperties | undefined =
    hue !== undefined ? { borderColor: tagColor(hue), color: tagColor(hue) } : undefined

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (!interactive) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick?.()
    }
  }

  const handleRemove = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    onRemove?.()
  }

  return (
    <span
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      data-active={active}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      style={style}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-mono transition-colors',
        interactive ? 'cursor-pointer select-none' : '',
        active ? 'border-text-bright text-text-bright bg-white/10' : 'border-panel-border text-text-muted',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {hue !== undefined && (
        <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: tagColor(hue) }} />
      )}
      <span>{label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={handleRemove}
          className="ml-0.5 leading-none text-text-muted hover:text-text-bright"
        >
          ×
        </button>
      )}
    </span>
  )
}
