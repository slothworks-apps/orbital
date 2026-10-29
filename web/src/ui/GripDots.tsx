/**
 * The drag grip's dots (canvas `Feature - Tag chips` 80e, the Desk mat's):
 * an 8 × 12 grid of 1 px dots at 4 px. Decoration only — the caller's box is
 * what takes the press.
 */
export function GripDots() {
  return (
    <span
      aria-hidden
      className="block h-3 w-2 flex-none opacity-70"
      style={{
        backgroundImage: 'radial-gradient(circle,color-mix(in oklab, var(--color-ink-900) 60%, transparent) 0 1px,transparent 1.3px)',
        backgroundSize: '4px 4px',
      }}
    />
  )
}
