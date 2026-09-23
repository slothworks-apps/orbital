import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'

/**
 * Which of the detail header's two action boxes this is (canvas
 * `Feature - Detail header` 9d):
 *
 * - `strip` — the utility strip on row 1 (stats, pin, clear, end, ⋯, detach, collapse).
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
  /**
   * The "on" fill a menu trigger wears while its menu is open (canvas
   * `Feature - Header actions` 23c form 4, the ⋯): the pressed fill and the
   * bright ink, without `active`'s accent border — an open menu is a state of
   * the control, not a reading in the session's hue.
   */
  open?: boolean
  /** Layout only, per web/CLAUDE.md — the chrome is this component's. */
  className?: string
  ref?: Ref<HTMLButtonElement>
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
  open = false,
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
          : open
            ? // Focus still draws its ring: closing a menu hands focus back
              // here, and the ring is how a keyboard user sees it land.
              'bg-[rgba(150,205,255,.14)] text-[#e8eef8] focus-visible:border-[oklch(85%_.12_205_/_.7)]'
            : [
              v.ink,
              // The dim of a button that has nothing to open — canvas
              // `Feature - Header gauges` 11c draws NO DATA at
              // rgba(200,220,245,.28), which is the strip's own resting ink
              // taken to four tenths.
              'disabled:opacity-40',
              'hover:bg-[rgba(150,205,255,.09)] hover:text-[#dce8f7]',
              // Focus is the hover look plus a hairline ring in the accent,
              // drawn on the box's own transparent border so nothing shifts;
              // a press deepens the fill (canvas `Feature - Detached window`
              // 22a, STATES).
              'focus-visible:bg-[rgba(150,205,255,.09)] focus-visible:text-[#dce8f7]',
              'focus-visible:border-[oklch(85%_.12_205_/_.7)]',
              'active:bg-[rgba(150,205,255,.14)]',
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

/**
 * Clear: an eraser on the baseline it just wiped (canvas `Feature - Header
 * actions` 23b). It replaced 9d's left arrow, which read as "back".
 */
export function ClearGlyph() {
  return (
    // `block`: an inline box ignores width/height (web/CLAUDE.md), and the
    // absolute pieces need this one to be their containing block.
    <span aria-hidden className="relative block" style={{ width: '13px', height: '12px' }}>
      {/* The body, tilted; a band across it splits off the tip. */}
      <span
        className="absolute box-border block"
        style={{
          left: '2px',
          top: '2.75px',
          width: '10px',
          height: '6px',
          border: `${STROKE} solid currentColor`,
          borderRadius: '1.5px',
          transform: 'rotate(-45deg)',
        }}
      >
        <span
          className="absolute block bg-current"
          style={{ left: '3.2px', top: `-${STROKE}`, bottom: `-${STROKE}`, width: STROKE }}
        />
      </span>
      <span
        className="absolute bottom-0 block rounded-[1px] bg-current"
        style={{ left: '6px', width: '7px', height: STROKE }}
      />
    </span>
  )
}

/**
 * End session: the power ring — a ring open at the top with a bar through the
 * gap, the universal "off" (canvas 23b). Kept apart from `RefreshGlyph`'s
 * ring, which has an arrowhead instead of a bar.
 */
export function EndGlyph() {
  const gap = 'conic-gradient(from -36deg, transparent 0 72deg, #000 72deg)'
  return (
    <span aria-hidden className="relative block" style={{ width: '12px', height: '12px' }}>
      <span
        className="absolute box-border block rounded-full"
        style={{
          left: '1px',
          top: '1.5px',
          width: '10px',
          height: '10px',
          border: `${STROKE} solid currentColor`,
          mask: gap,
          WebkitMask: gap,
        }}
      />
      <span
        className="absolute top-0 left-1/2 block rounded-[1px] bg-current"
        style={{ width: STROKE, height: '6.2px', marginLeft: '-0.7px' }}
      />
    </span>
  )
}

/**
 * Collapse: two chevrons pointing off-canvas — the sidebar rail's `»` redrawn
 * in the strip's stroke (canvas 23b), so the header says "slide the panel
 * away" rather than "close something".
 */
export function CollapseGlyph() {
  return (
    <span aria-hidden className="relative block" style={{ width: '12px', height: '10px' }}>
      {[0, 5].map((left) => (
        <span
          key={left}
          className="absolute box-border block"
          style={{
            left: `${left}px`,
            top: '2.5px',
            width: '5px',
            height: '5px',
            borderTop: `${STROKE} solid currentColor`,
            borderRight: `${STROKE} solid currentColor`,
            transform: 'rotate(45deg)',
          }}
        />
      ))}
    </span>
  )
}

/**
 * More: three dots in a row — the ⋯ the folded strip hides stats, clear and
 * detach behind (canvas `Feature - Header actions` 23c form 4). Dots rather
 * than the `⋯` character, for the same reason the other glyphs are boxes.
 */
export function MoreGlyph() {
  return (
    <span aria-hidden className="flex" style={{ gap: '2.2px' }}>
      {[0, 1, 2].map((i) => (
        <span key={i} className="block rounded-full bg-current" style={{ width: '2.4px', height: '2.4px' }} />
      ))}
    </span>
  )
}

/** Walkthrough: three bars stepping up — the staircase is the walkthrough's mark everywhere (canvas 21f). */
export function WalkthroughGlyph() {
  return (
    <span aria-hidden className="relative block" style={{ width: '11.5px', height: '11.5px' }}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="absolute block rounded-[1px] bg-current"
          style={{ width: '5px', height: STROKE, left: `${i * 3.25}px`, bottom: `${i * 3.5}px` }}
        />
      ))}
    </span>
  )
}

/**
 * Detach: a frame with an arrow leaving its top-right corner (canvas
 * `Feature - Detached window` 22a, GLYPH). One glyph in three places — the
 * strip's control, the planet's badge and the sidebar row's mark (22e) — so
 * "this session is in a window" reads the same wherever it is seen.
 *
 * The frame is masked open around that corner so the arrow reads as leaving
 * it rather than sitting on its edge.
 */
export function DetachGlyph() {
  const opening = 'radial-gradient(circle at 100% 0%, transparent 0 4.2px, #000 4.8px)'
  return (
    <span aria-hidden className="relative block" style={{ width: '12px', height: '12px' }}>
      <span
        className="absolute bottom-0 left-0 box-border block rounded-[2px]"
        style={{
          width: '9px',
          height: '9px',
          border: `${STROKE} solid currentColor`,
          mask: opening,
          WebkitMask: opening,
        }}
      />
      {/* Shaft: a vertical bar turned 45°, out of the frame to the corner. */}
      <span
        className="absolute block rounded-[1px] bg-current"
        style={{
          left: '6.8px',
          top: '.6px',
          width: STROKE,
          height: '8px',
          transform: 'rotate(45deg)',
        }}
      />
      {/* Head: the top and right edges of a small box, meeting at the corner. */}
      <span
        className="absolute top-0 right-0 box-border block rounded-tr-[1px]"
        style={{
          width: '5px',
          height: '5px',
          borderTop: `${STROKE} solid currentColor`,
          borderRight: `${STROKE} solid currentColor`,
        }}
      />
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
