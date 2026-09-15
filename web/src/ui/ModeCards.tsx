import type { PermissionMode } from '../lib/types'

export interface ModeCardsProps {
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
  disabled?: boolean
  /** Settings variant (canvas 1h): short copy, `bypass` short label, accent-filled active state, no dot. */
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

/**
 * Selectable permission-mode cards, shared between `NewSessionDialog` and
 * `Settings` (both artboards 1d/1h show the same three cards) rather than
 * duplicated — per the task's "build it once" instruction.
 */
export function ModeCards({ value, onChange, disabled = false, compact = false }: ModeCardsProps) {
  const modes = compact ? COMPACT_MODES : MODES
  return (
    <div role="radiogroup" aria-label="Permission mode" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
              'relative flex flex-col gap-1 text-left transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40',
              compact ? 'rounded-[9px] border px-3 py-2.5' : 'rounded-md border px-3 py-2 text-sm',
              active
                ? compact
                  ? 'border-accent/70 bg-accent/10 text-text-bright'
                  : 'border-accent/60 bg-accent/5 text-text-bright'
                : compact
                  ? 'border-panel-border bg-[rgba(4,8,16,.4)] text-text-soft hover:bg-white/5'
                  : 'border-panel-border text-text-soft hover:bg-white/5',
            ].join(' ')}
          >
            {active && !compact && (
              <span aria-hidden className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-accent" />
            )}
            <span className={compact ? 'font-mono text-[11.5px] text-text-bright' : 'font-mono text-xs font-semibold tracking-wide'}>
              {mode.label}
            </span>
            <span className="text-[11px] leading-snug text-text-muted">{mode.description}</span>
          </button>
        )
      })}
    </div>
  )
}
