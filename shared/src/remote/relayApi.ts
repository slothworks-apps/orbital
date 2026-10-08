/**
 * How a device talks to the relay itself: signed HTTP requests for pairing,
 * and the JSON control messages on the WebSocket (text frames). Data frames
 * are binary and live in `frame.ts`; the relay never confuses the two
 * (spec 2026-09-30-mobile-remote-design § 2).
 */
import { z } from 'zod';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, deviceId, fromBase64Url, publicKeyOf, sign, toBase64Url, verify, type Identity } from './keys.js';

/** How far a signed request's timestamp may sit from the relay's clock. */
export const SIGNED_REQUEST_SKEW_MS = 60_000;
/** How long a pairing QR is good for (9e: "code expires in 1:48"). */
export const PAIRING_TOKEN_TTL_MS = 120_000;
/** Relay → device ping cadence; a device that misses three is gone. */
export const RELAY_PING_INTERVAL_MS = 15_000;
/**
 * The WebSocket close code a relay with `RELAY_SECRET` set answers a missing
 * or wrong secret with (ADR the-relay-takes-a-shared-secret). A device that
 * hears it stops reconnecting: the secret will not change on its own.
 */
export const CLOSE_BAD_SECRET = 4003;

export function canonicalJson(value: unknown): string {
  // Match what a JSON round trip produces: `undefined` inside an array
  // becomes `null` (object properties are still dropped below, same as
  // `JSON.stringify`), so a signature over the canonical form still
  // verifies after the payload has crossed the wire as JSON.
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * `secret` is the relay's shared secret, sent beside the signature rather
 * than under it: whoever holds it can sign for themselves anyway, and TLS
 * covers it in transit. Absent when the device has none (an open relay).
 */
export type SignedRequest<T = unknown> = { pub: string; ts: number; payload: T; sig: string; secret?: string };

/** The `action` strings the relay's pairing routes accept (see the table above). */
export type RelayAction = 'pair.token' | 'pair.redeem' | 'pair.confirm' | 'pair.revoke';

function signedBytes(action: string, ts: number, payload: unknown): Uint8Array {
  return new TextEncoder().encode(`orbital-relay\n${action}\n${ts}\n${canonicalJson(payload)}`);
}

export function signRequest<T>(
  identity: Identity, action: RelayAction, payload: T, now = Date.now(), secret?: string,
): SignedRequest<T> {
  const req: SignedRequest<T> = {
    pub: deviceId(identity.publicKey),
    ts: now,
    payload,
    sig: toBase64Url(sign(identity.secretKey, signedBytes(action, now, payload))),
  };
  if (secret) req.secret = secret;
  return req;
}

const SignedRequestSchema = z.object({
  pub: z.string(), ts: z.number().int(), payload: z.unknown(), sig: z.string(), secret: z.string().optional(),
});

export type Verified =
  | { ok: true; id: string; publicKey: Uint8Array; payload: unknown; secret: string | null }
  | { ok: false; reason: 'malformed' | 'bad_key' | 'stale' | 'bad_signature' };

export function verifyRequest(raw: unknown, action: RelayAction, now: number): Verified {
  const parsed = SignedRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  const { pub, ts, payload, sig, secret } = parsed.data;
  const publicKey = publicKeyOf(pub);
  if (!publicKey) return { ok: false, reason: 'bad_key' };
  if (Math.abs(now - ts) > SIGNED_REQUEST_SKEW_MS) return { ok: false, reason: 'stale' };
  let signature: Uint8Array;
  try {
    signature = fromBase64Url(sig);
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!verify(publicKey, signedBytes(action, ts, payload), signature)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, id: pub, publicKey, payload, secret: secret ?? null };
}

const AUTH_PREFIX = 'orbital-relay-auth\n';

export function authSignature(identity: Identity, nonce: string): string {
  return toBase64Url(sign(identity.secretKey, new TextEncoder().encode(AUTH_PREFIX + nonce)));
}

export function verifyAuthSignature(publicKey: Uint8Array, nonce: string, sig: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(sig)) return false;
  return verify(publicKey, new TextEncoder().encode(AUTH_PREFIX + nonce), fromBase64Url(sig));
}

export const RelayToDevice = z.discriminatedUnion('type', [
  // `version`: the relay's own (`relay/package.json`); a relay from before it announced one sends none.
  z.object({ type: z.literal('challenge'), nonce: z.string(), version: z.string().optional() }),
  z.object({ type: z.literal('ok'), peers: z.array(z.string()) }),
  z.object({ type: z.literal('presence'), peer: z.string(), online: z.boolean() }),
  // `device`: the phone's name and platform, sealed (`sealPairingDevice`); absent from a phone that predates it.
  // `name` and `platform` are always empty from a relay that knows no names, and kept only for a Mac that requires them.
  z.object({
    type: z.literal('pair_request'), phone: z.string(), proof: z.string(), device: z.string().optional(),
    name: z.string().optional(), platform: z.string().optional(),
  }),
  // `name`: as `pair_request`'s, empty and kept only for a phone that requires it; the QR names the Mac.
  z.object({ type: z.literal('paired'), mac: z.string(), name: z.string().optional() }),
  z.object({ type: z.literal('rejected'), mac: z.string() }),
  z.object({ type: z.literal('unpaired'), mac: z.string() }),
  z.object({ type: z.literal('error'), code: z.string() }),
]);
export type RelayToDevice = z.infer<typeof RelayToDevice>;

