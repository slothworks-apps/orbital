import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

const fieldClass = (font: 'sans' | 'mono', className?: string) =>
  [
    'w-full rounded-md border border-panel-border bg-panel px-3 py-1.5 text-sm text-text-bright',
    'placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-text-soft',
    font === 'mono' ? 'font-mono' : 'font-sans',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  font?: 'sans' | 'mono'
  /** Layout-only passthrough (margin, grid-area). Never use to override the field styling. */
  className?: string
}

export function Input({ font = 'sans', className, ...rest }: InputProps) {
  return <input data-font={font} className={fieldClass(font, className)} {...rest} />
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  font?: 'sans' | 'mono'
  /** Layout-only passthrough (margin, grid-area). Never use to override the field styling. */
  className?: string
}

export function TextArea({ font = 'sans', className, ...rest }: TextAreaProps) {
  return <textarea data-font={font} className={fieldClass(font, className)} {...rest} />
}
