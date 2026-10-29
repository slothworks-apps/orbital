import type { Chord } from '../lib/keymap'
import { chordGlyphs } from '../lib/keymap'

export interface KeycapProps {
  /** Rendered through `chordGlyphs`, one glyph per inline span. */
  chord?: Chord
  /**
   * A literal cap instead of the chord's glyphs (`dialogs.pick`'s '1–9', a
   * gesture's '⌥-click'). An array is one cap's glyphs already resolved —
   * what the keymap's `Row.caps` carries — and lays out exactly as a chord's.
   */
  display?: string | readonly string[]
  /** The alternative-binding treatment: text drops to the muted ink. */
  muted?: boolean
  /** The pointer-gesture treatment: dashed border, transparent fill, muted ink. */
  gesture?: boolean
}

/**
 * One keycap — the shared shell for the Settings → Shortcuts pane (spec:
 * 2026-09-23-shortcuts-design § 6), which draws every cap with `Keycap`.
 * The sidebar's ⌘K badge and the New session ⌘N badge keep their own
 * smaller styling and print their chord with `chordLabel` instead, so the
 * text cannot drift even though the frame differs. `display` overrides
 * `chord` when both are given.
 */
export function Keycap({ chord, display, muted, gesture }: KeycapProps) {
  const glyphs =
    typeof display === 'string'
      ? [display]
      : display !== undefined
        ? display
        : chord !== undefined
          ? chordGlyphs(chord)
          : []
  const multiGlyph = glyphs.length > 1

  return (
    <span
      className={[
        'inline-flex h-fit min-h-6 items-center gap-1.5 rounded-[6px] border font-mono fs-11.5 tracking-[0.06em]',
        multiGlyph ? 'px-[9px]' : 'px-[7px]',
        gesture
          ? 'border-dashed border-line/20 bg-transparent'
          : 'border-line/16 bg-line/5',
        gesture || muted ? 'text-ink-900/60' : 'text-ink-200/90',
      ].join(' ')}
    >
      {glyphs.map((glyph, i) => (
        <span key={i}>{glyph}</span>
      ))}
    </span>
  )
}
