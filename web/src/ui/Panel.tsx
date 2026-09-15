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
// keeps the full rounding (canvas radius: 14px).
const sideRounding: Record<NonNullable<PanelProps['side']>, string> = {
  left: 'rounded-[14px]',
  right: 'rounded-[14px]',
  float: 'rounded-[14px]',
}

export function Panel({ side = 'float', collapsed = false, className, children }: PanelProps) {
  const width = collapsed ? (side === 'float' ? '' : 'w-14') : sideWidth[side]

  return (
    <div
      data-side={side}
      data-collapsed={collapsed}
      className={[
        // Glass recipe verbatim from the design export: vertical gradient
        // fill, 22px blur, drop shadow with a 1px white inner top highlight.
        'bg-gradient-to-b from-[rgba(14,20,34,.85)] to-[rgba(8,12,22,.9)] border border-panel-border backdrop-blur-[22px]',
        'shadow-[0_30px_80px_rgba(0,0,0,.5),inset_0_1px_0_rgba(255,255,255,.06)]',
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
