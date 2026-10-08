/**
 * What every demo page shares, beside the fake server (`fake/`).
 */

/**
 * What the composer says in every demo instead of taking a message (spec
 * 2026-10-08-landing-site-design § What the visitor can do). Handed to
 * `ComposerLockContext`, which locks the field and shows this in its place.
 */
export const COMPOSER_LOCKED = "In the app, you'd type here"

/**
 * `?poster=1`: the image script (`site/scripts/demo-images.mjs`) is taking
 * this page's still. The scenario then holds its first beat — the one each
 * scenario opens on, written to be the picture of the demo — rather than
 * moving on while the shot is taken.
 */
export function isPosterRun(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get('poster') === '1'
}

/** Two frames: the first lays out what was just rendered, the second is drawn with it. */
export function afterTwoFrames(then: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(then))
}
