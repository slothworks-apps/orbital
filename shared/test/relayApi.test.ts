import { describe, it, expect } from 'vitest';
import { generateIdentity, deviceId, fromBase64Url, toBase64Url } from '../src/remote/keys.js';
import {
  DeviceToRelay, PAIRING_SECRET_BYTES, PAIR_NAME_MAX_CHARS, PAIR_PLATFORM_MAX_CHARS, QrPayload, RelayToDevice,
  SEALED_DEVICE_MAX_CHARS, SIGNED_REQUEST_SKEW_MS, authSignature, canonicalJson, openPairingDevice, pairingProof,
  relayWsUrl, sealPairingDevice, signRequest, verifyAuthSignature, verifyPairingProof, verifyRequest,
} from '../src/remote/relayApi.js';

describe('sealed pairing device', () => {
  const secret = () => crypto.getRandomValues(new Uint8Array(PAIRING_SECRET_BYTES));
  const device = { name: 'Pixel 8', platform: 'Android 15' };

  it('opens with the secret and phone key it was sealed for', () => {
    const s = secret();
    const phone = generateIdentity().publicKey;
    const sealed = sealPairingDevice(s, phone, device);
    expect(sealed).not.toContain('Pixel');
    expect(openPairingDevice(s, phone, sealed)).toEqual(device);
  });

  it('opens with no other secret and for no other phone key', () => {
    const s = secret();
    const phone = generateIdentity().publicKey;
    const sealed = sealPairingDevice(s, phone, device);
    expect(openPairingDevice(secret(), phone, sealed)).toBeNull();
    // A relay replaying the blob beside a key of its own gets nothing.
    expect(openPairingDevice(s, generateIdentity().publicKey, sealed)).toBeNull();
  });

  it('refuses a tampered, truncated or oversize blob', () => {
    const s = secret();
    const phone = generateIdentity().publicKey;
    const bytes = fromBase64Url(sealPairingDevice(s, phone, device));
    bytes[bytes.length - 1] ^= 1;
    expect(openPairingDevice(s, phone, toBase64Url(bytes))).toBeNull();
    expect(openPairingDevice(s, phone, toBase64Url(bytes.slice(0, 30)))).toBeNull();
    expect(openPairingDevice(s, phone, '')).toBeNull();
    expect(openPairingDevice(s, phone, 'A'.repeat(SEALED_DEVICE_MAX_CHARS + 1))).toBeNull();
  });

  it('stays within the size the relay accepts at the longest name and platform', () => {
    const s = secret();
    const phone = generateIdentity().publicKey;
    // Control characters are what JSON spells longest.
    const worst = { name: '\u0001'.repeat(PAIR_NAME_MAX_CHARS + 10), platform: '\u0001'.repeat(PAIR_PLATFORM_MAX_CHARS + 10) };
    const sealed = sealPairingDevice(s, phone, worst);
    expect(sealed.length).toBeLessThanOrEqual(SEALED_DEVICE_MAX_CHARS);
    expect(openPairingDevice(s, phone, sealed)).toEqual({
      name: worst.name.slice(0, PAIR_NAME_MAX_CHARS), platform: worst.platform.slice(0, PAIR_PLATFORM_MAX_CHARS),
    });
  });
});

describe('pairing proof', () => {
  it('verifies for the secret and key it was made from, and for nothing else', () => {
    const secret = crypto.getRandomValues(new Uint8Array(PAIRING_SECRET_BYTES));
    const phone = generateIdentity().publicKey;
    const proof = pairingProof(secret, phone);
    expect(verifyPairingProof(secret, phone, proof)).toBe(true);
    expect(verifyPairingProof(secret, generateIdentity().publicKey, proof)).toBe(false);
    expect(verifyPairingProof(crypto.getRandomValues(new Uint8Array(PAIRING_SECRET_BYTES)), phone, proof)).toBe(false);
    expect(verifyPairingProof(secret, phone, proof.slice(0, -1))).toBe(false);
    expect(verifyPairingProof(secret, phone, '')).toBe(false);
  });
});

