import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { generateIdentity, concat, sign } from '../src/remote/keys.js';
import { CONTEXT, HANDSHAKE_BYTES, startHandshake } from '../src/remote/handshake.js';

function pair() {
  const phone = generateIdentity();
  const mac = generateIdentity();
  const a = startHandshake(phone, mac.publicKey, 'initiator');
  const b = startHandshake(mac, phone.publicKey, 'responder');
  // The responder needs the initiator's message before it has one of its own.
  const cb = b.complete(a.message!)!;
  const ca = a.complete(b.message!)!;
  return { phone, mac, a, b, ca, cb };
}

describe('handshake', () => {
  it('derives matching keys in both directions', () => {
    const { a, ca, cb } = pair();
    expect(a.message).toHaveLength(HANDSHAKE_BYTES);
    const msg = new TextEncoder().encode('up');
    expect(cb.open(ca.seal(msg))).toEqual(msg);
    const down = new TextEncoder().encode('down');
    expect(ca.open(cb.seal(down))).toEqual(down);
  });
  it('a message sealed for one direction does not open in the other', () => {
    const { ca, cb } = pair();
    const sealed = ca.seal(new Uint8Array([1]));
    expect(ca.open(sealed)).toBeNull();
    expect(cb.open(sealed)).not.toBeNull();
  });
  it('rejects a handshake message signed by the wrong identity', () => {
    const phone = generateIdentity();
    const mac = generateIdentity();
    const stranger = generateIdentity();
    const a1 = startHandshake(phone, mac.publicKey, 'initiator');
    // "stranger" plays the responder but signs with the wrong identity; phone
    // expects mac's public key, so the signature check must fail.
    const wrong = startHandshake(stranger, phone.publicKey, 'responder');
    wrong.complete(a1.message!);
    expect(a1.complete(wrong.message!)).toBeNull();

    // complete() is single-use, so a fresh handshake is needed to test the
    // length check independently of the assertion above.
    const a2 = startHandshake(phone, mac.publicKey, 'initiator');
    expect(a2.complete(new Uint8Array(HANDSHAKE_BYTES - 1))).toBeNull();
  });
  it('rejects a responder reply signed over only its own ephemeral, missing the initiator-freshness binding', () => {
    const phone = generateIdentity();
    const mac = generateIdentity();
    const a = startHandshake(phone, mac.publicKey, 'initiator');
    const macEph = x25519.keygen();
    // Old (pre-fix) signature shape: CONTEXT ‖ ownEph only, no initiator eph.
    const badReply = concat(macEph.publicKey, sign(mac.secretKey, concat(CONTEXT, macEph.publicKey)));
    expect(a.complete(badReply)).toBeNull();
  });
  it('complete() is single-use: a second call returns null without reusing the ephemeral secret', () => {
    const phone = generateIdentity();
    const mac = generateIdentity();
    const a = startHandshake(phone, mac.publicKey, 'initiator');
    const b = startHandshake(mac, phone.publicKey, 'responder');
    expect(b.complete(a.message!)).not.toBeNull();
    expect(b.complete(a.message!)).toBeNull();
  });
  it('open rejects a counter that does not advance (replay) and a tampered body', () => {
    const { ca, cb } = pair();
    const first = ca.seal(new Uint8Array([1]));
    const second = ca.seal(new Uint8Array([2]));
    expect(cb.open(second)).toEqual(new Uint8Array([2]));
    expect(cb.open(first)).toBeNull();
    const third = ca.seal(new Uint8Array([3]));
    third[third.length - 1] ^= 1;
    expect(cb.open(third)).toBeNull();
  });
  it('opening the same sealed body twice succeeds once, then fails', () => {
    const { ca, cb } = pair();
    const sealed = ca.seal(new Uint8Array([7]));
    expect(cb.open(sealed)).toEqual(new Uint8Array([7]));
    expect(cb.open(sealed)).toBeNull();
  });
  it('a lost frame does not break the stream (counters may skip forward)', () => {
    const { ca, cb } = pair();
    ca.seal(new Uint8Array([1]));
    const kept = ca.seal(new Uint8Array([2]));
    expect(cb.open(kept)).toEqual(new Uint8Array([2]));
  });
  it('a rejected replay and a tampered body do not break later frames', () => {
    const { ca, cb } = pair();
    const first = ca.seal(new Uint8Array([1]));
    expect(cb.open(first)).toEqual(new Uint8Array([1]));
    expect(cb.open(first)).toBeNull(); // replay rejected

    const tampered = ca.seal(new Uint8Array([2]));
    tampered[tampered.length - 1] ^= 1;
    expect(cb.open(tampered)).toBeNull(); // tampered body rejected

    const fresh = ca.seal(new Uint8Array([3]));
    expect(cb.open(fresh)).toEqual(new Uint8Array([3]));
  });
});
