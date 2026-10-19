/**
 * Updating a member of the group from the phone (spec
 * 2026-10-19-headless-server-design § The phone). The phone asks the member
 * itself, through its own channel to it: `machine` routes the request there
 * (`GroupFederation`). A member whose hello names a version below
 * `MAC_FEATURES.serverUpdate` does not have the routes and is never asked:
 * these answer null for it.
 */
import type { ServerUpdateRefusal, ServerUpdateState } from '@orbital/shared/remote/serverUpdate'
import { api } from '../lib/api'
import type { DeviceView } from './state'
import { deviceSupports } from './version'

/** The member's update state, or null when it does not serve the route. */
export async function readDeviceUpdate(deviceId: string, devices?: readonly DeviceView[]): Promise<ServerUpdateState | null> {
  if (!deviceSupports('serverUpdate', deviceId, devices)) return null
  return api.serverUpdate(deviceId)
}

/** Starts the member's update; null when it does not serve the route. */
export async function startDeviceUpdate(
  deviceId: string,
  devices?: readonly DeviceView[],
): Promise<{ ok: true; state: ServerUpdateState } | { ok: false; error: ServerUpdateRefusal } | null> {
  if (!deviceSupports('serverUpdate', deviceId, devices)) return null
  return api.startServerUpdate(deviceId)
}
