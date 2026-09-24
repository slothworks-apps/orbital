/**
 * What a detached window shows while a subagent is open (subagent list spec
 * § 4, canvas 25b): the subagent `pane` beside the session, or the subagent
 * in the session's place, a `swap`.
 */
export type WindowLayout = 'pane' | 'swap'

/**
 * Pane when the window, or the width main answered it will grow to, clears
 * `thresholdPx` (the caller's `WINDOW_PANEL_PAIR_MIN_PX`). Counting the answer
 * is what lets a window that is about to grow show the pane from the first
 * frame instead of flashing the swap while the animation runs.
 */
export function resolveWindowLayout({
  windowWidth,
  answeredWidth,
  thresholdPx,
}: {
  windowWidth: number
  answeredWidth?: number
  thresholdPx: number
}): WindowLayout {
  return Math.max(windowWidth, answeredWidth ?? 0) >= thresholdPx ? 'pane' : 'swap'
}

/**
 * Whether the window has reached the width main answered, so the answer can
 * be forgotten: from then on the window's own width alone decides, and a
 * hand resize across the threshold switches the layout in place.
 */
export function answeredWidthReached(windowWidth: number, answeredWidth: number): boolean {
  return windowWidth >= answeredWidth
}
