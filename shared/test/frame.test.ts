import { describe, it, expect } from 'vitest';
import {
  FLAG_STATE, FLAG_WAKE, FRAME_HEADER_BYTES, MAX_FRAME_BYTES, ZERO_WAKE,
  decodeFrame, encodeFrame, rewritePeer,
} from '../src/remote/frame.js';

const peer = new Uint8Array(32).fill(7);
const other = new Uint8Array(32).fill(9);
const wake = new Uint8Array(16).fill(3);

describe('outer frame', () => {
  it('round-trips header and body', () => {
    const body = new Uint8Array([1, 2, 3]);
    const buf = encodeFrame({ peer, flags: FLAG_WAKE | FLAG_STATE, wake, body });
    expect(buf.length).toBe(FRAME_HEADER_BYTES + 3);
    const back = decodeFrame(buf)!;
    expect(back.peer).toEqual(peer);
    expect(back.flags).toBe(FLAG_WAKE | FLAG_STATE);
    expect(back.wake).toEqual(wake);
    expect(back.body).toEqual(body);
  });
  it('allows an empty body (a wake frame is header only)', () => {
    const buf = encodeFrame({ peer, flags: FLAG_WAKE, wake, body: new Uint8Array(0) });
    expect(decodeFrame(buf)!.body.length).toBe(0);
  });
  it('rejects a short buffer, a wrong version and an oversized frame', () => {
    expect(decodeFrame(new Uint8Array(FRAME_HEADER_BYTES - 1))).toBeNull();
    const buf = encodeFrame({ peer, flags: 0, wake: ZERO_WAKE, body: new Uint8Array(1) });
    buf[0] = 2;
    expect(decodeFrame(buf)).toBeNull();
    expect(() => encodeFrame({ peer, flags: 0, wake: ZERO_WAKE, body: new Uint8Array(MAX_FRAME_BYTES) }))
      .toThrow(/MAX_FRAME_BYTES/);
    expect(decodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1))).toBeNull();
  });
  it('rewrites the peer in place without touching the rest', () => {
    const body = new Uint8Array([5, 5]);
    const buf = encodeFrame({ peer, flags: FLAG_STATE, wake, body });
    rewritePeer(buf, other);
    const back = decodeFrame(buf)!;
    expect(back.peer).toEqual(other);
    expect(back.flags).toBe(FLAG_STATE);
    expect(back.wake).toEqual(wake);
    expect(back.body).toEqual(body);
  });
});
