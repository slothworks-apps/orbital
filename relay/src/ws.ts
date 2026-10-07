/**
 * One socket's life on the relay: challenge, auth, then binary frames routed
 * within pairs and text frames read as control. The body of a binary frame
 * is never looked at (spec 2026-09-30-mobile-remote-design § 2).
 */
import { randomBytes } from 'node:crypto';
import type { RawData, WebSocket } from 'ws';
import { deviceId, publicKeyOf } from '@orbital/shared/remote/keys';
import { FLAG_STATE, FLAG_WAKE, decodeFrame, rewritePeer } from '@orbital/shared/remote/frame';
import {
  CLOSE_BAD_SECRET, DeviceToRelay, RELAY_PING_INTERVAL_MS, verifyAuthSignature, type RelayToDevice,
} from '@orbital/shared/remote/relayApi';
import { secretMatches } from './secret.js';
import { RELAY_VERSION } from './version.js';
import { Connections, MAX_BUFFERED_BYTES, OfflineQueue, type Conn } from './connections.js';
import { log, short } from './log.js';
import type { WakeTracker } from './push.js';
import type { RelayStore } from './store.js';

export const AUTH_TIMEOUT_MS = 10_000;
const BACKPRESSURE_POLL_MS = 50;
const MISSED_PINGS_TO_DROP = 3;

export type WakeHook = (from: string, to: string, wake: Uint8Array) => void | Promise<void>;

export type WsContext = {
  store: RelayStore;
  connections: Connections;
  queue: OfflineQueue;
  tracker: WakeTracker;
  onWake: WakeHook;
  now: () => number;
  pingIntervalMs: number;
  /** The relay's shared secret; null when the relay is open. Never logged. */
  secret: string | null;
};

export function handleSocket(socket: WebSocket, ctx: WsContext, expectMac: string | null): void {
  const nonce = randomBytes(16).toString('base64url');
  send(socket, { type: 'challenge', nonce, version: RELAY_VERSION });
  const authTimer = setTimeout(() => socket.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);

  socket.once('message', (raw, isBinary) => {
    clearTimeout(authTimer);
    const parsed = isBinary ? null : DeviceToRelay.safeParse(safeJson(raw));
    if (!parsed?.success || parsed.data.type !== 'auth') return socket.close(4001, 'auth required');
    const { pub, sig } = parsed.data;
    const publicKey = publicKeyOf(pub);
    if (!publicKey || !verifyAuthSignature(publicKey, nonce, sig)) return socket.close(4001, 'bad auth');
    if (ctx.secret !== null && !secretMatches(ctx.secret, parsed.data.secret)) {
      log(`device ${short(pub)} refused: bad secret`);
      return socket.close(CLOSE_BAD_SECRET, 'bad secret');
    }
    // Pausing stops further reads while the store answers, but ws still emits
    // messages it already parsed from the read that carried `auth`; those are
    // held here, in order, and replayed by `attach`.
    const early: [RawData, boolean][] = [];
    const hold = (data: RawData, binary: boolean) => { early.push([data, binary]); };
    socket.on('message', hold);
    socket.pause();
    void (async () => {
      // A device the relay has never met may still connect — a phone has to
      // be online to hear `paired` — but gets no row for it: any key can
      // sign a challenge, so only `/pair/redeem` (a phone) and `/pair/token`
      // (a Mac) create one. Until then it has no peers, and `touch` and a
      // push token update nothing.
      const peers = new Set(await ctx.store.peersOf(pub));
      await ctx.store.touch(pub, ctx.now());
      if (socket.readyState !== socket.OPEN) return;
      socket.off('message', hold);
      attach({ socket, id: pub, peers }, ctx, early, expectMac);
    })().catch(() => socket.close(1011, 'store error'));
  });
}

