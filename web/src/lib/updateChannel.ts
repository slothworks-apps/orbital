import { compareVersions } from '@orbital/shared/remote/version'
import { UPDATE_CHANNEL_KEY, parseUpdateChannel, type UpdateChannel } from '@orbital/shared/updateChannel'

/**
 * Experimental updates, as the web app reads and says them (spec
 * 2026-11-02-experimental-release-channel-design; canvas `Feature -
 * Experimental updates`): the group's `update_channel`, and the status line
 * under the switch in Settings › Updates. The switch is a regular setting,
 * off by default — not part of Settings › Experimental.
 */

export { UPDATE_CHANNEL_KEY, type UpdateChannel }
export { experimentalUpdatesWords } from '@orbital/shared/updateChannel'

/** What the switch saves: on is the exact word the Mac, a server and the phone follow; off anything else. */
export const CHANNEL_EXPERIMENTAL = 'experimental'
export const CHANNEL_STABLE = 'stable'

type Settings = Record<string, string | undefined>

/** `experimental` gets every release before everyone else; absent or anything else is stable. */
export function updateChannel(settings: Settings): UpdateChannel {
  return parseUpdateChannel(settings[UPDATE_CHANNEL_KEY])
}

export function experimentalUpdatesOn(settings: Settings): boolean {
  return updateChannel(settings) === 'experimental'
}

/**
 * Whether this Mac still runs a version above the newest regular release,
 * as after the group turned experimental off (1h TURNED OFF · STILL AHEAD).
 * Unknown — no check on stable yet — is not ahead: the line waits for one.
 */
export function stillAhead(installed: string, latestRegular: string | null | undefined): boolean {
  return !!latestRegular && compareVersions(installed, latestRegular) > 0
}

/**
 * When and where `update_channel` last changed, from `GET
 * /api/settings/:key/stamp`. `at` is null when the change is not known
 * (a value from before the group stamped it); `origin` is the device id it
 * was changed on, null for this device.
 */
export type SettingStamp = { at: number | null; origin: string | null }

/** The name of the device a stamp came from: this device's when `origin` is null or its own id; null when it is not in the group. */
export function stampOriginName(
  origin: string | null,
  members: readonly { id: string; name: string; self?: boolean }[],
): string | null {
  const m = origin === null ? members.find((x) => x.self) : members.find((x) => x.id === origin)
  return m?.name ?? null
}

/** `28 Oct`, the canvas's day. */
export function stampDay(at: number): string {
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/**
 * The mono line under the switch (canvas 1h), or null for none:
 *
 * - on, in a group: `on · turned on from studio-mbp, 28 Oct`; alone: `on since 28 Oct`.
 *   Whatever of the device and the day is not known is left out. Nothing
 *   while the stamp is still being read (`stamp` undefined).
 * - off, while this Mac still runs ahead of the regular release: which version
 *   the group (or this Mac) stays on until the regular release reaches it.
 * - off otherwise: none, as before the feature.
 */
export function channelStatusLine({
  on,
  inGroup,
  stamp,
  originName,
  installed,
  latestRegular,
  day = stampDay,
}: {
  on: boolean
  inGroup: boolean
  stamp: SettingStamp | null | undefined
  originName: string | null
  installed: string
  latestRegular: string | null | undefined
  day?: (at: number) => string
}): string | null {
  if (!on) {
    if (!stillAhead(installed, latestRegular)) return null
    return `off · ${inGroup ? 'the group stays' : 'this Mac stays'} on ${installed} until the regular release reaches it`
  }
  if (stamp === undefined) return null
  const at = stamp?.at ?? null
  if (inGroup && originName) return `on · turned on from ${originName}${at !== null ? `, ${day(at)}` : ''}`
  return at !== null ? `on since ${day(at)}` : 'on'
}
