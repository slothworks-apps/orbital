import type { PermissionMode } from '../lib/types'

export interface ModeCardsProps {
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
  disabled?: boolean
  /** Settings variant (canvas 1h): short copy, `bypass` short label, tighter card, no selection dot. */
  compact?: boolean
}

interface ModeDescriptor {
  value: PermissionMode
  label: string
  description: string
}

/** Mono raw-mode labels + one-line descriptions per artboard 1d — exact copy from the design canvas. */
const MODES: ModeDescriptor[] = [
  { value: 'plan', label: 'plan', description: 'Read-only. Proposes a plan before acting.' },
  {
    value: 'acceptEdits',
    label: 'acceptEdits',
    description: 'Edits files freely; asks before shell commands.',
  },
  {
    value: 'bypassPermissions',
    label: 'bypassPermissions',
    description: 'Never asks. Use in sandboxes only.',
  },
]

/** Settings variant per artboard 1h — same modes, shorter copy. */
const COMPACT_MODES: ModeDescriptor[] = [
  { value: 'plan', label: 'plan', description: 'Read-only, plans first' },
  { value: 'acceptEdits', label: 'acceptEdits', description: 'Edits freely, asks for shell' },
  { value: 'bypassPermissions', label: 'bypass', description: 'Never asks' },
]

/** Canvas 1d marks `bypassPermissions` with a warning-hued dot next to its label. */
const BYPASS_DOT = 'oklch(80% .13 60)'

/**
 * Selectable permission-mode cards, shared between `NewSessionDialog` and
 * `Settings` (both artboards 1d/1h show the same three cards) rather than
 * duplicated — per the task's "build it once" instruction.
 */
export function ModeCards({ value, onChange, disabled = false, compact = false }: ModeCardsProps) {
  const modes = compact ? COMPACT_MODES : MODES
  return (
    <div role="radiogroup" aria-label="Permission mode" className="grid w-full grid-cols-3 gap-2">
      {modes.map((mode) => {
        const active = value === mode.value
        return (
          <button
            key={mode.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={mode.label}
            data-active={active}
            disabled={disabled}
            onClick={() => onChange(mode.value)}
            className={[
              'relative min-w-0 text-left transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40',
              // 1h: 10px/12px on a 9px radius. 1d: 12px/14px on a 10px radius.
              compact ? 'rounded-[9px] border px-3 py-2.5' : 'rounded-[10px] border px-3.5 py-3',
              active
                ? compact
                  ? 'border-accent/70 bg-accent/8'
                  : 'border-accent/70 bg-accent/8 shadow-[0_0_20px_rgba(89,228,243,.15)]'
                : 'border-panel-border bg-[rgba(4,8,16,.4)] hover:bg-white/5',
            ].join(' ')}
          >
            {active && !compact && (
              // 7px accent dot with a glow, 10px inset from the corner (1d).
              <span
                aria-hidden
                className="absolute right-2.5 top-2.5 h-[7px] w-[7px] rounded-full bg-accent shadow-[0_0_8px_rgba(89,228,243,1)]"
              />
            )}
            <span
              className={[
                'flex items-center gap-1.5 font-mono text-text-bright',
                compact ? 'text-[11.5px]' : 'text-xs',
              ].join(' ')}
            >
              {mode.label}
              {!compact && mode.value === 'bypassPermissions' && (
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: BYPASS_DOT }}
                />
              )}
            </span>
            <span
              className={[
                'block leading-[1.4] [text-wrap:pretty]',
                compact ? 'mt-1 text-[11px]' : 'mt-[5px] text-[11.5px]',
                active && !compact ? 'text-[rgba(200,220,245,.85)]' : 'text-[rgba(160,190,225,.7)]',
              ].join(' ')}
            >
              {mode.description}
            </span>
          </button>
        )
      })}
    </div>
  )
}
