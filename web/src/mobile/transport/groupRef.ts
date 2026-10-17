import type { GroupClient } from '@orbital/shared/remote/groupClient'
import { clientRef } from './clientRef'
import type { GroupFederation } from './groupFederation'

/** The phone's group as the app holds it: the client, the federation `clientRef` carries, and its storage. */
export interface GroupHandle {
  group: GroupClient
  federation: GroupFederation
  /** Writes the group after every change from now on, and once now (a join that just paired); resolves once written, rejects when the write failed. */
  persist(): Promise<void>
  /** Writes nothing more, and resolves once a write that runs is done: before the stored group goes. */
  close(): Promise<void>
}

let held: GroupHandle | null = null

/**
 * The group behind `clientRef`, for what needs more than a client: the
 * per-device state, joining, leaving. Only while its federation is still
 * the client: a Cancel on the pairing screen that drops the client drops
 * this too.
 */
export const groupRef = {
  get current(): GroupHandle | null {
    return held && clientRef.client === held.federation ? held : null
  },
  set(handle: GroupHandle | null): void {
    held = handle
    clientRef.set(handle?.federation ?? null)
  },
}
