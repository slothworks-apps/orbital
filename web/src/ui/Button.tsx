import type { ButtonHTMLAttributes } from 'react'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger' | 'warning' | 'cta'
  size?: 'sm' | 'md'
  /** Layout-only passthrough (margin, grid-area). Never use to override variant/size styling. */
  className?: string
}

const variantClasses: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-accent text-space hover:bg-text-soft',
  ghost: 'bg-transparent text-text-soft border border-panel-border hover:bg-white/5',
  danger: 'bg-transparent text-red-400 border border-red-400/40 hover:bg-red-400/10',
  warning: 'bg-amber-400 text-space hover:bg-amber-300',
  cta: 'rounded-full bg-gradient-to-b from-[rgba(20,28,46,.85)] to-[rgba(10,14,26,.9)] backdrop-blur-lg border border-accent/45 text-text-bright shadow-[0_0_24px_rgba(126,231,255,.2),0_12px_30px_rgba(0,0,0,.5)] hover:border-accent/70',
}

const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3.5 py-1.5 text-sm',
}

export function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      data-variant={variant}
      data-size={size}
      className={[
        'inline-flex items-center justify-center gap-1.5 rounded-md font-sans font-semibold transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
        variantClasses[variant],
        sizeClasses[size],
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  )
}
