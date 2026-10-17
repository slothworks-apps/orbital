import type { CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { tagColor } from '../lib/types'

export interface ChipProps {
  label: string
  active?: boolean
  /** Hue (0-360). When given, the dot and border are tinted via tagColor(hue) — never via a state/hue swap. */
  hue?: number
  /** Renders a leading dot without hue tinting (neutral, `currentColor`) — for non-tag indicators (e.g. a subagent's live state) that have no hue of their own. Implied when `hue` is set. */
  dot?: boolean
  /** Animates the dot with the shared pulse treatment (e.g. a subagent still working). Only visible when a dot is actually rendered (`hue` or `dot`). */
  pulse?: boolean
  /**
   * A leading glyph in place of a dot (a device chip's `KindGlyph`, canvas
   * 50e: glyph first, so it reads apart from a tag chip without a label). A
   * glyph chip is a toggle: it carries `aria-pressed`, and rests in the muted
   * ink of the canvas's `chip(off)` rather than a tag chip's.
   */
  glyph?: ReactNode
  /** A quiet mono word after the label — a device chip's `update` (canvas 50e). */
  note?: string
  /** Half opacity: a device that is offline (canvas 50e). */
  dimmed?: boolean
  /** Native tooltip — e.g. the full path behind a shortened label. */
  title?: string
  /** Gets the event, so a caller can read ⌘/ctrl from a click or a key press alike. */
  onClick?: (e: { metaKey: boolean; ctrlKey: boolean }) => void
  onRemove?: () => void
}

export function Chip({
  label, active = false, hue, dot = false, pulse = false, glyph, note, dimmed = false, title, onClick, onRemove,
}: ChipProps) {
  const interactive = Boolean(onClick)
  const showDot = glyph === undefined && (hue !== undefined || dot)
  // Canvas 1a/1b: resting chips are neutral (hue lives only in the dot);
  // an ACTIVE hued chip gets a hue-tinted border + faint hue fill.
  const hueStyle: CSSProperties | undefined =
    active && hue !== undefined
      ? {
          borderColor: `oklch(80% .13 ${hue} / .4)`,
          background: `oklch(80% .13 ${hue} / .1)`,
          color: '#e8eef8',
        }
      : undefined
  const style = dimmed ? { ...hueStyle, opacity: 0.5 } : hueStyle

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (!interactive) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick?.(e)
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
      aria-pressed={glyph !== undefined && interactive ? active : undefined}
      data-active={active}
      title={title}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      style={style}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
        interactive ? 'cursor-pointer select-none' : '',
        active
          ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
          : glyph !== undefined
            ? 'border-panel-border text-[rgba(160,190,225,.6)]'
            : 'border-panel-border text-[rgba(220,235,255,.8)]',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {showDot && (
        <span
          aria-hidden
          className={['h-1.5 w-1.5 rounded-full', pulse ? 'orbital-pulse' : ''].filter(Boolean).join(' ')}
          style={{ background: hue !== undefined ? tagColor(hue) : 'currentColor' }}
        />
      )}
      {glyph}
      <span>{label}</span>
      {note && (
        <span className="font-mono text-[9.5px] font-normal tracking-[0.06em] text-[rgba(160,190,225,.75)]">
          {note}
        </span>
      )}
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
