import type { CSSProperties, ReactNode } from 'react'

export interface PanelProps {
  /** Which edge the panel docks to, or a free-floating glass card. Controls width/position classes. */
  side?: 'left' | 'right' | 'float'
  /** Collapses the panel to a narrow rail (docked sides only). The caller decides what content to show. */
  collapsed?: boolean
  /**
   * Tag hue (0-360) for the outer bloom the export paints around the detail
   * panel when a session is open (1b: `0 0 40px oklch(80% .13 210 / .08)`).
   * Omitted = no bloom, which is what 1g shows.
   */
  glowHue?: number
  /**
   * Live width in CSS px for a docked panel, replacing the side's fixed
   * width class — the detail panel's drag handle drives this. Ignored while
   * `collapsed` (the rail width wins) and meaningless for `float`.
   */
  widthPx?: number
  /**
   * Set false during a pointer drag so the width tracks the cursor 1:1 —
   * 420ms of easing behind the pointer feels broken. Back to true at rest
   * so collapse/expand keeps the canvas timing.
   */
  widthTransition?: boolean
  /**
   * Layout-only passthrough (margin, grid-area, absolute positioning offsets).
   * Never use this to override internal panel styling (bg/border/blur) — variants are props-driven.
   */
  className?: string
  children?: ReactNode
}

// Widths verbatim from the export: 300px sidebar (1a), 450px detail panel (1b).
const sideWidth: Record<NonNullable<PanelProps['side']>, string> = {
  left: 'w-[300px]',
  right: 'w-[450px]',
  float: '',
}

// Docked panels float with an outer margin (artboard 1a/1b) at 14px; the
// centred modal panels (1e/1h) round one notch harder at 16px.
const sideRounding: Record<NonNullable<PanelProps['side']>, string> = {
  left: 'rounded-[14px]',
  right: 'rounded-[14px]',
  float: 'rounded-2xl',
}

/**
 * Glass recipe verbatim from the design export. The two docked panels do NOT
 * share one recipe: the sidebar (1a/1b/1g) is lighter and blurred less so the
 * map reads through it, while the detail panel (1b/1g) sits denser, blurs
 * harder and carries a brighter edge and a deeper drop shadow.
 */
const sideChrome: Record<NonNullable<PanelProps['side']>, string> = {
  left: [
    'bg-gradient-to-b from-[rgba(14,20,34,.72)] to-[rgba(8,12,22,.78)]',
    'border border-[rgba(150,205,255,.16)] backdrop-blur-[22px]',
    'shadow-[0_30px_80px_rgba(0,0,0,.5),inset_0_1px_0_rgba(255,255,255,.06)]',
  ].join(' '),
  right: [
    'bg-gradient-to-b from-[rgba(14,20,34,.78)] to-[rgba(8,12,22,.84)]',
    'border border-[rgba(150,205,255,.18)] backdrop-blur-[24px]',
    'shadow-[0_30px_80px_rgba(0,0,0,.55),inset_0_1px_0_rgba(255,255,255,.06)]',
  ].join(' '),
  // `float` is the centred 1120×740 modal panel of 1e/1h — it sits over a
  // scrim rather than over the map, so it is the densest and most opaque of
  // the three, with a much deeper shadow.
  float: [
    'bg-gradient-to-b from-[rgba(16,22,38,.88)] to-[rgba(8,12,22,.94)]',
    'border border-[rgba(150,205,255,.2)] backdrop-blur-[28px]',
    'shadow-[0_40px_120px_rgba(0,0,0,.7),inset_0_1px_0_rgba(255,255,255,.07)]',
  ].join(' '),
}

/** Drop shadow list for `sideChrome[side]`, re-stated so the hue bloom can extend it. */
const sideShadow: Record<NonNullable<PanelProps['side']>, string> = {
  left: '0 30px 80px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06)',
  right: '0 30px 80px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06)',
  float: '0 40px 120px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.07)',
}

export function Panel({
  side = 'float',
  collapsed = false,
  glowHue,
  widthPx,
  widthTransition = true,
  className,
  children,
}: PanelProps) {
  const useLiveWidth = !collapsed && side !== 'float' && widthPx !== undefined
  const width = collapsed ? (side === 'float' ? '' : 'w-14') : useLiveWidth ? '' : sideWidth[side]

  // The bloom is hue-dependent, so it can't live in a static class — it
  // replaces the whole shadow list when present (1b). The live width joins
  // it for the same reason: a dragged number can't be a class.
  const style: CSSProperties | undefined =
    glowHue !== undefined || useLiveWidth
      ? {
          ...(glowHue !== undefined
            ? { boxShadow: `${sideShadow[side]}, 0 0 40px oklch(80% 0.13 ${glowHue} / 0.08)` }
            : undefined),
          ...(useLiveWidth ? { width: widthPx } : undefined),
        }
      : undefined

  return (
    <div
      data-side={side}
      data-collapsed={collapsed}
      style={style}
      className={[
        sideChrome[side],
        sideRounding[side],
        width,
        // Collapse/expand timing verbatim from the canvas export; dropped
        // during a drag so the width tracks the pointer (see widthTransition).
        widthTransition ? 'transition-[width] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}
