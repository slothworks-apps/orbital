import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * Which of the detail header's two action boxes this is (canvas
 * `Feature - Detail header` 9d):
 *
 * - `strip` — the utility strip on row 1 (pin, clear, close).
 * - `title` — the regenerate ring beside the title on row 2. A notch smaller
 *   and a notch quieter, so three hairline squares never read as a toolbar
 *   competing with the title next to them (9c, ACTION WEIGHT).
 */
export type UtilityVariant = 'strip' | 'title'

/** Box size and resting ink per variant, verbatim from 9d's geometry table. */
const VARIANTS = {
  strip: { size: 24, ink: 'text-[rgba(200,220,245,.7)]' },
  title: { size: 22, ink: 'text-[rgba(160,190,225,.75)]' },
} as const satisfies Record<UtilityVariant, unknown>

export interface UtilityButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: UtilityVariant
  /**
   * The accent fill: what the pin wears while pinned and the ring wears while
   * it spins. Distinct from `:hover`, which is only the background.
   */
  active?: boolean
  /** Layout only, per web/CLAUDE.md — the chrome is this component's. */
  className?: string
  children: ReactNode
}

/**
 * A borderless icon button for the detail panel header.
 *
 * Borderless is the point: 9d drops the bordered squares the header used to
 * wear so the path line can carry the actions without gaining weight. The box
 * still exists — it is the hit target, and hover and focus both paint it, so a
 * keyboard user sees what a pointer user sees.
 */
export function UtilityButton({
  variant = 'strip',
  active = false,
  className,
  children,
  ...rest
}: UtilityButtonProps) {
  const v = VARIANTS[variant]
  return (
    <button
      type="button"
      className={[
        'grid shrink-0 place-items-center rounded-md border border-transparent',
        'transition-[background-color,border-color,color] duration-[180ms] ease-[ease]',
        'focus-visible:outline-none disabled:pointer-events-none',
        active
          ? // No `disabled:opacity-50` here: a control is disabled BECAUSE it
            // is active (the ring while it spins), and dimming the accent
            // would read as the opposite of running.
            'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-accent'
          : [
              v.ink,
              // The dim of a button that has nothing to open — canvas
              // `Feature - Header gauges` 11c draws NO DATA at
              // rgba(200,220,245,.28), which is the strip's own resting ink
              // taken to four tenths.
              'disabled:opacity-40',
              'hover:bg-[rgba(150,205,255,.09)] hover:text-[#dce8f7]',
              'focus-visible:bg-[rgba(150,205,255,.09)] focus-visible:text-[#dce8f7]',
            ].join(' '),
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ width: `${v.size}px`, height: `${v.size}px` }}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * The header's glyphs, built from boxes rather than SVG — 9d's ICON SET asks
 * for one stroke weight across all four, and a border width is the only way
 * to hold that when the shapes are this small.
 */
const STROKE = '1.4px'

/** Clear: a left-pointing arrow, one shaft and two heads (9d). */
export function ClearGlyph() {
  return (
    // `block`: an inline box ignores width/height (web/CLAUDE.md), and the
    // three absolute pieces need this one to be their containing block.
    <span aria-hidden className="relative block" style={{ width: '11.5px', height: '11.5px' }}>
      <span
        className="absolute top-1/2 left-px block rounded-[1px] bg-current"
        style={{ width: '9.5px', height: STROKE, marginTop: '-0.7px' }}
      />
      {[42, -42].map((deg) => (
        <span
          key={deg}
          className="absolute top-1/2 left-px block origin-left rounded-[1px] bg-current"
          style={{
            width: '5px',
            height: STROKE,
            marginTop: '-0.7px',
            transform: `rotate(${deg}deg)`,
          }}
        />
      ))}
    </span>
  )
}

/** Close: two crossed bars, not the `×` glyph — 9d's ICON SET rules glyphs out. */
export function CloseGlyph() {
  return (
    <span aria-hidden className="relative block" style={{ width: '9px', height: '9px' }}>
      {[45, -45].map((deg) => (
        <span
          key={deg}
          className="absolute top-0 left-1/2 block h-full rounded-[1px] bg-current"
          style={{ width: STROKE, marginLeft: '-0.7px', transform: `rotate(${deg}deg)` }}
        />
      ))}
    </span>
  )
}

/**
 * Regenerate: a ring with a gap and an arrowhead closing it (9c, REGENERATE
 * ICON). It replaced a sparkle because "do this again" is what the button
 * does, and it has to hold its own next to the pin at the same stroke weight.
 *
 * The gap is a conic mask over a plain bordered circle; the head is a CSS
 * triangle, which is the only shape a border can draw that is not a box.
 */
export function RefreshGlyph({ spinning = false }: { spinning?: boolean }) {
  const gap = 'conic-gradient(from 28deg, transparent 0 62deg, #000 62deg)'
  return (
    <span
      aria-hidden
      className={['relative block', spinning ? 'orbital-spin' : ''].filter(Boolean).join(' ')}
      style={{ width: '11.5px', height: '11.5px' }}
    >
      <span
        className="absolute inset-0 box-border block rounded-full"
        style={{ border: `${STROKE} solid currentColor`, mask: gap, WebkitMask: gap }}
      />
      <span
        className="absolute block"
        style={{
          top: '-1px',
          right: '-1px',
          width: 0,
          height: 0,
          borderLeft: '2.5px solid transparent',
          borderRight: '2.5px solid transparent',
          borderBottom: '3.6px solid currentColor',
          transform: 'rotate(128deg)',
        }}
      />
    </span>
  )
}

/**
 * Which of the two sizes the stats glyph is drawn at — the bar table in
 * canvas `Feature - Header gauges` 11d gives both, and they are not a scale
 * of one another (the bar widths and gaps are picked per size so the strokes
 * stay on whole-ish pixels).
 */
export type StatsGlyphSize = 'header' | 'footer'

/** 11c's ICON · STATES geometry (`header`) and 11d's footer variant, verbatim. */
const STATS_BARS = {
  header: { w: 12, h: 11, bar: 2.6, left: [0, 4.7, 9.4], height: [5, 11, 7.5] },
  footer: { w: 10, h: 9, bar: 2.2, left: [0, 3.9, 7.8], height: [4, 9, 6] },
} as const satisfies Record<StatsGlyphSize, unknown>

/**
 * Stats: three bottom-aligned bars, no axis and no frame (11c). It is the one
 * glyph here that is not built at a single stroke weight — it is a reading,
 * not an action, and the three heights ARE the shape.
 */
export function StatsGlyph({ size = 'header' }: { size?: StatsGlyphSize }) {
  const g = STATS_BARS[size]
  return (
    <span aria-hidden className="relative block" style={{ width: `${g.w}px`, height: `${g.h}px` }}>
      {g.height.map((height, i) => (
        <span
          key={height}
          className="absolute bottom-0 block rounded-[1px] bg-current"
          style={{ left: `${g.left[i]}px`, width: `${g.bar}px`, height: `${height}px` }}
        />
      ))}
    </span>
  )
}
