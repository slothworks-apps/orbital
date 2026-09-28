import { tagColor } from '../lib/types'

/** The export's own accent hue, `oklch(85% .12 205)` (canvas 1b). */
export const GLINT_ACCENT_HUE = 205

/**
 * The glint's opacity while its window sits behind another (canvas
 * `Feature - Detached window` 22d). Only the glint answers to focus — the
 * ink, the status blink and the gauges stay as they are, because a window in
 * the background is still a session worth reading.
 */
const INACTIVE_GLINT_OPACITY = 0.45

/**
 * The hairline glint along a surface's top edge (canvas 1b): 1px, fading in
 * from both ends toward the hue. The detail panel wears it in the session's
 * tag hue; the sidebar and the main window in the accent. Place it inside a
 * positioned box.
 */
export function TopGlint({
  hue = GLINT_ACCENT_HUE,
  focused = true,
  className = '',
}: {
  hue?: number
  focused?: boolean
  className?: string
}) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-x-0 top-0 h-px ${className}`}
      style={{
        background: `linear-gradient(90deg, transparent, ${tagColor(hue)}, transparent)`,
        opacity: focused ? 1 : INACTIVE_GLINT_OPACITY,
      }}
    />
  )
}
