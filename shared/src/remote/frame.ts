/**
 * The one thing the relay reads. Fixed layout, no JSON, so the relay's hot
 * path is a few byte reads and one in-place write:
 *
 *   0                            version (FRAME_VERSION)
 *   1                            flags   (FLAG_WAKE | FLAG_STATE)
 *   PEER_OFFSET..+PEER_BYTES     peer    — the addressee when a device
 *                                sends, the sender once the relay has
 *                                forwarded (`rewritePeer`)
 *   WAKE_OFFSET..+WAKE_BYTES     wake    — an opaque per-session token the
 *                                relay may count, all zero when FLAG_WAKE
 *                                is clear
 *   FRAME_HEADER_BYTES..         body    — ciphertext the relay never
 *                                opens; may be empty
 *
 * (spec 2026-09-30-mobile-remote-design § 2 Routing, § 5 Push).
 */
export const FRAME_VERSION = 1;
export const PEER_BYTES = 32;
export const WAKE_BYTES = 16;
export const PEER_OFFSET = 2;
export const WAKE_OFFSET = PEER_OFFSET + PEER_BYTES;
export const FRAME_HEADER_BYTES = WAKE_OFFSET + WAKE_BYTES;
/** Ceiling on one WebSocket frame, relay and devices alike. */
export const MAX_FRAME_BYTES = 262144;

/** The relay should push if the addressee is offline. */
export const FLAG_WAKE = 1;
/** A state event, worth queueing briefly for an offline addressee. */
export const FLAG_STATE = 2;

export const ZERO_WAKE: Uint8Array = new Uint8Array(WAKE_BYTES);

export type Frame = { peer: Uint8Array; flags: number; wake: Uint8Array; body: Uint8Array };

export function encodeFrame(frame: Frame): Uint8Array {
  if (frame.peer.length !== PEER_BYTES) throw new Error('peer must be PEER_BYTES long');
  if (frame.wake.length !== WAKE_BYTES) throw new Error('wake must be WAKE_BYTES long');
  const total = FRAME_HEADER_BYTES + frame.body.length;
  if (total > MAX_FRAME_BYTES) throw new Error('frame exceeds MAX_FRAME_BYTES');
  const out = new Uint8Array(total);
  out[0] = FRAME_VERSION;
  out[1] = frame.flags & 0xff;
  out.set(frame.peer, PEER_OFFSET);
  out.set(frame.wake, WAKE_OFFSET);
  out.set(frame.body, FRAME_HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Uint8Array): Frame | null {
  if (buf.length < FRAME_HEADER_BYTES || buf.length > MAX_FRAME_BYTES) return null;
  if (buf[0] !== FRAME_VERSION) return null;
  return {
    flags: buf[1],
    peer: buf.subarray(PEER_OFFSET, WAKE_OFFSET),
    wake: buf.subarray(WAKE_OFFSET, FRAME_HEADER_BYTES),
    body: buf.subarray(FRAME_HEADER_BYTES),
  };
}

/** The relay's one write: "to" becomes "from" on the way through. */
export function rewritePeer(buf: Uint8Array, peer: Uint8Array): void {
  if (peer.length !== PEER_BYTES) throw new Error('peer must be PEER_BYTES long');
  buf.set(peer, PEER_OFFSET);
}
