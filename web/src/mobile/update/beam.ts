/**
 * The phone's own word to Beam (spec 2026-10-09-phone-ota-updates-design →
 * Decisions, "Stats at level 2"): one `device_info` event per start, which
 * adds the device model to what the plugin reports itself. Beam's address
 * and the app's id come from mobile/beam.json (vite.mobile.config.ts); the
 * rest of Beam's contract is scripts/beam.mjs.
 */

export const DEVICE_INFO_ACTION = 'device_info'

/** The plugin's stats endpoint, which the plugin's own events go to as well. */
export function statsUrl(beamUrl: string): string {
  return `${beamUrl.replace(/\/+$/, '')}/api/stats`
}

export interface DeviceInfo {
  appId: string
  /** The plugin's random install id (`getDeviceId`), the one its own events carry. */
  deviceId: string
  platform: string
  osVersion: string
  /** The running bundle's version as the plugin names it (`builtin` for the one in the shell). */
  bundleVersion: string
  /** The shell's native version. */
  nativeVersion: string
  model: string
}

/** The event as Beam takes it: the plugin's field names, plus `device_model`. */
export function deviceInfoEvent(info: DeviceInfo): Record<string, string> {
  return {
    app_id: info.appId,
    action: DEVICE_INFO_ACTION,
    device_id: info.deviceId,
    platform: info.platform,
    version_os: info.osVersion,
    version_name: info.bundleVersion,
    version_build: info.nativeVersion,
    device_model: info.model,
  }
}
