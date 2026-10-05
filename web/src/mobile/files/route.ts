import { hasTextExtension, isImagePath } from '../../lib/pathLinks'

/**
 * Which viewer a path opens in (spec 2026-10-05-mobile-next § 2, "By file
 * type"): an image the Mac serves, or a text type it previews. The same rule
 * that made the path a link (`isPressablePath`), so a path that reaches the
 * file screen always has an answer; `null` only for one that somehow did not
 * come from a link, which the screen shows as can't-be-shown.
 */
export type FileKind = 'image' | 'text'

export function fileKindOf(path: string): FileKind | null {
  if (isImagePath(path)) return 'image'
  if (hasTextExtension(path)) return 'text'
  return null
}

/**
 * The Mac's two answers that mean "this looked viewable but is not" (spec
 * § 2, Decision 8): 413 too large — text over the phone's cap, an image over
 * the Mac's — and 415 not an image, or binary where text was expected.
 */
export function isCantShowStatus(status: number): boolean {
  return status === 413 || status === 415
}
