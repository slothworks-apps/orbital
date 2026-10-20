/**
 * Updating a member of the group from the phone (spec
 * 2026-10-19-headless-server-design § The phone). The phone asks the member
 * itself, through its own channel to it: `machine` routes the request there
 * (`GroupFederation`). A member whose hello names a version below
 * `MAC_FEATURES.serverUpdate` does not have the routes and is never asked:
 * these answer null for it.
 */
import type {
  ServerUpdateCancelRefusal, ServerUpdateRefusal, ServerUpdateState, UpdateWhen,
} from '@orbital/shared/remote/serverUpdate'
import { api } from '../lib/api'
import { deviceSupports } from './version'

/** The member's update state, or null when it does not serve the route. */
export async function readDeviceUpdate(deviceId: string): Promise<ServerUpdateState | null> {
  if (!deviceSupports('serverUpdate', deviceId)) return null
  return api.serverUpdate(deviceId)
}

/** Starts the member's update, now or once its sessions finish; null when it does not serve the route. */
export async function startDeviceUpdate(
  deviceId: string, when: UpdateWhen = 'now',
): Promise<{ ok: true; state: ServerUpdateState } | { ok: false; error: ServerUpdateRefusal } | null> {
  if (!deviceSupports('serverUpdate', deviceId)) return null
  return api.startServerUpdate(deviceId, when)
}

/** Ends the member's wait for its sessions; null when it does not serve the route. */
export async function cancelDeviceUpdate(
  deviceId: string,
): Promise<{ ok: true; state: ServerUpdateState } | { ok: false; error: ServerUpdateCancelRefusal } | null> {
  if (!deviceSupports('serverUpdate', deviceId)) return null
  return api.cancelServerUpdate(deviceId)
}
