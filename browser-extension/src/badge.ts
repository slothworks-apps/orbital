/**
 * The outcome badge's timing on the toolbar icon (canvas 64h): in, hold,
 * out, opacity only. Pure, so the frames are tested without a browser.
 */

export const BADGE_IN_MS = 120
export const BADGE_HOLD_MS = 4_000
export const BADGE_OUT_MS = 260

/** Steps drawn for each fade; a toolbar icon needs only a few. */
const IN_STEPS = 3
const OUT_STEPS = 5

export interface BadgeFrame {
  /** Ms after the badge was shown. */
  at: number
  opacity: number
}

/**
 * The icon images to draw for one badge, in order. The fade in ends on full
 * opacity at `BADGE_IN_MS`; the fade out ends on the resting icon (opacity 0)
 * exactly `BADGE_OUT_MS` after the hold.
 */
export function badgeFrames(): BadgeFrame[] {
  const frames: BadgeFrame[] = []
  for (let i = 1; i <= IN_STEPS; i++) {
    frames.push({ at: Math.round(((i - 1) / (IN_STEPS - 1)) * BADGE_IN_MS), opacity: i / IN_STEPS })
  }
  const outStart = BADGE_IN_MS + BADGE_HOLD_MS
  for (let i = 1; i <= OUT_STEPS; i++) {
    frames.push({
      at: outStart + Math.round(((i - 1) / (OUT_STEPS - 1)) * BADGE_OUT_MS),
      opacity: 1 - i / OUT_STEPS,
    })
  }
  return frames
}
