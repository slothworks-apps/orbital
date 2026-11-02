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
  strip: { size: 24, ink: 'text-ink-500/70' },
  title: { size: 22, ink: 'text-ink-900/75' },
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
            'border-line/30 bg-line/14 text-accent'
          : open
            ? // Focus still draws its ring: closing a menu hands focus back
              // here, and the ring is how a keyboard user sees it land.
              'bg-line/14 text-ink-100 focus-visible:border-accent/70'
            : [
              v.ink,
              // The dim of a button that has nothing to open — canvas
              // `Feature - Header gauges` 11c draws NO DATA at
              // rgba(200,220,245,.28), which is the strip's own resting ink
              // taken to four tenths.
              'disabled:opacity-40',
              'hover:bg-line/9 hover:text-ink-400',
              // Focus is the hover look plus a hairline ring in the accent,
              // drawn on the box's own transparent border so nothing shifts;
              // a press deepens the fill (canvas `Feature - Detached window`
              // 22a, STATES).
              'focus-visible:bg-line/9 focus-visible:text-ink-400',
              'focus-visible:border-accent/70',
              'active:bg-line/14',
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

/**
 * Harness: a checklist of two rows, an auto step's ● over a gate's ◆, each
 * with its line (canvas `Feature - Harness` 30a-d, the strip button).
 */
export function HarnessGlyph() {
  const ring = 'absolute box-border block border-[1.3px] border-solid border-current'
  const line = 'absolute block rounded-[1px] bg-current'
  return (
    <span aria-hidden className="relative block" style={{ width: '12px', height: '12px' }}>
      <span className={`${ring} rounded-full`} style={{ left: '.5px', top: '.5px', width: '4px', height: '4px' }} />
      <span className={line} style={{ left: '6px', top: '1.8px', width: '6px', height: '1.4px' }} />
      <span
        className={`${ring} rotate-45 rounded-[.8px]`}
        style={{ left: '.7px', top: '7.3px', width: '3.6px', height: '3.6px' }}
      />
      <span className={line} style={{ left: '6px', top: '8.4px', width: '6px', height: '1.4px' }} />
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
 * Rewind's ↶ (canvas 27c: "glyph: the regenerate arc, mirrored (turns back)").
 * `mark` is the 11.5px one on the ↶ button and the transcript's chips; `strip`
 * the 10px one leading the composer strip, a notch finer. The two are drawn
 * separately on the canvas, not scaled from one another.
 */
const REWIND_GLYPH = {
  mark: { box: 11.5, stroke: 1.4, wing: 2.5, head: 3.6 },
  strip: { box: 10, stroke: 1.3, wing: 2.3, head: 3.3 },
} as const

export function RewindGlyph({ size = 'mark' }: { size?: keyof typeof REWIND_GLYPH }) {
  const g = REWIND_GLYPH[size]
  const gap = 'conic-gradient(from 28deg, transparent 0 62deg, #000 62deg)'
  return (
    <span
      aria-hidden
      className="relative block"
      style={{ width: `${g.box}px`, height: `${g.box}px`, transform: 'scaleX(-1)' }}
    >
      <span
        className="absolute inset-0 box-border block rounded-full"
        style={{ border: `${g.stroke}px solid currentColor`, mask: gap, WebkitMask: gap }}
      />
      <span
        className="absolute block"
        style={{
          top: '-1px',
          right: '-1px',
          width: 0,
          height: 0,
          borderLeft: `${g.wing}px solid transparent`,
          borderRight: `${g.wing}px solid transparent`,
          borderBottom: `${g.head}px solid currentColor`,
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

/**
 * Copy image: a picture frame — a peak and a sun inside it, the photo every
 * app draws. The peak is a square turned 45° whose two upper edges show; the
 * frame clips the rest.
 */
export function ImageGlyph() {
  return (
    <span
      aria-hidden
      className="relative block overflow-hidden box-border rounded-[2px]"
      style={{ width: '13px', height: '11px', border: `${STROKE} solid currentColor` }}
    >
      <span className="absolute block rounded-full bg-current" style={{ right: '1.6px', top: '1.6px', width: '2.4px', height: '2.4px' }} />
      <span
        className="absolute box-border block"
        style={{
          left: '1px',
          top: '4.6px',
          width: '6px',
          height: '6px',
          borderTop: `${STROKE} solid currentColor`,
          borderLeft: `${STROKE} solid currentColor`,
          transform: 'rotate(45deg)',
        }}
      />
    </span>
  )
}

/**
 * Copy: two sheets, the front one over the back — the copy mark. The back
 * sheet draws only the edges the front leaves showing, so nothing has to
 * paint over it in the row's own fill.
 */
export function CopyGlyph() {
  const edge = 'absolute block rounded-[1px] bg-current'
  return (
    <span aria-hidden className="relative block" style={{ width: '12px', height: '12px' }}>
      <span
        className="absolute top-0 right-0 box-border block rounded-tr-[2px]"
        style={{ width: '8px', height: '8px', borderTop: `${STROKE} solid currentColor`, borderRight: `${STROKE} solid currentColor` }}
      />
      <span className={edge} style={{ left: '4px', top: 0, width: STROKE, height: '3px' }} />
      <span className={edge} style={{ right: 0, top: '6.6px', width: '3px', height: STROKE }} />
      <span
        className="absolute bottom-0 left-0 box-border block rounded-[2px]"
        style={{ width: '8px', height: '8px', border: `${STROKE} solid currentColor` }}
      />
    </span>
  )
}

/** Show in Finder: a folder — a body with a tab on its top-left edge. */
export function FolderGlyph() {
  return (
    <span aria-hidden className="relative block" style={{ width: '13px', height: '11px' }}>
      <span
        className="absolute top-0 left-0 box-border block rounded-t-[2px]"
        style={{
          width: '6px',
          height: '3px',
          borderTop: `${STROKE} solid currentColor`,
          borderLeft: `${STROKE} solid currentColor`,
          borderRight: `${STROKE} solid currentColor`,
        }}
      />
      <span
        className="absolute bottom-0 left-0 box-border block rounded-[2px]"
        style={{ width: '13px', height: '9px', border: `${STROKE} solid currentColor` }}
      />
    </span>
  )
}

/**
 * Open in ‹editor›: a source page with a gutter — a closed square with every
 * mark inside it, which is what keeps it apart from `DetachGlyph`'s open
 * corner (canvas `Feature - Path menu glyphs` 1g, EDITORGLYPH: 12×12 r2,
 * gutter at x 2, code 5×1 at (4,2) and 3×1 at (5,5)). One glyph for every
 * editor; the row's label names which. The canvas draws 1g's strokes at 1px;
 * the column's shipped weight, `STROKE`, is the one kept (1g: "where they
 * differ from the shipped components, the code is correct").
 */
export function EditorGlyph() {
  const mark = 'absolute block bg-current'
  return (
    <span
      aria-hidden
      className="relative box-border block rounded-[2px]"
      style={{ width: '12px', height: '12px', border: `${STROKE} solid currentColor` }}
    >
      <span className={mark} style={{ left: '2px', top: 0, bottom: 0, width: STROKE }} />
      <span className={mark} style={{ left: '4px', top: '2px', width: '5px', height: STROKE }} />
      <span className={mark} style={{ left: '5px', top: '5px', width: '3px', height: STROKE }} />
    </span>
  )
}

/**
 * Mention in reply: the composer's field with a mention chip in it and the
 * caret after it — the column's one wide, short glyph (canvas `Feature - Path
 * menu glyphs` 1g, MENTIONGLYPH: a 12×8 field at y 2, chip 5×2 at (1,2),
 * caret 1×4 at (7.5,1)).
 */
export function MentionGlyph() {
  return (
    <span aria-hidden className="relative block" style={{ width: '12px', height: '12px' }}>
      <span
        className="absolute left-0 box-border block rounded-[2px]"
        style={{ top: '2px', width: '12px', height: '8px', border: `${STROKE} solid currentColor` }}
      >
        <span className="absolute block rounded-[.5px] bg-current" style={{ left: '1px', top: '2px', width: '5px', height: '2px' }} />
        <span className="absolute block bg-current" style={{ left: '7.5px', top: '1px', width: STROKE, height: '4px' }} />
      </span>
    </span>
  )
}

/**
 * A file's page, by where it is drawn: the desktop chooser's rows (canvas
 * `Feature - Path menu glyphs` 1g, FILEGLYPH: 9×12, r1.5) and the phone
 * sheet's (1f: 10×13 at the sheet's 1.3px stroke, r2).
 */
const PAGE_GLYPH = {
  menu: { width: '9px', height: '12px', stroke: STROKE, radius: 'rounded-[1.5px]' },
  sheet: { width: '10px', height: '13px', stroke: '1.3px', radius: 'rounded-[2px]' },
} as const

/** A file: one page — the bare-name chooser's rows. */
export function PageGlyph({ size = 'menu' }: { size?: keyof typeof PAGE_GLYPH }) {
  const { width, height, stroke, radius } = PAGE_GLYPH[size]
  return (
    <span
      aria-hidden
      className={['box-border block', radius].join(' ')}
      style={{ width, height, border: `${stroke} solid currentColor` }}
    />
  )
}

/**
 * Cut: scissors — two rings in the bottom corners, each blade meeting its
 * ring on the outer side (canvas `Feature - Path menu glyphs` 1h).
 */
export function CutGlyph() {
  const ring = 'absolute box-border block rounded-full'
  const blade = 'absolute block bg-current'
  return (
    <span aria-hidden className="relative block" style={{ width: '12px', height: '12px' }}>
      <span className={ring} style={{ left: 0, top: '8px', width: '4px', height: '4px', border: `${STROKE} solid currentColor` }} />
      <span className={ring} style={{ left: '8px', top: '8px', width: '4px', height: '4px', border: `${STROKE} solid currentColor` }} />
      <span className={blade} style={{ left: '1.44px', top: '3.76px', width: '11.46px', height: STROKE, transform: 'rotate(-48deg)' }} />
      <span className={blade} style={{ left: '-.9px', top: '3.76px', width: '11.46px', height: STROKE, transform: 'rotate(48deg)' }} />
    </span>
  )
}

/** Paste: a clipboard — a board with a solid clip on its top edge (1h). */
export function PasteGlyph() {
  return (
    <span aria-hidden className="relative block" style={{ width: '12px', height: '12px' }}>
      <span
        className="absolute box-border block rounded-[2px]"
        style={{ left: '1px', top: '1px', width: '10px', height: '11px', border: `${STROKE} solid currentColor` }}
      />
      <span className="absolute block rounded-[1px] bg-current" style={{ left: '4px', top: 0, width: '4px', height: '3px' }} />
    </span>
  )
}

/**
 * Select All: four corner brackets with no box between them, around two
 * filled bars that are the selected text (1h).
 */
export function SelectAllGlyph() {
  const bar = 'absolute block bg-current'
  const corners = [
    { left: 0, top: 0 },
    { right: 0, top: 0 },
    { left: 0, bottom: 0 },
    { right: 0, bottom: 0 },
  ]
  return (
    <span aria-hidden className="relative block" style={{ width: '12px', height: '12px' }}>
      {corners.map((at, i) => (
        <span key={i}>
          <span className={bar} style={{ ...at, width: '3px', height: STROKE }} />
          <span className={bar} style={{ ...at, width: STROKE, height: '3px' }} />
        </span>
      ))}
      <span className={bar} style={{ left: '3px', top: '3px', width: '6px', height: '2px' }} />
      <span className={bar} style={{ left: '3px', top: '7px', width: '4px', height: '2px' }} />
    </span>
  )
}
