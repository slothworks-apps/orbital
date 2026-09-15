import type { ReactNode } from 'react'

interface ToggleableProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** Visible label text. Omit for icon-only placements and set aria-label instead. */
  label?: ReactNode
  'aria-label'?: string
  disabled?: boolean
}

/**
 * Themed checkbox — the native input stays in the DOM (sr-only) for
 * semantics and focus; the visible box is drawn by us.
 */
export function Checkbox({ checked, onChange, label, disabled = false, ...aria }: ToggleableProps) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-text-soft">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-label={aria['aria-label']}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={[
          'flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] leading-none transition-colors',
          'peer-focus-visible:ring-1 peer-focus-visible:ring-accent',
          checked ? 'border-accent bg-accent text-space' : 'border-panel-border bg-panel-solid',
        ].join(' ')}
      >
        {checked ? '✓' : ''}
      </span>
      {label}
    </label>
  )
}

/**
 * Themed on/off switch (checkbox semantics — same native input underneath,
 * drawn as a pill with a sliding knob, accent-filled when on).
 */
export function Toggle({ checked, onChange, label, disabled = false, ...aria }: ToggleableProps) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-text-soft">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-label={aria['aria-label']}
        onChange={(e) => onChange(e.target.checked)}
      />
      {/* 32×18 pill with a 14px knob and an accent glow when on (canvas 1h). */}
      <span
        aria-hidden
        className={[
          'relative h-[18px] w-8 shrink-0 rounded-full border transition-colors',
          'peer-focus-visible:ring-1 peer-focus-visible:ring-accent',
          checked
            ? 'border-transparent bg-accent shadow-[0_0_10px_rgba(89,228,243,.5)]'
            : 'border-panel-border bg-panel-solid',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-all',
            checked ? 'left-[calc(100%-1rem)] bg-space' : 'left-0.5 bg-text-muted',
          ].join(' ')}
        />
      </span>
      {label}
    </label>
  )
}
