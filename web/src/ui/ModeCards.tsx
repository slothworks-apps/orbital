import type { PermissionMode } from '../lib/types'

export interface ModeCardsProps {
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
  disabled?: boolean
}

interface ModeDescriptor {
  value: PermissionMode
  label: string
  description: string
}

/** Mono raw-mode labels + one-line descriptions per artboard 1d/1h — exact copy from the design canvas. */
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

/**
 * Selectable permission-mode cards, shared between `NewSessionDialog` and
 * `Settings` (both artboards 1d/1h show the same three cards) rather than
 * duplicated — per the task's "build it once" instruction.
 */
export function ModeCards({ value, onChange, disabled = false }: ModeCardsProps) {
  return (
    <div role="radiogroup" aria-label="Permission mode" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {MODES.map((mode) => {
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
              'relative flex flex-col gap-1 rounded-md border px-3 py-2 text-left text-sm transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40',
              active
                ? 'border-accent/60 bg-accent/5 text-text-bright'
                : 'border-panel-border text-text-soft hover:bg-white/5',
            ].join(' ')}
          >
            {active && (
              <span aria-hidden className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-accent" />
            )}
            <span className="font-mono text-xs font-semibold tracking-wide">{mode.label}</span>
            <span className="text-[11px] leading-snug text-text-muted">{mode.description}</span>
          </button>
        )
      })}
    </div>
  )
}
