import type { CSSProperties, ReactNode } from 'react'

export interface PanelProps {
  /**
   * Which edge the panel docks to, or a free-floating glass card. Controls
   * width/position classes.
   *
   * `subagent` is the read-only agent panel (canvas 11b) — its OWN docked
   * right-edge recipe, distinct from `right`'s (the detail panel's glassy,
   * blurred glass): flatter and darker, with an inset shadow instead of a
   * drop shadow, so the two read as depth-separated when they sit side by
   * side (spec 2026-09-22-subagent-transcript-panel-design.md § 8, "three
   * cues separate the two panels ... a depth step"). Fixed chrome, not a
   * layout concern — it is what canvas 11b draws for the panel on its own,
   * with no detail panel beside it at all.
   */
  side?: 'left' | 'right' | 'float' | 'subagent'
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
   * The panel IS the window — the detail panel alone in a detached window
   * (spec: 2026-09-23-detached-session-windows-design). It takes the whole
   * width and wears `windowChrome` in place of the side's glass. Wins over
   * `widthPx` and `glowHue`.
   */
  fill?: boolean
  /**
   * Layout-only passthrough (margin, grid-area, absolute positioning offsets).
   * Never use this to override internal panel styling (bg/border/blur) — variants are props-driven.
   */
  className?: string
  children?: ReactNode
}

// Widths verbatim from the export: 300px sidebar (1a), 450px detail panel
// (1b), 380px subagent panel default (11b — the task-8 brief's minimum/
// clamp logic overrides this via `widthPx`, same as the detail panel's own
// drag handle does).
const sideWidth: Record<NonNullable<PanelProps['side']>, string> = {
  left: 'w-[300px]',
  right: 'w-[450px]',
  subagent: 'w-[380px]',
  float: '',
}

// Docked panels float with an outer margin (artboard 1a/1b) at 14px; the
// centred modal panels (1e/1h) round one notch harder at 16px.
const sideRounding: Record<NonNullable<PanelProps['side']>, string> = {
  left: 'rounded-[14px]',
  right: 'rounded-[14px]',
  subagent: 'rounded-[14px]',
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
  // Canvas 11b, verbatim: no blur at all (it is meant to read as flatter and
  // darker than `right`, not as another pane of the same glass), a plain
  // dark gradient, and an INSET shadow — 24px positive x-offset — instead of
  // a drop shadow, so the panel's own left inner edge reads as recessed.
  subagent: [
    'bg-gradient-to-b from-[rgba(10,15,27,.9)] to-[rgba(5,8,16,.94)]',
    'border border-[rgba(150,205,255,.1)]',
    'shadow-[inset_24px_0_40px_-28px_rgba(0,0,0,.9),inset_0_1px_0_rgba(255,255,255,.03)]',
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

/**
 * A panel that fills a window of its own (canvas `Feature - Detached window`
 * 22b): none of the glass. macOS draws the corners, the hairline and the
 * shadow, and there is nothing behind the panel to blur, so the fill is the
 * detail panel's own two stops taken to full opacity. No radius, no border,
 * no blur, no bloom.
 */
const windowChrome = 'bg-gradient-to-b from-[#0f1524] to-[#080c16]'

/** Drop shadow list for `sideChrome[side]`, re-stated so the hue bloom can extend it. */
const sideShadow: Record<NonNullable<PanelProps['side']>, string> = {
  left: '0 30px 80px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06)',
  right: '0 30px 80px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06)',
  // No hue bloom on this panel in the canvas (11b draws none, matching the
  // detail panel's own "omitted = no bloom" convention above) — restated
  // here only so every `side` has an entry and `glowHue` stays type-safe if
  // a future caller ever passes one anyway.
  subagent: 'inset 24px 0 40px -28px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.03)',
  float: '0 40px 120px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.07)',
}

export function Panel({
  side = 'float',
  collapsed = false,
  glowHue,
  widthPx,
  widthTransition = true,
  fill = false,
  className,
  children,
}: PanelProps) {
  const useLiveWidth = !fill && !collapsed && side !== 'float' && widthPx !== undefined
  const width = fill
    ? 'w-full'
    : collapsed
      ? side === 'float'
        ? ''
        : 'w-14'
      : useLiveWidth
        ? ''
        : sideWidth[side]

  // The bloom is hue-dependent, so it can't live in a static class — it
  // replaces the whole shadow list when present (1b). The live width joins
  // it for the same reason: a dragged number can't be a class.
  const bloom = !fill && glowHue !== undefined
  const style: CSSProperties | undefined =
    bloom || useLiveWidth
      ? {
          ...(bloom
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
        fill ? windowChrome : `${sideChrome[side]} ${sideRounding[side]}`,
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
