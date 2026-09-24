/**
 * What a detached window shows while a subagent is open (subagent list spec
 * § 4, canvas 25b): the subagent `pane` beside the session, or the subagent
 * in the session's place, a `swap`. `pending` is the wait for main's answer:
 * the window goes on showing what it showed before the open.
 */
export type WindowLayout = 'pending' | 'pane' | 'swap'

/**
 * Pending until main has answered the open (`undefined` in a browser counts
 * as an answer). Then pane when the window, or the width main answered it
 * will grow to, clears `thresholdPx` (the caller's
 * `WINDOW_PANEL_PAIR_MIN_PX`). Waiting for the answer and counting it are
 * what keep a window that is about to grow from showing the swap, even for a
 * frame.
 */
export function resolveWindowLayout({
  windowWidth,
  pending = false,
  answeredWidth,
  thresholdPx,
}: {
  windowWidth: number
  pending?: boolean
  answeredWidth?: number
  thresholdPx: number
}): WindowLayout {
  if (pending) return 'pending'
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
