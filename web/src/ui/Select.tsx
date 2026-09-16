import type { SelectHTMLAttributes } from 'react'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** Layout-only passthrough (width, margin). Never use to override control styling. */
  className?: string
  /** Typeface: mono for technical values (rules), sans for prose options (settings, canvas 1h). */
  font?: 'mono' | 'sans'
}

/**
 * Styled replacement for a bare `<select>` — native popup behavior, themed
 * closed state (panel fill, custom chevron instead of OS chrome).
 */
export function Select({ className, font = 'mono', children, ...rest }: SelectProps) {
  return (
    <span className={['relative inline-flex', className ?? ''].filter(Boolean).join(' ')}>
      <select
        {...rest}
        className={[
          // Canvas 1h: 8px/10px padding, a 26px right gutter for the chevron,
          // 8px radius over the rgba(4,8,16,.6) field fill.
          'w-full cursor-pointer appearance-none rounded-lg border border-panel-border bg-[rgba(4,8,16,.6)] py-2 pl-2.5 pr-[26px] text-text-bright transition-colors hover:border-accent/40 focus:border-accent/60 focus:outline-none',
          font === 'mono' ? 'font-mono text-xs' : 'font-sans text-[12.5px]',
        ].join(' ')}
      >
        {children}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-[rgba(160,190,225,.6)]"
      >
        ▾
      </span>
    </span>
  )
}
