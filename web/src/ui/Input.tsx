import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

const fieldClass = (font: 'sans' | 'mono', variant: 'field' | 'inline', className?: string) =>
  [
    'w-full text-sm text-text-bright placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-text-soft',
    variant === 'field'
      ? 'rounded-md border border-panel-border bg-panel px-3 py-1.5'
      // Inline variant: borderless until focused — for editing a value in
      // place (e.g. DetailPanel's title) rather than a standalone field.
      : 'rounded-md border border-transparent bg-transparent px-1 py-0.5 font-semibold focus:border-panel-border',
    font === 'mono' ? 'font-mono' : 'font-sans',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  font?: 'sans' | 'mono'
  /** 'field' (default) is the standard bordered input; 'inline' is for editing a value in place (borderless until focused). */
  variant?: 'field' | 'inline'
  /** Layout-only passthrough (margin, grid-area). Never use to override the field styling. */
  className?: string
}

export function Input({ font = 'sans', variant = 'field', className, ...rest }: InputProps) {
  return <input data-font={font} data-variant={variant} className={fieldClass(font, variant, className)} {...rest} />
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  font?: 'sans' | 'mono'
  /** Layout-only passthrough (margin, grid-area). Never use to override the field styling. */
  className?: string
}

export function TextArea({ font = 'sans', className, ...rest }: TextAreaProps) {
  return <textarea data-font={font} className={fieldClass(font, 'field', className)} {...rest} />
}
