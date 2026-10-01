import { describe, it, expect } from 'vitest';
import {
  deviceId, fingerprint, formatFingerprint, fromBase64Url, generateIdentity, identityFromSecret,
  publicKeyOf, sign, toBase64Url, verify,
} from '../src/remote/keys.js';

describe('identity keys', () => {
  it('signs and verifies, and a changed message fails', () => {
    const me = generateIdentity();
    const msg = new TextEncoder().encode('hello');
    const sig = sign(me.secretKey, msg);
    expect(verify(me.publicKey, msg, sig)).toBe(true);
    expect(verify(me.publicKey, new TextEncoder().encode('hellp'), sig)).toBe(false);
    expect(verify(generateIdentity().publicKey, msg, sig)).toBe(false);
  });
  it('rebuilds the same public key from the secret', () => {
    const me = generateIdentity();
    expect(identityFromSecret(me.secretKey).publicKey).toEqual(me.publicKey);
  });
  it('round-trips a device id and rejects a malformed one', () => {
    const me = generateIdentity();
    const id = deviceId(me.publicKey);
    expect(id).toHaveLength(43);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(publicKeyOf(id)).toEqual(me.publicKey);
    expect(publicKeyOf('short')).toBeNull();
    expect(publicKeyOf(id + 'x')).toBeNull();
    expect(publicKeyOf(id.replace(/./, '/'))).toBeNull();

    // The last base64url character has 2 spare bits that play no part in the
    // decoded key, so another character sharing its top 4 bits decodes to
    // the same 32 bytes. A device id must be the one canonical string for
    // its key, so the altered spelling must be rejected even though it
    // carries the same bytes.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const lastIndex = ALPHABET.indexOf(id[id.length - 1]);
    const groupStart = Math.floor(lastIndex / 4) * 4;
    const altered = id.slice(0, -1) + ALPHABET[groupStart + ((lastIndex % 4) + 1) % 4];
    expect(publicKeyOf(altered)).toBeNull();
    expect(publicKeyOf(id)).toEqual(me.publicKey);
  });
  it('base64url matches Node\'s encoder and decoder byte for byte', () => {
    for (let len = 0; len <= 40; len++) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      const text = Buffer.from(bytes).toString('base64url');
      expect(toBase64Url(bytes)).toBe(text);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
    // Junk decodes the way Buffer decoded it: skipped characters, `=` ends it.
    for (const junk of ['QU!JD', 'QUJD=', 'Q', 'QU JD', 'QUJD+/', 'Q===', '!!!']) {
      expect(fromBase64Url(junk)).toEqual(new Uint8Array(Buffer.from(junk, 'base64url')));
    }
  });
  it('fingerprints are six Crockford characters, symmetric, and differ per pair', () => {
    const a = generateIdentity().publicKey;
    const b = generateIdentity().publicKey;
    const c = generateIdentity().publicKey;
    const fp = fingerprint(a, b);
    expect(fp).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(fingerprint(b, a)).toBe(fp);
    expect(fingerprint(a, c)).not.toBe(fp);
    expect(formatFingerprint(fp)).toBe(`${fp.slice(0, 3)}-${fp.slice(3)}`);
  });
});
