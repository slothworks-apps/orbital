import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

export type FieldSize = 'sm' | 'md' | 'lg'

/**
 * Field geometry per artboard. `md` is the app-wide default (sidebar,
 * detail panel, rules table); `sm` is the settings row control from canvas
 * 1h (8px/10px, radius 8, 12px) and `lg` the dialog field from canvas 1d
 * (10px/12px, radius 9, 12.5px) — both on the darker `rgba(4,8,16,.6)` fill
 * the export uses inside glass panels.
 */
const sizeClasses: Record<FieldSize, string> = {
  sm: 'rounded-lg bg-[rgba(4,8,16,.6)] px-2.5 py-2 text-xs',
  md: 'rounded-md bg-panel px-3 py-1.5 text-sm',
  lg: 'rounded-[9px] bg-[rgba(4,8,16,.6)] px-3 py-2.5 text-[12.5px]',
}

/** Canvas 1d's textarea: 12px/14px padding, radius 10, 13.5px / 1.55. */
const textAreaSizeClasses: Record<FieldSize, string> = {
  ...sizeClasses,
  lg: 'rounded-[10px] bg-[rgba(4,8,16,.6)] px-3.5 py-3 text-[13.5px] leading-[1.55]',
}

// The border colour is picked here, in one place, rather than concatenated
// from a size class plus an invalid override — two same-property utilities
// in one class string resolve by stylesheet order, not string order (see
// web/CLAUDE.md), so the winner would be arbitrary.
const fieldClass = (
  font: 'sans' | 'mono',
  variant: 'field' | 'inline',
  size: FieldSize,
  sizes: Record<FieldSize, string>,
  invalid: boolean,
  className?: string,
) =>
  [
    'w-full text-text-bright placeholder:text-text-muted focus:outline-none focus:ring-1',
    invalid ? 'focus:ring-red-400/70' : 'focus:ring-text-soft',
    variant === 'field'
      ? `border ${invalid ? 'border-red-400/60' : 'border-panel-border'} ${sizes[size]}`
      : // Inline variant: borderless until focused — for editing a value in
        // place (e.g. DetailPanel's title) rather than a standalone field.
        `rounded-md border bg-transparent px-1 py-0.5 text-sm font-semibold ${
          invalid ? 'border-red-400/60' : 'border-transparent focus:border-panel-border'
        }`,
    font === 'mono' ? 'font-mono' : 'font-sans',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  font?: 'sans' | 'mono'
  /** 'field' (default) is the standard bordered input; 'inline' is for editing a value in place (borderless until focused). */
  variant?: 'field' | 'inline'
  /** Field geometry: 'md' (default, app-wide), 'sm' (settings rows, canvas 1h), 'lg' (dialog fields, canvas 1d). */
  size?: FieldSize
  /** Marks the value as failing validation: red border + `aria-invalid`. Pair with `title` to say what's wrong. */
  invalid?: boolean
  /** Layout-only passthrough (margin, grid-area). Never use to override the field styling. */
  className?: string
}

export function Input({
  font = 'sans',
  variant = 'field',
  size = 'md',
  invalid = false,
  className,
  ...rest
}: InputProps) {
  return (
    <input
      data-font={font}
      data-variant={variant}
      data-size={size}
      aria-invalid={invalid || undefined}
      className={fieldClass(font, variant, size, sizeClasses, invalid, className)}
      {...rest}
    />
  )
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  font?: 'sans' | 'mono'
  /** Field geometry: 'md' (default, app-wide), 'sm', 'lg' (dialog composer, canvas 1d). */
  size?: FieldSize
  /** Layout-only passthrough (margin, grid-area). Never use to override the field styling. */
  className?: string
}

export function TextArea({ font = 'sans', size = 'md', className, ...rest }: TextAreaProps) {
  return (
    <textarea
      data-font={font}
      data-size={size}
      className={fieldClass(font, 'field', size, textAreaSizeClasses, false, className)}
      {...rest}
    />
  )
}
