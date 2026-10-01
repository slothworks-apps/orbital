/**
 * One identity per device — a Mac or a phone — and the derived names the rest
 * of the protocol uses for it. Ed25519 only: the per-connection X25519 keys
 * are ephemeral and live in `handshake.ts`, so nothing long-lived here ever
 * encrypts anything (spec 2026-09-30-mobile-remote-design § 1, as amended by
 * the backend plan).
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

export type Identity = { secretKey: Uint8Array; publicKey: Uint8Array };

export const PUBLIC_KEY_BYTES = 32;
export const SECRET_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

export function generateIdentity(): Identity {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey, publicKey };
}

export function identityFromSecret(secretKey: Uint8Array): Identity {
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, secretKey);
}

export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Pure base64url rather than `Buffer`: this file also runs in the phone's
// WebView, where Node globals do not exist (eslint forbids them in shared/).
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_VALUE = new Map<string, number>([
  ...[...B64URL].map((c, i): [string, number] => [c, i]),
  // Node's decoder, which this replaced, takes the standard alphabet's two too.
  ['+', 62], ['/', 63],
]);

/** Unpadded base64url. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[n >>> 18] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[n >>> 18] + B64URL[(n >>> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[n >>> 18] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63];
  }
  return out;
}

/**
 * As lenient as `Buffer.from(text, 'base64url')`, which this replaced:
 * unknown characters are skipped, `=` ends the input, and trailing bits
 * that do not make a whole byte are dropped. Never throws; a caller that
 * needs the one canonical spelling checks the round trip (`publicKeyOf`).
 */
export function fromBase64Url(text: string): Uint8Array {
  const out = new Uint8Array(Math.ceil((text.length * 3) / 4));
  let len = 0;
  let acc = 0;
  let bits = 0;
  for (const c of text) {
    if (c === '=') break;
    const v = B64_VALUE.get(c);
    if (v === undefined) continue;
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[len++] = (acc >>> bits) & 0xff;
    }
  }
  return out.slice(0, len);
}

/** The device's name on the wire and in every table: its public key, base64url. */
export function deviceId(publicKey: Uint8Array): string {
  return toBase64Url(publicKey);
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** The inverse of `deviceId`; null for anything that is not exactly one key. */
export function publicKeyOf(id: string): Uint8Array | null {
  if (!DEVICE_ID_RE.test(id)) return null;
  const bytes = fromBase64Url(id);
  if (bytes.length !== PUBLIC_KEY_BYTES) return null;
  // Base64url packs 32 bytes into 43 characters with 2 spare bits in the
  // last one; a decoder that ignores them accepts several strings for the
  // same key. A device id must be the one canonical encoding of its key.
  if (toBase64Url(bytes) !== id) return null;
  return bytes;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Six characters both screens show during pairing (9e, 9o). Symmetric in its
 * arguments so neither side has to know which it is; 30 bits of the hash of
 * both keys, which is enough to catch a relay that swapped one of them.
 */
export function fingerprint(a: Uint8Array, b: Uint8Array): string {
  const [lo, hi] = compare(a, b) <= 0 ? [a, b] : [b, a];
  const digest = sha256(concat(lo, hi));
  const bits = (digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3];
  let out = '';
  for (let i = 0; i < 6; i++) out += CROCKFORD[(bits >>> (27 - i * 5)) & 31];
  return out;
}

export function formatFingerprint(fp: string): string {
  return `${fp.slice(0, 3)}-${fp.slice(3)}`;
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
