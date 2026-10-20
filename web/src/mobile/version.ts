import { compareVersions } from '@orbital/shared/remote/version'
import { SERVER_UPDATE_VERSION } from '@orbital/shared/remote/serverUpdate'
import { useOrbital } from '../store/store'
import { useMobile, type DeviceView } from './state'
import { groupRef } from './transport/groupRef'

/** The phone's view of version compatibility lives in shared, beside the Mac's and the relay's. */
export { MIN_SERVER_VERSION, compareVersions, isSupportedServer } from '@orbital/shared/remote/version'

/**
 * What the phone uses that only a newer Mac serves, and the first Orbital
 * release on the Mac that serves it (adr `a-phone-feature-waits-for-the-mac-that-serves-it`).
 * `MIN_SERVER_VERSION` is the floor the whole app needs; a feature above it
 * goes here instead, and the phone leaves it out against an older Mac rather
 * than asking and waiting for an answer that never comes. Each device of the
 * group is judged by its own version.
 */
export const MAC_FEATURES = {
  /** Session media: `GET /api/sessions/:id/media` and `file_get` as `pdf` (spec 2026-10-09-session-media-design). */
  media: '0.26.0',
  /** New Session's missing-directory line and *Create and start*: `GET`/`POST /api/directory` (spec 2026-10-12-new-session-missing-directory-design). */
  directoryCheck: '0.29.0',
  /** Settings → Devices' version, update available, Update and updating per member: `GET`/`POST /api/server/update` (spec 2026-10-19-headless-server-design § The phone). */
  serverUpdate: SERVER_UPDATE_VERSION,
  /** `GET /api/limits` and `POST /api/limits/refresh` on the phone's allowlist: the Limits ring and screen (spec 2026-10-20-limit-suns-design § 5). */
  limitsRoutes: '0.34.0',
  /**
   * The `limits` topic to a paired device (spec 2026-10-20-limit-suns-design § 5). An older Mac drops the
   * subscription without a word; the Limits screen then reads on open and on Read again only.
   */
  limitsTopic: '0.37.0',
} as const

export type MacFeature = keyof typeof MAC_FEATURES

/** Whether a device running `version` serves `feature`. False before any hello: nothing is asked of a device not yet known. */
export function macSupports(feature: MacFeature, version: string | null): boolean {
  return version !== null && compareVersions(version, MAC_FEATURES[feature]) >= 0
}

/** Whether the device `deviceId` serves `feature`, by the version of its last hello. */
export function deviceSupports(
  feature: MacFeature,
  deviceId: string,
  devices: readonly DeviceView[] = useMobile.getState().devices,
): boolean {
  return macSupports(feature, devices.find((d) => d.id === deviceId)?.version ?? null)
}

/** Whether the device the app means when it means one (the default member) serves `feature`. */
export function defaultSupports(feature: MacFeature, macVersion: string | null = useMobile.getState().macVersion): boolean {
  return macSupports(feature, macVersion)
}

/** Whether any device of the group, or the default member, serves `feature`: something the phone shows once for all of them. */
export function anySupports(
  feature: MacFeature,
  devices: readonly Pick<DeviceView, 'version'>[] = useMobile.getState().devices,
  macVersion: string | null = useMobile.getState().macVersion,
): boolean {
  return devices.some((d) => macSupports(feature, d.version)) || macSupports(feature, macVersion)
}

/** Which device a session runs on: the one that listed it, else the one the session names; null when neither is known. */
export type OwnerOf = (sessionId: string) => string | null

const currentOwner: OwnerOf = (sessionId) =>
  groupRef.current?.federation.ownerOf(sessionId) ?? useOrbital.getState().sessions[sessionId]?.machine?.id ?? null

/**
 * Whether the device `sessionId` runs on serves `feature`. A session whose
 * device is not known yet, or no session, is judged by the default member.
 */
export function sessionSupports(feature: MacFeature, sessionId: string | null, ownerOf: OwnerOf = currentOwner): boolean {
  const owner = sessionId !== null ? ownerOf(sessionId) : null
  return owner !== null ? deviceSupports(feature, owner) : defaultSupports(feature)
}
