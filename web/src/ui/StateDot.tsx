import { dotMotionClass, STATE_DOT_RING_PX, type StateDot as Dot } from '../lib/stateStyle'

/**
 * A session state's dot (canvas `Feature - State colours` 24a–24e): solid or
 * hollow, breathing, pulsing or steady, as `stateDot` decides for the
 * surface. Every state surface draws it through here, so the shapes cannot
 * drift apart; only the size differs per surface, and each surface passes
 * the canvas's own for both shapes.
 */
export function StateDot({
  dot,
  color,
  solidPx,
  hollowPx,
  ringPx = STATE_DOT_RING_PX,
  glow = false,
}: {
  dot: Dot
  color: string
  solidPx: number
  hollowPx: number
  /** The hollow ring's width, where a surface's canvas draws it finer than a state's (31b's limit pill). */
  ringPx?: number
  /** The detail chip's WORKING dot keeps its `0 0 8px` glow (24c). */
  glow?: boolean
}) {
  if (dot.shape === 'none') return null
  const size = dot.shape === 'solid' ? solidPx : hollowPx
  return (
    <span
      aria-hidden
      className={dotMotionClass(dot.motion)}
      style={{
        display: 'block',
        flex: 'none',
        width: size,
        height: size,
        boxSizing: 'border-box',
        borderRadius: '50%',
        ...(dot.shape === 'solid'
          ? { background: color, boxShadow: glow ? `0 0 8px ${color}` : undefined }
          : { border: `${ringPx}px solid ${color}` }),
      }}
    />
  )
}
