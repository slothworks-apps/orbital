/**
 * The Limits shortcut's ¾ ring (canvas `Feature - Plan limits` 31a, the
 * phone's 60d): a fixed arc in the current text colour, never a state.
 * `footer` and `rail` are the sidebar's two places, `phone` the session
 * list's header.
 */
const SIZES = {
  footer: { px: 10, inner: 2, outer: 1.5 },
  rail: { px: 11, inner: 2, outer: 1.5 },
  phone: { px: 16, inner: 2.2, outer: 1.7 },
} as const

export function LimitsGlyph({ size }: { size: keyof typeof SIZES }) {
  const { px, inner, outer } = SIZES[size]
  const mask = `radial-gradient(farthest-side, transparent calc(100% - ${inner}px), #000 calc(100% - ${outer}px))`
  return (
    <span
      aria-hidden
      className="block shrink-0 rounded-full"
      style={{
        width: px,
        height: px,
        background: 'conic-gradient(from -90deg, currentColor 0 250deg, color-mix(in oklab, var(--color-ink-500) 25%, transparent) 250deg 360deg)',
        mask,
        WebkitMask: mask,
      }}
    />
  )
}
