import type { SelectHTMLAttributes } from 'react'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Layout-only passthrough (width, margin). Never use to override control styling. */
  className?: string
}

/**
 * Styled replacement for a bare `<select>` — native popup behavior, themed
 * closed state (mono, panel fill, custom chevron instead of OS chrome).
 */
export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <span className={['relative inline-flex', className ?? ''].filter(Boolean).join(' ')}>
      <select
        {...rest}
        className="w-full cursor-pointer appearance-none rounded-md border border-panel-border bg-panel-solid py-1.5 pl-3 pr-8 font-mono text-xs text-text-bright transition-colors hover:border-accent/40 focus:border-accent/60 focus:outline-none"
      >
        {children}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-text-muted"
      >
        ▾
      </span>
    </span>
  )
}