describe('signed requests', () => {
  const me = generateIdentity();
  it('verifies a fresh request and returns the signer', () => {
    const req = signRequest(me, 'pair.token', { name: 'studio' }, 1000);
    const res = verifyRequest(req, 'pair.token', 1000 + 5_000);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.id).toBe(deviceId(me.publicKey));
      expect(res.payload).toEqual({ name: 'studio' });
    }
  });
  it('rejects a stale timestamp, a wrong action, a tampered payload and junk', () => {
    const req = signRequest(me, 'pair.token', { name: 'studio' }, 1000);
    expect(verifyRequest(req, 'pair.token', 1000 + SIGNED_REQUEST_SKEW_MS + 1).ok).toBe(false);
    expect(verifyRequest(req, 'pair.revoke', 1000).ok).toBe(false);
    expect(verifyRequest({ ...req, payload: { name: 'other' } }, 'pair.token', 1000).ok).toBe(false);
    expect(verifyRequest({ pub: 'x' }, 'pair.token', 1000).ok).toBe(false);
    expect(verifyRequest(null, 'pair.token', 1000).ok).toBe(false);
  });
  it('carries the relay secret only when there is one, outside the signed bytes', () => {
    expect(signRequest(me, 'pair.token', { name: 'studio' }, 1000)).not.toHaveProperty('secret');
    expect(signRequest(me, 'pair.token', { name: 'studio' }, 1000, '')).not.toHaveProperty('secret');
    const req = signRequest(me, 'pair.token', { name: 'studio' }, 1000, 'abcd1234');
    expect(req.secret).toBe('abcd1234');
    const res = verifyRequest(req, 'pair.token', 1000);
    expect(res.ok && res.secret).toBe('abcd1234');
    const bare = verifyRequest(signRequest(me, 'pair.token', { name: 'studio' }, 1000), 'pair.token', 1000);
    expect(bare.ok && bare.secret).toBeNull();
    // Swapping the secret leaves the signature valid: the secret is not what it covers.
    expect(verifyRequest({ ...req, secret: 'other' }, 'pair.token', 1000).ok).toBe(true);
  });
  it('canonical json sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }))
      .toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it('canonical json matches what a JSON round trip produces', () => {
    expect(canonicalJson({ a: [1, undefined, 3], b: undefined })).toBe('{"a":[1,null,3]}');
    expect(canonicalJson(JSON.parse(JSON.stringify({ a: [1, undefined, 3] }))))
      .toBe(canonicalJson({ a: [1, undefined, 3] }));
  });
});

describe('auth signature', () => {
  it('binds the nonce', () => {
    const me = generateIdentity();
    const sig = authSignature(me, 'n1');
    expect(verifyAuthSignature(me.publicKey, 'n1', sig)).toBe(true);
    expect(verifyAuthSignature(me.publicKey, 'n2', sig)).toBe(false);
    expect(verifyAuthSignature(me.publicKey, 'n1', 'not-base64url!')).toBe(false);
  });
});

describe('schemas and urls', () => {
  it('parses control messages both ways', () => {
    expect(RelayToDevice.safeParse({ type: 'challenge', nonce: 'abc' }).success).toBe(true);
    expect(RelayToDevice.safeParse({ type: 'presence', peer: 'p', online: true }).success).toBe(true);
    expect(DeviceToRelay.safeParse({ type: 'auth', pub: 'p', sig: 's' }).success).toBe(true);
    expect(DeviceToRelay.safeParse({ type: 'push_token', token: 't' }).success).toBe(true);
    expect(DeviceToRelay.safeParse({ type: 'auth' }).success).toBe(false);
  });
  it('QR payload is versioned', () => {
    expect(QrPayload.safeParse({ v: 1, relay: 'https://r', mac: 'm', name: 'studio', token: 't', secret: 's' }).success).toBe(true);
    expect(QrPayload.safeParse({ v: 2, relay: 'https://r', mac: 'm', name: 'studio', token: 't', secret: 's' }).success).toBe(false);
  });
  it('keeps the optional relay secret on auth and in the QR', () => {
    expect(DeviceToRelay.parse({ type: 'auth', pub: 'p', sig: 's', secret: 'k' })).toMatchObject({ secret: 'k' });
    expect(QrPayload.parse({ v: 1, relay: 'https://r', mac: 'm', name: 'studio', token: 't', secret: 's', relaySecret: 'k' }))
      .toMatchObject({ relaySecret: 'k' });
  });
  it('derives the websocket url from the http one and anchors it to the Mac', () => {
    expect(relayWsUrl('https://orbital-relay.example', 'm1')).toBe('wss://orbital-relay.example/ws?mac=m1');
    expect(relayWsUrl('http://127.0.0.1:5555/?x=1', 'm1')).toBe('ws://127.0.0.1:5555/ws?mac=m1');
  });
  it('adds paired=1 only when asked', () => {
    expect(relayWsUrl('https://orbital-relay.example', 'm1', { paired: true })).toBe('wss://orbital-relay.example/ws?mac=m1&paired=1');
    expect(relayWsUrl('https://orbital-relay.example', 'm1', { paired: false })).toBe('wss://orbital-relay.example/ws?mac=m1');
  });
});
