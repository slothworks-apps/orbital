/**
 * One ephemeral X25519 exchange per connection, each half signed by the
 * sender's identity so the relay — which sees both halves — cannot swap one.
 * The responder (the Mac) already holds the initiator's ephemeral key by the
 * time it replies, so its signature covers both ephemerals; that binds
 * freshness into the Mac's half too, where signing only its own key could
 * not. Keys are HKDF'd per direction, so a frame sealed by the phone can
 * never be replayed to the phone, and every body carries an explicit,
 * strictly increasing counter as its nonce
 * (spec 2026-09-30-mobile-remote-design § 1).
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { PUBLIC_KEY_BYTES, SIGNATURE_BYTES, concat, sign, verify, type Identity } from './keys.js';

export type Role = 'initiator' | 'responder';

/** Ephemeral public key followed by the identity's signature over it. */
export const HANDSHAKE_BYTES = PUBLIC_KEY_BYTES + SIGNATURE_BYTES;
export const NONCE_BYTES = 12;
/** AES-GCM's authentication tag, appended to every sealed body. */
export const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Domain separator for the signed handshake bytes; exported so tests can build a message by hand. */
export const CONTEXT = new TextEncoder().encode('orbital-remote-handshake-v1');
// hkdf's info is Uint8Array, not a string; encode the direction labels once.
const I2R_INFO = new TextEncoder().encode('initiator-to-responder');
const R2I_INFO = new TextEncoder().encode('responder-to-initiator');

export interface Handshake {
  /**
   * Phone (initiator): send `message`, then `complete(reply)`.
   * Mac (responder): `complete(first)`, then send `message`.
   * The responder's signature must cover the initiator's ephemeral key, so
   * its message cannot exist until `complete` has seen that key — `message`
   * is null until then, and is set on this same object once `complete`
   * succeeds.
   */
  message: Uint8Array | null;
  /** Null (and inert) on every call after the first — a handshake completes at most once. */
  complete(peerMessage: Uint8Array): SessionCipher | null;
}

export function startHandshake(identity: Identity, peerPublicKey: Uint8Array, role: Role): Handshake {
  const eph = x25519.keygen();
  let done = false;
  const handshake: Handshake = {
    message:
      role === 'initiator'
        ? concat(eph.publicKey, sign(identity.secretKey, concat(CONTEXT, eph.publicKey)))
        : null,
    complete(peerMessage) {
      // A second call must not re-derive keys from the same ephemeral
      // secret with a counter that restarts at 0 — that would be nonce
      // reuse under AES-GCM. Set the flag before any other check so every
      // later call is inert, success or failure alike.
      if (done) return null;
      done = true;
      if (peerMessage.length !== HANDSHAKE_BYTES) return null;
      const peerEph = peerMessage.subarray(0, PUBLIC_KEY_BYTES);
      const sig = peerMessage.subarray(PUBLIC_KEY_BYTES);
      // The responder signs its own ephemeral plus the initiator's, so each
      // side verifies a different byte string over the same two keys.
      const signedOver =
        role === 'initiator' ? concat(CONTEXT, peerEph, eph.publicKey) : concat(CONTEXT, peerEph);
      if (!verify(peerPublicKey, signedOver, sig)) return null;
      let shared: Uint8Array;
      try {
        shared = x25519.getSharedSecret(eph.secretKey, peerEph);
      } catch {
        // A degenerate (e.g. low-order) peer key; never throw out of complete().
        return null;
      }
      // Salt binds the keys to the two identities, ordered so both sides agree.
      const [lo, hi] = lessOrEqual(identity.publicKey, peerPublicKey)
        ? [identity.publicKey, peerPublicKey]
        : [peerPublicKey, identity.publicKey];
      const salt = sha256(concat(lo, hi));
      const i2r = hkdf(sha256, shared, salt, I2R_INFO, KEY_BYTES);
      const r2i = hkdf(sha256, shared, salt, R2I_INFO, KEY_BYTES);
      if (role === 'responder') {
        handshake.message = concat(
          eph.publicKey,
          sign(identity.secretKey, concat(CONTEXT, eph.publicKey, peerEph)),
        );
      }
      return role === 'initiator' ? new SessionCipher(i2r, r2i) : new SessionCipher(r2i, i2r);
    },
  };
  return handshake;
}

export class SessionCipher {
  private sendCounter = 0n;
  private lastReceived = -1n;

  constructor(private readonly sendKey: Uint8Array, private readonly recvKey: Uint8Array) {}

  /** nonce (NONCE_BYTES, a big-endian counter) followed by ciphertext + tag. */
  seal(plain: Uint8Array): Uint8Array {
    const counter = this.sendCounter++;
    const nonce = nonceFor(counter);
    return concat(nonce, gcm(this.sendKey, nonce).encrypt(plain));
  }

  /** Null for a short body, a counter at or below the last one, or a bad tag. */
  open(body: Uint8Array): Uint8Array | null {
    if (body.length < NONCE_BYTES) return null;
    const nonce = body.subarray(0, NONCE_BYTES);
    const counter = counterOf(nonce);
    if (counter <= this.lastReceived) return null;
    try {
      const plain = gcm(this.recvKey, nonce).decrypt(body.subarray(NONCE_BYTES));
      this.lastReceived = counter;
      return plain;
    } catch {
      return null;
    }
  }
}

function nonceFor(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  new DataView(nonce.buffer).setBigUint64(NONCE_BYTES - 8, counter);
  return nonce;
}

function counterOf(nonce: Uint8Array): bigint {
  return new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength).getBigUint64(NONCE_BYTES - 8);
}

function lessOrEqual(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true;
}
