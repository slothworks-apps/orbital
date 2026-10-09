import { compareVersions } from '@orbital/shared/remote/version'

/** The phone's view of version compatibility lives in shared, beside the Mac's and the relay's. */
export { MIN_SERVER_VERSION, compareVersions, isSupportedServer } from '@orbital/shared/remote/version'

/**
 * What the phone uses that only a newer Mac serves, and the first Orbital
 * release on the Mac that serves it (adr `a-phone-feature-waits-for-the-mac-that-serves-it`).
 * `MIN_SERVER_VERSION` is the floor the whole app needs; a feature above it
 * goes here instead, and the phone leaves it out against an older Mac rather
 * than asking and waiting for an answer that never comes.
 */
export const MAC_FEATURES = {
  /** Session media: `GET /api/sessions/:id/media` and `file_get` as `pdf` (spec 2026-10-09-session-media-design). */
  media: '0.26.0',
} as const

export type MacFeature = keyof typeof MAC_FEATURES

/** Whether the Mac that said hello serves `feature`. False before any hello: nothing is asked of a Mac not yet known. */
export function macSupports(feature: MacFeature, macVersion: string | null): boolean {
  return macVersion !== null && compareVersions(macVersion, MAC_FEATURES[feature]) >= 0
}
