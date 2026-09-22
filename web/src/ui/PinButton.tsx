import { UtilityButton } from './UtilityButton'

/**
 * The pin toggle — the one control behind both entry points of the pinned
 * sessions feature: the detail header (canvas 4b, re-cut into the utility
 * strip by `Feature - Detail header` 9d) and the sidebar row (canvas 4c).
 * One component, two sizes, because 4e leaves the glyph itself open: variant
 * D "anchor ring" is provisional, and when it is replaced only `PinGlyph`
 * below changes.
 *
 * `aria-pressed` carries the state; the label names the action the press
 * would perform, per 4d's `pin.aria`.
 */

/** Size in px of the button box — 9d draws the header at 24 and 4c the row at 18. */
export type PinSize = 18 | 24

/**
 * Glyph construction, both sizes, from 4b's GLYPH — CONSTRUCTION panel, the
 * header one re-measured against 9d's smaller box. Two boxes and no SVG: a
 * head circle whose fill is the pinned state, over a stem. Kept as data so
 * the two sizes cannot drift apart by hand-editing.
 */
const GEOMETRY = {
  24: { glyphW: 12, glyphH: 13, head: 8, headBorder: 1.4, stemW: 1.4, stemH: 5 },
  18: { radius: 5, glyphW: 10, glyphH: 11, head: 6.5, headBorder: 1.25, stemW: 1.25, stemH: 4.5 },
} as const satisfies Record<PinSize, unknown>

function PinGlyph({ size, pinned }: { size: PinSize; pinned: boolean }) {
  const g = GEOMETRY[size]
  return (
    // `block`: an inline box ignores width/height (web/CLAUDE.md), and the
    // two absolute pieces need this one to be their containing block.
    <span
      aria-hidden
      className="relative block"
      style={{ width: `${g.glyphW}px`, height: `${g.glyphH}px` }}
    >
      <span
        className="absolute top-0 left-1/2 block rounded-full border-current"
        style={{
          width: `${g.head}px`,
          height: `${g.head}px`,
          marginLeft: `${-g.head / 2}px`,
          borderWidth: `${g.headBorder}px`,
          // 4b: the head fills in when pinned — the only difference between
          // the two states that survives at 18px.
          background: pinned ? 'currentColor' : 'transparent',
        }}
      />
      <span
        className="absolute left-1/2 block rounded-[1px] bg-current"
        style={{
          top: `${g.head}px`,
          width: `${g.stemW}px`,
          height: `${g.stemH}px`,
          marginLeft: `${-g.stemW / 2}px`,
        }}
      />
    </span>
  )
}

export interface PinButtonProps {
  pinned: boolean
  size: PinSize
  onToggle: () => void
  /** Layout only, per web/CLAUDE.md — the chrome is this component's. */
  className?: string
  /** Set by `Tooltip` when it wraps the button. */
  'aria-describedby'?: string
}

/**
 * State chrome is literal in the canvas: 9d's utility strip for the 24px
 * header button — which is `UtilityButton`, so the pin cannot drift away from
 * the clear and close beside it — and 4c's ROW GEOMETRY panel for the 18px
 * row button.
 *
 * The row button reveals itself on hover of the ROW, not of itself — it is
 * invisible until then, so it could never be hovered into view on its own.
 * That is what `group-hover/row` reads from, and why a caller mounting the
 * 18px size must mark the row `group/row`. The slot keeps its box in every
 * state so nothing reflows when it appears (4c: "why nothing moves").
 */
export function PinButton({
  pinned,
  size,
  onToggle,
  className,
  'aria-describedby': describedBy,
}: PinButtonProps) {
  const label = pinned ? 'Unpin session' : 'Pin session'

  if (size === 24) {
    return (
      <UtilityButton
        active={pinned}
        aria-pressed={pinned}
        aria-label={label}
        aria-describedby={describedBy}
        onClick={onToggle}
        className={className}
      >
        <PinGlyph size={24} pinned={pinned} />
      </UtilityButton>
    )
  }

  const g = GEOMETRY[18]
  const chrome = pinned
    ? [
        'border-transparent text-accent opacity-100',
        'group-hover/row:border-[rgba(150,205,255,.3)] group-hover/row:bg-[rgba(150,205,255,.14)]',
      ].join(' ')
    : [
        'border-[rgba(150,205,255,.14)] text-[rgba(200,220,245,.7)] opacity-0',
        'group-hover/row:opacity-100 group-hover/row:border-[rgba(150,205,255,.26)]',
        'group-hover/row:bg-[rgba(150,205,255,.09)] group-hover/row:text-[#dce8f7]',
        'focus-visible:opacity-100',
      ].join(' ')

  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={label}
      aria-describedby={describedBy}
      onClick={onToggle}
      className={[
        'grid shrink-0 place-items-center border ease-[ease]',
        'transition-[opacity,background-color,border-color,color] duration-[160ms]',
        chrome,
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ width: `${size}px`, height: `${size}px`, borderRadius: `${g.radius}px` }}
    >
      <PinGlyph size={size} pinned={pinned} />
    </button>
  )
}
