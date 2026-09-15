import type { ReactNode } from 'react'

export interface PanelProps {
  /** Which edge the panel docks to, or a free-floating glass card. Controls width/position classes. */
  side?: 'left' | 'right' | 'float'
  /** Collapses the panel to a narrow rail (docked sides only). The caller decides what content to show. */
  collapsed?: boolean
  /**
   * Layout-only passthrough (margin, grid-area, absolute positioning offsets).
   * Never use this to override internal panel styling (bg/border/blur) — variants are props-driven.
   */
  className?: string
  children?: ReactNode
}

const sideWidth: Record<NonNullable<PanelProps['side']>, string> = {
  left: 'w-80',
  right: 'w-96',
  float: '',
}

// Docked panels float with an outer margin (artboard 1a/1b), so every side
// keeps the full rounding.
const sideRounding: Record<NonNullable<PanelProps['side']>, string> = {
  left: 'rounded-2xl',
  right: 'rounded-2xl',
  float: 'rounded-2xl',
}

export function Panel({ side = 'float', collapsed = false, className, children }: PanelProps) {
  const width = collapsed ? (side === 'float' ? '' : 'w-14') : sideWidth[side]

  return (
    <div
      data-side={side}
      data-collapsed={collapsed}
      className={[
        'bg-panel border border-panel-border backdrop-blur-md',
        sideRounding[side],
        width,
        'transition-[width] duration-200',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}
