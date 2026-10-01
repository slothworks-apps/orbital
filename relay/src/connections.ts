import type { WebSocket } from 'ws';
import type { RelayToDevice } from '@orbital/shared/remote/relayApi';

/** Past this much unsent data on the target, the source stops being read. */
export const MAX_BUFFERED_BYTES = 4194304;
/** State frames kept for an offline device; older ones fall off the front. */
export const OFFLINE_QUEUE_MAX = 32;
/** Offline devices with a queue at all; the least recently pushed one is dropped past it. */
export const OFFLINE_QUEUE_MAX_DEVICES = 1024;

/**
 * `peers` is the pair table for this device, cached at attach and kept
 * current by the pairing routes: routing a frame reads it synchronously, so
 * frames from one socket are forwarded in the order they arrived — an
 * awaited store lookup per frame could reorder them, and the receiver's
 * cipher counter treats a reordered frame as a replay.
 */
export type Conn = { socket: WebSocket; id: string; peers: Set<string> };

export class Connections {
  private byId = new Map<string, Conn>();

  add(conn: Conn): Conn | undefined {
    const previous = this.byId.get(conn.id);
    this.byId.set(conn.id, conn);
    return previous;
  }

  /** Removes only if this socket is still the one registered. */
  remove(conn: Conn): boolean {
    if (this.byId.get(conn.id)?.socket !== conn.socket) return false;
    this.byId.delete(conn.id);
    return true;
  }

  get(id: string): Conn | undefined {
    return this.byId.get(id);
  }

  isOnline(id: string): boolean {
    return this.byId.has(id);
  }

  sendControl(id: string, msg: RelayToDevice): boolean {
    const conn = this.byId.get(id);
    if (!conn) return false;
    try {
      conn.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
}

export class OfflineQueue {
  private byId = new Map<string, Uint8Array[]>();

  push(id: string, frame: Uint8Array): void {
    let q = this.byId.get(id);
    if (q) {
      // Re-inserted so the Map's insertion order stays "least recently pushed first".
      this.byId.delete(id);
    } else {
      q = [];
      if (this.byId.size >= OFFLINE_QUEUE_MAX_DEVICES) {
        const oldest = this.byId.keys().next().value;
        if (oldest !== undefined) this.byId.delete(oldest);
      }
    }
    this.byId.set(id, q);
    q.push(frame);
    if (q.length > OFFLINE_QUEUE_MAX) q.splice(0, q.length - OFFLINE_QUEUE_MAX);
  }

  drain(id: string): Uint8Array[] {
    const q = this.byId.get(id) ?? [];
    this.byId.delete(id);
    return q;
  }
}
