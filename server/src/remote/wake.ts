import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, type Identity } from '@orbital/shared/remote/keys';
import { WAKE_BYTES } from '@orbital/shared/remote/frame';

/** Derived once from the identity so it survives restarts without a file of its own. */
export function wakeSecret(identity: Identity): Uint8Array {
  return sha256(concat(identity.secretKey, new TextEncoder().encode('orbital-wake')));
}

/**
 * What the relay sees in a wake frame: enough to count distinct sessions,
 * not enough to name one (spec 2026-09-30-mobile-remote-design § 2 Push).
 */
export function wakeToken(secret: Uint8Array, sessionId: string): Uint8Array {
  return hmac(sha256, secret, new TextEncoder().encode(sessionId)).slice(0, WAKE_BYTES);
}
