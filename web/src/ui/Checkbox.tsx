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
 * The box's size. `default` is 1h's 14px box beside a 12.5px label; `row` is
 * End's "Also remove worktree" row (canvas 63h): a 16px box with a 1.5px
 * edge at the top of a two-line label in the row's own ink; `touch` is the
 * same row on the phone (63h PHONE END SHEET), a 22px box.
 */
type CheckboxSize = 'default' | 'row' | 'touch'

const CHECKBOX_LABEL: Record<CheckboxSize, string> = {
  default: 'items-center gap-2.5 fs-12.5 text-ink-300',
  row: 'items-start gap-[11px] text-ink-100',
  touch: 'items-center gap-3.5 text-ink-100',
}

const CHECKBOX_BOX: Record<CheckboxSize, { box: string; on: string; off: string }> = {
  default: {
    box: 'h-3.5 w-3.5 rounded border fs-9 transition-colors',
    on: "border-accent bg-accent text-space after:content-['✓']",
    off: 'border-line/14 bg-panel-solid',
  },
  // 63h: 1.5px border, 4px radius; `background .15s, border-color .15s`.
  row: {
    box: 'mt-px h-4 w-4 rounded-[4px] border-[1.5px] fs-11 font-bold text-space-deep transition-[background-color,border-color] duration-150 ease-[ease]',
    on: "border-accent bg-accent after:content-['✓']",
    off: 'border-line/35 bg-transparent',
  },
  // 63h PHONE: 1.5px border, 6px radius.
  touch: {
    box: 'h-[22px] w-[22px] rounded-[6px] border-[1.5px] fs-14 font-bold text-space-deep transition-[background-color,border-color] duration-150 ease-[ease]',
    on: "border-accent bg-accent after:content-['✓']",
    off: 'border-line/35 bg-transparent',
  },
}

/**
 * Themed checkbox — the native input stays in the DOM (sr-only) for
 * semantics and focus; the visible box is drawn by us.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  size = 'default',
  ...aria
}: ToggleableProps & { size?: CheckboxSize }) {
  const look = CHECKBOX_BOX[size]
  return (
    // 14px box, 10px gap, 12.5px label — canvas 1h's "New session inherits"
    // rows and 1g's "Don't ask again".
    // `relative` is load-bearing: the sr-only input is position:absolute, and
    // without a positioned label its containing block is whatever positioned
    // ancestor the caller happens to have. Inside a scrolling column that means
    // the input escapes the scroller's clipping, bloats an outer
    // overflow-hidden ancestor's scrollHeight, and the browser scroll-on-focus
    // then scrolls that ancestor when the label is clicked — shearing the
    // whole layout (Settings dialog, 2026-09-20).
    <label className={`relative flex cursor-pointer select-none ${CHECKBOX_LABEL[size]}`}>
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-label={aria['aria-label']}
        onChange={(e) => onChange(e.target.checked)}
      />
      {/* The check mark is generated content, not a text child: a literal
          "✓" child would join the label's textContent, so `getByLabelText`
          against the visible label (see settings.test.tsx's "Remember last
          model per project") would never get an exact match once checked. */}
      <span
        aria-hidden
        className={[
          'flex shrink-0 items-center justify-center leading-none',
          look.box,
          'peer-focus-visible:ring-1 peer-focus-visible:ring-accent',
          checked ? look.on : look.off,
        ].join(' ')}
      />
      {label}
    </label>
  )
}

/**
 * Themed on/off switch (checkbox semantics — same native input underneath,
 * drawn as a pill with a sliding knob, accent-filled when on).
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  variant = 'default',
  ...aria
}: ToggleableProps & {
  /**
   * `leading` is New session's worktree switch (Worktree Group component,
   * canvas 63a): the label before the track, 12.5px/600 brightening as it
   * turns on, the track without an edge; both move over `SWITCH_MS`.
   */
  variant?: 'default' | 'leading'
}) {
  if (variant === 'leading') {
    return (
      <label
        className={[
          'relative flex select-none items-center gap-2.5 fs-12.5 font-semibold transition-colors duration-[180ms] ease-[ease]',
          checked ? 'text-ink-100' : 'text-ink-200/85',
          disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
        ].join(' ')}
      >
        <input
          type="checkbox"
          role="switch"
          className="peer sr-only"
          checked={checked}
          disabled={disabled}
          aria-label={aria['aria-label']}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
        {/* 32×18 with a 14px knob, accent and glowing when on. */}
        <span
          aria-hidden
          className={[
            'relative block h-[18px] w-8 flex-none rounded-[9px] transition-[background-color,box-shadow] duration-[180ms] ease-[ease]',
            'peer-focus-visible:ring-1 peer-focus-visible:ring-accent',
            checked
              ? 'bg-accent shadow-[0_0_10px_color-mix(in_oklab,var(--color-accent)_50%,transparent)]'
              : 'bg-line/16',
          ].join(' ')}
        >
          <span
            className={[
              'absolute top-0.5 block h-3.5 w-3.5 rounded-full transition-[left,background-color] duration-[180ms] ease-[ease]',
              checked ? 'left-4 bg-space-deep' : 'left-0.5 bg-ink-200/80',
            ].join(' ')}
          />
        </span>
      </label>
    )
  }
  return (
    // `relative` for the same containment reason as Checkbox's label above.
    // Disabled reads as unavailable, not as off: dimmed, and no pointer
    // (canvas `Feature - Branch status` 1g, the PR switch without gh).
    <label
      className={[
        'relative flex select-none items-center gap-2 fs-14 leading-(--text-sm--line-height) text-ink-300',
        disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer',
      ].join(' ')}
    >
      <input
        type="checkbox"
        // Explicit switch semantics: a screen reader should hear "on/off",
        // not "checked/unchecked", for the pill-with-a-knob this renders as.
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        aria-label={aria['aria-label']}
        onChange={(e) => onChange(e.target.checked)}
      />
      {/* 32×18 pill with a 14px knob and an accent glow when on (canvas 1h);
          knob fill on is canvas 4c's literal #03111a — --color-space-deep,
          not --color-space (#05070d), which looks identical until compared. */}
      <span
        aria-hidden
        className={[
          'relative h-[18px] w-8 shrink-0 rounded-full border transition-colors',
          'peer-focus-visible:ring-1 peer-focus-visible:ring-accent',
          checked
            ? 'border-transparent bg-accent shadow-[0_0_10px_color-mix(in_oklab,_var(--color-accent)_50%,_transparent)]'
            : 'border-line/14 bg-panel-solid',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full transition-all',
            checked ? 'left-[calc(100%-1rem)] bg-space-deep' : 'left-0.5 bg-ink-900/70',
          ].join(' ')}
        />
      </span>
      {label}
    </label>
  )
}
