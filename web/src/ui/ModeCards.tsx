import { PERMISSION_MODES } from '../lib/permissionModes'
import type { PermissionMode } from '../lib/types'
import { ModeDot } from './ModeDot'

export interface ModeCardsProps {
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
  disabled?: boolean
  /** Settings variant (canvas 2f): short copy, `bypass` short label, tighter card, no selection pip. */
  compact?: boolean
}

/**
 * Selectable permission-mode cards, shared between `NewSessionDialog` and
 * `Settings` (artboards 2d and 2f show the same four cards) rather than
 * duplicated.
 *
 * The grid is 2×2 in both variants. Four cards in one row would give the
 * settings column 80px per card; two rows of two is what the canvas draws.
 *
 * Copy, order and dot colours come from `lib/permissionModes.ts` — the header
 * readout needs the same strings for its tooltip, and a second copy is how a
 * picker and a readout end up disagreeing about what `auto` does.
 */
export function ModeCards({ value, onChange, disabled = false, compact = false }: ModeCardsProps) {
  return (
    <div role="radiogroup" aria-label="Permission mode" className="grid w-full grid-cols-2 gap-2">
      {PERMISSION_MODES.map((mode) => {
        const active = value === mode.value
        const label = compact ? mode.shortLabel : mode.label
        return (
          <button
            key={mode.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            data-active={active}
            data-mode={mode.value}
            disabled={disabled}
            onClick={() => onChange(mode.value)}
            className={[
              'relative min-w-0 text-left transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40',
              // 2f: 10px/12px on a 9px radius. 2d: 12px/14px on a 10px radius.
              compact ? 'rounded-[9px] border px-3 py-2.5' : 'rounded-[10px] border px-3.5 py-3',
              active
                ? compact
                  ? 'border-accent/70 bg-accent/8'
                  : 'border-accent/70 bg-accent/8 shadow-[0_0_20px_rgba(89,228,243,.15)]'
                : 'border-panel-border bg-[rgba(4,8,16,.4)] hover:bg-white/5',
            ].join(' ')}
          >
            {active && !compact && (
              // 7px accent pip with a glow, 10px inset from the corner (2d).
              // Selection is border + fill + pip: three channels, none of them
              // the mode dot, so the choice survives colour blindness.
              <span
                aria-hidden
                className="absolute right-2.5 top-2.5 h-[7px] w-[7px] rounded-full bg-accent shadow-[0_0_8px_rgba(89,228,243,1)]"
              />
            )}
            <span
              className={[
                'flex items-center font-mono text-text-bright',
                compact ? 'gap-[7px] text-[11.5px]' : 'gap-2 text-xs',
              ].join(' ')}
            >
              <ModeDot mode={mode.value} />
              {label}
            </span>
            <span
              className={[
                'block leading-[1.4] [text-wrap:pretty]',
                compact ? 'mt-1 text-[11px]' : 'mt-[5px] text-[11.5px]',
                active && !compact ? 'text-[rgba(200,220,245,.85)]' : 'text-[rgba(160,190,225,.7)]',
              ].join(' ')}
            >
              {compact ? mode.shortDescription : mode.description}
            </span>
          </button>
        )
      })}
    </div>
  )
}