export const DeviceToRelay = z.discriminatedUnion('type', [
  // `secret`: the relay's shared secret, when the device has one (see `CLOSE_BAD_SECRET`).
  z.object({ type: z.literal('auth'), pub: z.string(), sig: z.string(), secret: z.string().optional() }),
  z.object({ type: z.literal('push_token'), token: z.string() }),
]);
export type DeviceToRelay = z.infer<typeof DeviceToRelay>;

/**
 * What the Mac encodes into the pairing QR (9e). `secret` never reaches the
 * relay: the phone proves with it that the key it redeems with is the one
 * that scanned this QR (`pairingProof`). `relaySecret` is a different thing:
 * the relay's shared secret, which the phone stores with the pairing and
 * presents on every connect; absent when the relay is open.
 */
export const QrPayload = z.object({
  v: z.literal(1), relay: z.string(), mac: z.string(), name: z.string(), token: z.string(), secret: z.string(),
  relaySecret: z.string().optional(),
});
export type QrPayload = z.infer<typeof QrPayload>;

/** Bytes of the QR's `secret`, made fresh on the Mac for every pairing code. */
export const PAIRING_SECRET_BYTES = 16;

/**
 * The fingerprint is 30 bits, short enough that a relay could grind a key
 * of its own to match it; this commitment is what actually binds the phone's
 * key to the QR. The relay forwards it but cannot compute one for any other
 * key, since the secret travelled only through the camera.
 */
export function pairingProof(secret: Uint8Array, phonePublicKey: Uint8Array): string {
  return toBase64Url(hmac(sha256, secret, phonePublicKey));
}

export function verifyPairingProof(secret: Uint8Array, phonePublicKey: Uint8Array, proof: string): boolean {
  const expected = pairingProof(secret, phonePublicKey);
  if (proof.length !== expected.length) return false;
  // Constant time over the whole string: a proof is a MAC, compare it as one.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ proof.charCodeAt(i);
  return diff === 0;
}

/** The longest phone name and platform a pairing carries; longer ones are cut, not refused. */
export const PAIR_NAME_MAX_CHARS = 80;
export const PAIR_PLATFORM_MAX_CHARS = 20;
/**
 * The longest sealed device (`sealPairingDevice`) the relay takes, in
 * base64url characters: room for the longest name and platform even when
 * JSON escapes every character, with the nonce and the tag.
 */
export const SEALED_DEVICE_MAX_CHARS = 1024;
/** HKDF info for the key that seals the phone's name to the Mac; nothing else is keyed with it. */
export const PAIRING_DEVICE_INFO = new TextEncoder().encode('orbital-pairing-device-v1');
const SEALED_DEVICE_NONCE_BYTES = 24;
const SEALED_DEVICE_TAG_BYTES = 16;

/** What the phone tells the Mac about itself at pairing, for the confirmation (9o) and the paired list. */
export type PairingDevice = { name: string; platform: string };
const PairingDeviceSchema = z.object({
  name: z.string().max(PAIR_NAME_MAX_CHARS), platform: z.string().max(PAIR_PLATFORM_MAX_CHARS),
});

function pairingDeviceKey(secret: Uint8Array): Uint8Array {
  return hkdf(sha256, secret, undefined, PAIRING_DEVICE_INFO, 32);
}

/**
 * The phone's name and platform, sealed so only the Mac that showed the QR
 * reads them: XChaCha20-Poly1305 under a key from the QR's `secret`, with
 * the phone's public key as associated data so the relay cannot pass the
 * blob off beside another key (spec 2026-10-08-relay-knows-no-names-design).
 * Wire form: base64url of nonce ‖ ciphertext.
 */
export function sealPairingDevice(secret: Uint8Array, phonePublicKey: Uint8Array, device: PairingDevice): string {
  const plain = new TextEncoder().encode(JSON.stringify({
    name: device.name.slice(0, PAIR_NAME_MAX_CHARS), platform: device.platform.slice(0, PAIR_PLATFORM_MAX_CHARS),
  }));
  const nonce = randomBytes(SEALED_DEVICE_NONCE_BYTES);
  const sealed = xchacha20poly1305(pairingDeviceKey(secret), nonce, phonePublicKey).encrypt(plain);
  return toBase64Url(concat(nonce, sealed));
}

/** Null for anything that does not open as a device sealed for this secret and phone key. Never throws. */
export function openPairingDevice(secret: Uint8Array, phonePublicKey: Uint8Array, sealed: string): PairingDevice | null {
  if (sealed.length > SEALED_DEVICE_MAX_CHARS) return null;
  const bytes = fromBase64Url(sealed);
  if (bytes.length < SEALED_DEVICE_NONCE_BYTES + SEALED_DEVICE_TAG_BYTES) return null;
  try {
    const plain = xchacha20poly1305(pairingDeviceKey(secret), bytes.subarray(0, SEALED_DEVICE_NONCE_BYTES), phonePublicKey)
      .decrypt(bytes.subarray(SEALED_DEVICE_NONCE_BYTES));
    const parsed = PairingDeviceSchema.safeParse(JSON.parse(new TextDecoder().decode(plain)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * `mac` is the pair's anchor: the Mac sends its own id, the phone the id
 * from the QR. A load balancer in front of several relays hashes on it so
 * both halves of a pair land on one instance (runbook `run-the-relay`). One
 * instance needs nothing of the kind.
 *
 * `paired` says the device believes it is paired with that Mac, so the relay
 * answers `unpaired` on connect when it is not (relay/src/ws.ts). A phone
 * that is only about to pair leaves it off.
 */
export function relayWsUrl(httpUrl: string, mac: string, opts: { paired?: boolean } = {}): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.searchParams.set('mac', mac);
  if (opts.paired) url.searchParams.set('paired', '1');
  return url.toString();
}