function attach(conn: Conn, ctx: WsContext, early: [RawData, boolean][], expectMac: string | null): void {
  const { socket, id, peers } = conn;
  const previous = ctx.connections.add(conn);
  // One socket per device: the predecessor is replaced outright, since a
  // closing handshake would leave it routing frames until the peer answers.
  previous?.socket.terminate();
  // A phone that came online has seen everything pending for it.
  ctx.tracker.clear(id);
  log(`device ${short(id)} connected${previous ? ', replacing its previous socket' : ''}`);

  send(socket, { type: 'ok', peers: [...peers].filter((p) => ctx.connections.isOnline(p)) });
  // A device that expects a pair the relay no longer holds would otherwise
  // read its Mac as asleep forever: `ok` lists only online peers, and the
  // `unpaired` sent at revoke time went to a socket that did not exist.
  if (expectMac !== null && !peers.has(expectMac)) send(socket, { type: 'unpaired', mac: expectMac });
  for (const p of peers) ctx.connections.sendControl(p, { type: 'presence', peer: id, online: true });
  for (const frame of ctx.queue.drain(id)) socket.send(frame);

  const onMessage = (raw: RawData, isBinary: boolean) => {
    if (isBinary) return route(conn, toBytes(raw), ctx);
    const parsed = DeviceToRelay.safeParse(safeJson(raw));
    if (!parsed.success) return;
    if (parsed.data.type === 'push_token') {
      settle(ctx.store.setPushToken(id, parsed.data.token), 'push token not stored');
    }
  };
  socket.on('message', onMessage);
  for (const [raw, isBinary] of early) onMessage(raw, isBinary);
  socket.resume();

  let missed = 0;
  const ping = setInterval(() => {
    if (missed >= MISSED_PINGS_TO_DROP) return socket.terminate();
    missed++;
    socket.ping();
  }, ctx.pingIntervalMs);
  socket.on('pong', () => { missed = 0; });

  socket.on('close', () => {
    clearInterval(ping);
    if (!ctx.connections.remove(conn)) return;
    log(`device ${short(id)} disconnected`);
    for (const p of peers) {
      ctx.connections.sendControl(p, { type: 'presence', peer: id, online: false });
    }
  });
}

function route(from: Conn, buf: Uint8Array, ctx: WsContext): void {
  const frame = decodeFrame(buf);
  if (!frame) return;
  const to = deviceId(frame.peer);
  if (!from.peers.has(to)) return;
  rewritePeer(buf, publicKeyOf(from.id)!);
  const target = ctx.connections.get(to);
  if (target) return forward(from.socket, target.socket, buf);
  if (frame.flags & FLAG_WAKE) {
    settle(Promise.resolve().then(() => ctx.onWake(from.id, to, new Uint8Array(frame.wake))), 'wake hook failed');
  }
  // Only a wake is worth keeping: a frame with content is sealed under the
  // session keys of the connection that just ended, and the phone's next
  // connection runs a fresh handshake, so a queued ciphertext could never
  // be decrypted. A wake's body is empty; what it says lives in the header.
  // A copy: `buf` is a view into ws's read buffer, which the queue would pin.
  if (frame.flags & FLAG_STATE && frame.body.length === 0) ctx.queue.push(to, buf.slice());
}

/** A failing hook or store write is logged; it must never take the relay down. */
function settle(work: Promise<unknown>, what: string): void {
  work.catch((err) => console.warn(`relay: ${what}:`, err instanceof Error ? err.message : err));
}

/** Send, and if the target is far behind, stop reading the source until it drains. */
function forward(source: WebSocket, target: WebSocket, buf: Uint8Array): void {
  target.send(buf);
  if (target.bufferedAmount <= MAX_BUFFERED_BYTES) return;
  source.pause();
  const poll = setInterval(() => {
    if (target.readyState !== target.OPEN || target.bufferedAmount <= MAX_BUFFERED_BYTES) {
      clearInterval(poll);
      if (source.readyState === source.OPEN) source.resume();
    }
  }, BACKPRESSURE_POLL_MS);
}

function send(socket: WebSocket, msg: RelayToDevice): void {
  socket.send(JSON.stringify(msg));
}

function safeJson(raw: unknown): unknown {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function toBytes(raw: unknown): Uint8Array {
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) return new Uint8Array(Buffer.concat(raw as Buffer[]));
  return new Uint8Array(raw as ArrayBuffer);
}

export { RELAY_PING_INTERVAL_MS };
