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
  /**
   * How an active chip with a hue shows it: `hue` tints border and fill
   * (canvas 1b, and 1d at .5/.12 for `size="field"`); `neutral` keeps the
   * accent-blue pressed look of a filter (canvas `Feature - Tag chips` 80a).
   */
  activeTint?: 'hue' | 'neutral'
  /** Muted ink and no dot: Clear and + New tag, the chips that are not tags (80e). */
  muted?: boolean
  /** The copy that follows the pointer while a chip is dragged: the dropdown panel colour and a shadow (80e). */
  lifted?: boolean
  /**
   * A field in place of the label — New Session's + New tag name field
   * (canvas 80c): the active chip around it, with an empty dot.
   */
  input?: ReactNode
  /** `field` is New Session's 26 px chip (canvas 80c): every chip in that row, the name field included. */
  size?: 'row' | 'field'
  /** Native tooltip — e.g. the full path behind a shortened label. */
  title?: string
  /** Gets the event, so a caller can read ⌘/ctrl from a click or a key press alike. */
  onClick?: (e: { metaKey: boolean; ctrlKey: boolean }) => void
  onRemove?: () => void
}

export function Chip({
  label, active = false, hue, dot = false, pulse = false, glyph, note, dimmed = false, activeTint = 'hue', muted = false,
  lifted = false, input, size = 'row', title, onClick, onRemove,
}: ChipProps) {
  const interactive = Boolean(onClick)
  const showDot = glyph === undefined && !muted && (hue !== undefined || dot || input !== undefined)
  // Canvas 1a/1b: resting chips are neutral (hue lives only in the dot);
  // an ACTIVE hued chip gets a hue-tinted border + faint hue fill.
  const field = size === 'field'
  const hueStyle: CSSProperties | undefined =
    active && hue !== undefined && activeTint === 'hue'
      ? {
          borderColor: `oklch(80% .13 ${hue} / ${field ? '.5' : '.4'})`,
          background: `oklch(80% .13 ${hue} / ${field ? '.12' : '.1'})`,
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
        'inline-flex items-center gap-1.5 rounded-full border font-semibold transition-colors',
        field ? 'box-border h-[26px] px-[11px] text-[11.5px]' : 'px-2.5 py-1 text-[11px]',
        interactive ? 'cursor-pointer select-none' : '',
        lifted
          ? 'whitespace-nowrap border-[rgba(150,205,255,.3)] bg-[rgba(10,16,28,.96)] text-text-bright shadow-[0_10px_24px_rgba(0,0,0,.5)]'
          : active
            ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
            : glyph !== undefined || muted
              ? 'border-panel-border text-[rgba(160,190,225,.6)]'
              : 'border-panel-border text-[rgba(220,235,255,.8)]',
        muted && interactive ? 'hover:border-[rgba(150,205,255,.3)] hover:text-text-bright' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {showDot &&
        (input !== undefined && hue === undefined ? (
          // 80c: the dot is empty until the tag it names exists.
          <span aria-hidden className="box-border block h-1.5 w-1.5 rounded-full border border-[rgba(160,190,225,.6)]" />
        ) : (
          <span
            aria-hidden
            className={['h-1.5 w-1.5 rounded-full', pulse ? 'orbital-pulse' : ''].filter(Boolean).join(' ')}
            style={{ background: hue !== undefined ? tagColor(hue) : 'currentColor' }}
          />
        ))}
      {glyph}
      {input ?? <span>{label}</span>}
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
