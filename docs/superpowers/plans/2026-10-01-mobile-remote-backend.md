---
id: 2026-10-01-mobile-remote-backend
title: Mobile remote backend — relay, shared protocol and the Mac side
status: done
type: plan
domain: remote
related:
  - 2026-09-30-mobile-remote-design
  - 2026-09-22-ws-reconnect-resync-design
  - 2026-09-18-transcript-images-design
tags:
  - relay
  - server
  - security
  - mobile
---
# Mobile Remote Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone can pair with a Mac through a blind relay and then drive Orbital's existing API and hub topics over an end-to-end encrypted tunnel; this plan builds everything except the phone.

**Architecture:** Three pieces. `shared/` is a new workspace (`@orbital/shared`) holding the wire protocol both ends and the relay agree on: identity keys, the outer frame the relay reads, the handshake and cipher, the inner message schemas, the signed relay requests. `relay/` is a new Fastify + `ws` service for Dokploy that authenticates devices by signature, stores pairs, forwards binary frames between paired devices without parsing their bodies, and sends a generic push when a `wake` frame meets an offline phone. `server/src/remote/` is the Mac side: an outbound relay connection, pairing, a per-phone session that decrypts frames and feeds them to the existing `Hub` and to Fastify `inject()` behind an allowlist, and a per-device watcher that turns the desktop's notification rules into `wake` frames.

**Tech Stack:** TypeScript, Fastify 5, `ws` 8, `@fastify/websocket`, Kysely over better-sqlite3 and pg (relay), drizzle (server), zod 4, `@noble/curves` 2, `@noble/hashes` 2, `@noble/ciphers` 2, vitest, esbuild, Docker.

**Spec:** `docs/superpowers/specs/2026-09-30-mobile-remote-design.md`

## Global Constraints

- The relay never parses a frame body. It reads the 50-byte clear header only (`FRAME_HEADER_BYTES`), and rewrites the peer field from "to" to "from" before forwarding.
- Every device identity is one Ed25519 key pair. Per connection, both sides run an ephemeral X25519 exchange signed by those identities; keys are derived with HKDF-SHA256 into one AES-256-GCM key per direction. No static X25519 key exists (the spec's § 1 is amended by this plan: one identity pair, ephemeral session keys).
- Cryptography comes from `@noble/curves`, `@noble/hashes`, `@noble/ciphers` at major 2, imported with `.js` suffixes (`@noble/curves/ed25519.js`). No WebCrypto, no `node:crypto` for the protocol itself (`node:crypto` is allowed for randomness and for the relay's FCM JWT).
- Text WebSocket frames are relay control messages (JSON, zod-validated). Binary WebSocket frames are device-to-device data. The relay forwards binary and never forwards text.
- Caps, by name: `MAX_FRAME_BYTES` 262144, `BLOB_CHUNK_BYTES` 65536, `MAX_BUFFERED_BYTES` 4194304, `OFFLINE_QUEUE_MAX` 32, `PAIRING_TOKEN_TTL_MS` 120000, `SIGNED_REQUEST_SKEW_MS` 60000, `PROTOCOL_VERSION` 1. Refer to them by name in code and comments, never restate the number.
- The Mac never listens for inbound connections. The local port stays on `127.0.0.1`; the remote path is an outbound WebSocket only.
- The allowlist in `server/src/remote/allowlist.ts` is a literal list of method + path templates. `/api/files`, `/api/files/complete`, `/api/commands/content`, every `/api/sessions/:id/ide/*`, `/api/settings`, `/api/dev/*`, `/api/errors`, `/api/tag-rules*`, `/api/attachments` (multipart; blobs go through `blob_put`) are denied.
- Settings keys and defaults, seeded in `DEFAULT_SETTINGS`: `remote_enabled` `'false'`, `remote_relay_url` `''` (empty means `DEFAULT_RELAY_URL`), `remote_mac_name` `''` (empty means `os.hostname()` without a trailing `.local`).
- `DEFAULT_RELAY_URL` is `https://orbital-relay.slothworks.io`. The hostname is the plan's choice, not yet confirmed; it is one constant and changing it is one line.
- The relay's store is Kysely over one table description, with migrations in `relay/migrations` run at boot; SQLite (tests, a laptop) and Postgres (`RELAY_DATABASE_URL`, every real deployment) share every query. No raw SQL in the relay beyond `sql`1``. The relay runs as one instance; devices connect to `/ws?mac=<id>` so a hashing load balancer can later pin a pair to one instance without a protocol change. No cross-instance forwarding is built (decided 2026-10-01).
- Server code style: semicolons, single quotes, two-space indent, comments that say why. Relay and shared follow the same style. Prettier (`.prettierrc`) governs the rest.
- Tests only where the project's CLAUDE.md says they earn their place: codecs, crypto, allowlist, routes, the relay's routing and caps, and one end-to-end run. No tests for glue.
- Documents in English; `atlas validate` passes before every commit. Stage only the files this plan names — other sessions edit the same checkout.
- Work happens on a branch (`feat/mobile-remote-backend`) in a worktree; the plan ends with a PR, not a merge.

## Review Focus

1. **A frame from a device that is not paired with the addressee** — the relay must drop it silently and not disconnect either side; an attacker who knows a device id learns nothing. Pinned in Task 7 (`forwards only within a pair`).
2. **A replayed data frame** — the same encrypted body sent twice (by the relay, by a bug) must be rejected by the receiver's strictly increasing counter, never decrypted twice. Pinned in Task 3 (`open rejects a counter that does not advance`).
3. **A phone sending an `http` message for a path outside the allowlist with a query string or a trailing slash** (`/api/files?path=..`, `/api/settings/`) — the allowlist must match on the path without the query and without a trailing slash, and deny. Pinned in Task 12.
4. **A pairing token redeemed twice, or after `PAIRING_TOKEN_TTL_MS`** — the second redeem and the late redeem both answer 404; no second `pair_request` reaches the Mac. Pinned in Task 8.
5. **A `wake` frame for a phone that is connected** — the relay must forward, not push; a connected phone notifies itself with content. Pinned in Task 9 (`does not push when the target is online`).

---

## Task map

Tasks 1–5 build `shared/` and are sequential. After Task 5, the relay (6–9) and the Mac side (10–15) depend only on `shared/` and can run in parallel. Task 16 joins them; Task 17 is documents and the PR.

```
1 scaffold+keys → 2 frame → 3 handshake+cipher → 4 inner messages → 5 relay api
                                                                    ├─ relay: 6 store → 7 ws routing → 8 pairing → 9 push
                                                                    └─ server: 10 identity+devices → 11 notifier moves → 12 allowlist → 13 relay client → 14 phone session+watcher → 15 service+routes
16 end-to-end → 17 docs + PR
```

---

### Task 1: `shared/` workspace, identity keys and fingerprints

**Files:**
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/vitest.config.ts`
- Create: `shared/src/remote/keys.ts`
- Test: `shared/test/keys.test.ts`
- Modify: `package.json` (root; add the workspace and the scripts)
- Modify: `eslint.config.js` (add `shared/vitest.config.ts` to `allowDefaultProject`)

**Interfaces:**
- Consumes: nothing.
- Produces: `Identity`, `generateIdentity()`, `identityFromSecret(secretKey)`, `sign(secretKey, message)`, `verify(publicKey, message, signature)`, `deviceId(publicKey): string`, `publicKeyOf(id): Uint8Array | null`, `fingerprint(a, b): string`, `formatFingerprint(fp): string`, `toBase64Url`, `fromBase64Url`, `concat(...parts)`.

- [x] **Step 1: Create the workspace**

`shared/package.json`:

```json
{
  "name": "@orbital/shared",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "description": "What the Mac, the relay and the phone agree on: keys, frames, handshake, messages.",
  "exports": {
    "./*": "./src/*.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@noble/ciphers": "^2.0.0",
    "@noble/curves": "^2.0.0",
    "@noble/hashes": "^2.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`shared/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

Root `package.json`: add `"shared"` as the FIRST entry of `workspaces` (server and relay depend on it), and extend the scripts:

```json
"test": "npm test -w shared && npm test -w server && npm run test:run -w web && npm test -w desktop && npm test -w relay",
"typecheck": "npm run typecheck -w shared && npm run typecheck -w server && npm run typecheck -w web && npm run typecheck -w desktop && npm run typecheck -w relay",
```

(`relay` is added in Task 6; until then the two scripts fail on `-w relay`. Add the relay entries now anyway and run the workspace-scoped commands in the meantime — the root scripts are checked at the end of Task 6.)

`eslint.config.js`: add `'shared/vitest.config.ts'` and `'relay/vitest.config.ts'` to `allowDefaultProject`.

Run: `npm install`
Expected: `node_modules/@orbital/shared` is a symlink to `shared/`.

- [x] **Step 2: Write the failing test**

`shared/test/keys.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  deviceId, fingerprint, formatFingerprint, generateIdentity, identityFromSecret,
  publicKeyOf, sign, verify,
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
```

- [x] **Step 3: Run it to see it fail**

Run: `npm test -w shared`
Expected: FAIL, cannot find `../src/remote/keys.ts`.

- [x] **Step 4: Implement `keys.ts`**

```ts
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

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'));
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
  return bytes.length === PUBLIC_KEY_BYTES ? bytes : null;
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
```

If `ed25519.keygen` is not exported by the installed `@noble/curves`, open `node_modules/@noble/curves/ed25519.d.ts` and use the pair the file exports (`utils.randomSecretKey()` + `getPublicKey`); do not downgrade the package.

- [x] **Step 5: Run the tests and the typecheck**

Run: `npm test -w shared && npm run typecheck -w shared`
Expected: PASS, no type errors.

- [x] **Step 6: Commit**

```bash
git add shared package.json package-lock.json eslint.config.js
git commit -m "feat(shared): workspace with device identities and pairing fingerprints"
```

---

### Task 2: The outer frame the relay reads

**Files:**
- Create: `shared/src/remote/frame.ts`
- Test: `shared/test/frame.test.ts`

**Interfaces:**
- Consumes: `concat` from Task 1.
- Produces: `FRAME_VERSION`, `FRAME_HEADER_BYTES`, `MAX_FRAME_BYTES`, `FLAG_WAKE`, `FLAG_STATE`, `WAKE_BYTES`, `ZERO_WAKE`, `type Frame = { peer: Uint8Array; flags: number; wake: Uint8Array; body: Uint8Array }`, `encodeFrame(frame): Uint8Array`, `decodeFrame(buf): Frame | null`, `rewritePeer(buf, peer): void`.

- [x] **Step 1: Write the failing test**

`shared/test/frame.test.ts`:

```ts
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
```

- [x] **Step 2: Run it to see it fail**

Run: `npm test -w shared -- frame`
Expected: FAIL, module not found.

- [x] **Step 3: Implement `frame.ts`**

```ts
/**
 * The one thing the relay reads. Fixed layout, no JSON, so the relay's hot
 * path is a few byte reads and one in-place write:
 *
 *   0      version (FRAME_VERSION)
 *   1      flags   (FLAG_WAKE | FLAG_STATE)
 *   2..34  peer    — the addressee when a device sends, the sender once the
 *                    relay has forwarded (`rewritePeer`)
 *   34..50 wake    — an opaque per-session token the relay may count, all
 *                    zero when FLAG_WAKE is clear
 *   50..   body    — ciphertext the relay never opens; may be empty
 *
 * (spec 2026-09-30-mobile-remote-design § 2 Routing, § 5 Push).
 */
export const FRAME_VERSION = 1;
export const PEER_BYTES = 32;
export const WAKE_BYTES = 16;
export const FRAME_HEADER_BYTES = 2 + PEER_BYTES + WAKE_BYTES;
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
  out.set(frame.peer, 2);
  out.set(frame.wake, 2 + PEER_BYTES);
  out.set(frame.body, FRAME_HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Uint8Array): Frame | null {
  if (buf.length < FRAME_HEADER_BYTES || buf.length > MAX_FRAME_BYTES) return null;
  if (buf[0] !== FRAME_VERSION) return null;
  return {
    flags: buf[1],
    peer: buf.subarray(2, 2 + PEER_BYTES),
    wake: buf.subarray(2 + PEER_BYTES, FRAME_HEADER_BYTES),
    body: buf.subarray(FRAME_HEADER_BYTES),
  };
}

/** The relay's one write: "to" becomes "from" on the way through. */
export function rewritePeer(buf: Uint8Array, peer: Uint8Array): void {
  if (peer.length !== PEER_BYTES) throw new Error('peer must be PEER_BYTES long');
  buf.set(peer, 2);
}
```

- [x] **Step 4: Run the tests**

Run: `npm test -w shared`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add shared/src/remote/frame.ts shared/test/frame.test.ts
git commit -m "feat(shared): the outer frame the relay routes by"
```

---

### Task 3: Handshake and session cipher

**Files:**
- Create: `shared/src/remote/handshake.ts`
- Test: `shared/test/handshake.test.ts`

**Interfaces:**
- Consumes: `Identity`, `sign`, `verify`, `concat` from Task 1.
- Produces: `HANDSHAKE_BYTES` (96), `type Role = 'initiator' | 'responder'`, `startHandshake(identity, peerPublicKey, role): Handshake`, `interface Handshake { message: Uint8Array | null; complete(peerMessage: Uint8Array): SessionCipher | null }`, `class SessionCipher { seal(plain: Uint8Array): Uint8Array; open(body: Uint8Array): Uint8Array | null }`, `NONCE_BYTES` (12).

The phone is always the initiator, the Mac always the responder. The phone sends its handshake message as the body of a plain data frame (flags 0) as the first thing after the relay says `ok`; the Mac completes with it and only then has a `message` to send back. (Amended 2026-10-01 after the Task 3 review: the responder signs `CONTEXT ‖ ownEph ‖ initiatorEph`, so its half cannot exist before the initiator's arrived, and `complete` is single-use — a second call returns null. The code block below predates the amendment; the committed `shared/src/remote/handshake.ts` is the reference.)

- [x] **Step 1: Write the failing test**

`shared/test/handshake.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateIdentity } from '../src/remote/keys.js';
import { HANDSHAKE_BYTES, startHandshake } from '../src/remote/handshake.js';

function pair() {
  const phone = generateIdentity();
  const mac = generateIdentity();
  const a = startHandshake(phone, mac.publicKey, 'initiator');
  const b = startHandshake(mac, phone.publicKey, 'responder');
  const ca = a.complete(b.message)!;
  const cb = b.complete(a.message)!;
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
    const a = startHandshake(phone, mac.publicKey, 'initiator');
    const wrong = startHandshake(stranger, phone.publicKey, 'responder');
    expect(a.complete(wrong.message)).toBeNull();
    expect(a.complete(new Uint8Array(HANDSHAKE_BYTES - 1))).toBeNull();
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
  it('a lost frame does not break the stream (counters may skip forward)', () => {
    const { ca, cb } = pair();
    ca.seal(new Uint8Array([1]));
    const kept = ca.seal(new Uint8Array([2]));
    expect(cb.open(kept)).toEqual(new Uint8Array([2]));
  });
});
```

- [x] **Step 2: Run it to see it fail**

Run: `npm test -w shared -- handshake`
Expected: FAIL, module not found.

- [x] **Step 3: Implement `handshake.ts`**

```ts
/**
 * One ephemeral X25519 exchange per connection, each half signed by the
 * sender's identity so the relay — which sees both halves — cannot swap one.
 * Keys are HKDF'd per direction, so a frame sealed by the phone can never be
 * replayed to the phone, and every body carries an explicit, strictly
 * increasing counter as its nonce (spec 2026-09-30-mobile-remote-design § 1).
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
const KEY_BYTES = 32;
const CONTEXT = new TextEncoder().encode('orbital-remote-handshake-v1');

export interface Handshake {
  message: Uint8Array;
  complete(peerMessage: Uint8Array): SessionCipher | null;
}

export function startHandshake(identity: Identity, peerPublicKey: Uint8Array, role: Role): Handshake {
  const eph = x25519.keygen();
  const message = concat(eph.publicKey, sign(identity.secretKey, concat(CONTEXT, eph.publicKey)));
  return {
    message,
    complete(peerMessage) {
      if (peerMessage.length !== HANDSHAKE_BYTES) return null;
      const peerEph = peerMessage.subarray(0, PUBLIC_KEY_BYTES);
      const sig = peerMessage.subarray(PUBLIC_KEY_BYTES);
      if (!verify(peerPublicKey, concat(CONTEXT, peerEph), sig)) return null;
      const shared = x25519.getSharedSecret(eph.secretKey, peerEph);
      // Salt binds the keys to the two identities, ordered so both sides agree.
      const [lo, hi] = lessOrEqual(identity.publicKey, peerPublicKey)
        ? [identity.publicKey, peerPublicKey]
        : [peerPublicKey, identity.publicKey];
      const salt = sha256(concat(lo, hi));
      const i2r = hkdf(sha256, shared, salt, 'initiator-to-responder', KEY_BYTES);
      const r2i = hkdf(sha256, shared, salt, 'responder-to-initiator', KEY_BYTES);
      return role === 'initiator' ? new SessionCipher(i2r, r2i) : new SessionCipher(r2i, i2r);
    },
  };
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
```

- [x] **Step 4: Run the tests**

Run: `npm test -w shared`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add shared/src/remote/handshake.ts shared/test/handshake.test.ts
git commit -m "feat(shared): signed ephemeral handshake and per-direction session cipher"
```

---

### Task 4: Inner messages — what travels inside a sealed body

**Files:**
- Create: `shared/src/remote/messages.ts`
- Test: `shared/test/messages.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure codec + zod).
- Produces: `PROTOCOL_VERSION`, `BLOB_CHUNK_BYTES`, `type Inner = { kind: 'json'; value: unknown } | { kind: 'blob'; id: number; seq: number; last: boolean; bytes: Uint8Array }`, `encodeInner(m): Uint8Array`, `decodeInner(buf): Inner | null`, zod schemas `PhoneMessage` and `MacMessage` with inferred types, `NotificationSettingsSchema`, `type NotificationSettings`, `chunkBlob(id, bytes): Inner[]`.

Message vocabulary (the whole of it; nothing else goes through the tunnel):

| direction | `t` | fields | meaning |
|---|---|---|---|
| phone → Mac | `hello` | `protocol`, `app` | first message after the handshake |
| phone → Mac | `ws` | `type: 'subscribe' \| 'unsubscribe'`, `topic` | a hub control frame, verbatim |
| phone → Mac | `http` | `id`, `method`, `path`, `body?` | an allowlisted REST call |
| phone → Mac | `blob_get` | `id`, `ref` | fetch an image by ref; chunks follow on `id` |
| phone → Mac | `blob_put` | `id`, `mediaType`, `bytes` | an upload starts; chunks follow on `id` |
| phone → Mac | `notifications_get` | | this phone's five rows |
| phone → Mac | `notifications_set` | `settings` | replace them |
| phone → Mac | `seen` | `sessionId` | the phone opened it; clear the wake debounce |
| Mac → phone | `hello` | `protocol`, `server`, `macName` | accepted |
| Mac → phone | `bye` | `reason: 'protocol' \| 'revoked'` | and the Mac closes the session |
| Mac → phone | `ws` | `frame` | a hub frame, verbatim |
| Mac → phone | `http_res` | `id`, `status`, `body` | answer to `http` |
| Mac → phone | `blob_meta` | `id`, `status`, `bytes?`, `mediaType?` | answer to `blob_get`; chunks follow when `status` is 200 |
| Mac → phone | `blob_put_done` | `id`, `entry` (ImageRefEntry) or `error` | answer to a finished `blob_put` |
| Mac → phone | `notifications` | `settings` | answer to `notifications_get` / `_set` |

- [x] **Step 1: Write the failing test**

`shared/test/messages.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  BLOB_CHUNK_BYTES, MacMessage, PhoneMessage, chunkBlob, decodeInner, encodeInner,
} from '../src/remote/messages.js';

describe('inner codec', () => {
  it('round-trips a json message', () => {
    const m = { kind: 'json' as const, value: { t: 'hello', protocol: 1, app: 'orbital-mobile/0.1.0' } };
    expect(decodeInner(encodeInner(m))).toEqual(m);
  });
  it('round-trips a blob chunk', () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const m = { kind: 'blob' as const, id: 42, seq: 3, last: true, bytes };
    expect(decodeInner(encodeInner(m))).toEqual(m);
  });
  it('rejects an unknown kind, malformed json and a short blob header', () => {
    expect(decodeInner(new Uint8Array([2, 0]))).toBeNull();
    expect(decodeInner(new Uint8Array([0, 123]))).toBeNull();
    expect(decodeInner(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeInner(new Uint8Array(0))).toBeNull();
  });
  it('chunks a blob at BLOB_CHUNK_BYTES and marks the last one', () => {
    const bytes = new Uint8Array(BLOB_CHUNK_BYTES * 2 + 1).fill(1);
    const chunks = chunkBlob(7, bytes);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.kind === 'blob' && c.seq)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.kind === 'blob' && c.last)).toEqual([false, false, true]);
    expect(chunks[2].kind === 'blob' && chunks[2].bytes.length).toBe(1);
    expect(chunkBlob(1, new Uint8Array(0))).toEqual([
      { kind: 'blob', id: 1, seq: 0, last: true, bytes: new Uint8Array(0) },
    ]);
  });
});

describe('message schemas', () => {
  it('accepts every phone message and rejects an unknown one', () => {
    for (const m of [
      { t: 'hello', protocol: 1, app: 'x' },
      { t: 'ws', type: 'subscribe', topic: 'sessions' },
      { t: 'http', id: 1, method: 'GET', path: '/api/sessions' },
      { t: 'http', id: 2, method: 'POST', path: '/api/sessions/a/messages', body: { text: 'hi' } },
      { t: 'blob_get', id: 3, ref: 'a'.repeat(64) + '.png' },
      { t: 'blob_put', id: 4, mediaType: 'image/png', bytes: 10 },
      { t: 'notifications_get' },
      { t: 'notifications_set', settings: { needsInput: true, sessionEnded: false, sessionFailed: true, onlyWhenBackground: true, sound: false } },
      { t: 'seen', sessionId: 's1' },
    ]) expect(PhoneMessage.safeParse(m).success, JSON.stringify(m)).toBe(true);
    expect(PhoneMessage.safeParse({ t: 'nope' }).success).toBe(false);
    expect(PhoneMessage.safeParse({ t: 'http', id: 1, method: 'TRACE', path: '/' }).success).toBe(false);
  });
  it('accepts every mac message', () => {
    for (const m of [
      { t: 'hello', protocol: 1, server: '0.15.0', macName: 'studio' },
      { t: 'bye', reason: 'protocol' },
      { t: 'ws', frame: { topic: 'sessions', event: 'status' } },
      { t: 'http_res', id: 1, status: 200, body: [] },
      { t: 'blob_meta', id: 3, status: 404 },
      { t: 'blob_meta', id: 3, status: 200, bytes: 12, mediaType: 'image/png' },
      { t: 'blob_put_done', id: 4, entry: { ref: 'a'.repeat(64) + '.png', w: 1, h: 1, bytes: 10 } },
      { t: 'blob_put_done', id: 4, error: 'not_image' },
      { t: 'notifications', settings: { needsInput: true, sessionEnded: true, sessionFailed: true, onlyWhenBackground: true, sound: true } },
    ]) expect(MacMessage.safeParse(m).success, JSON.stringify(m)).toBe(true);
  });
});
```

- [x] **Step 2: Run it to see it fail**

Run: `npm test -w shared -- messages`
Expected: FAIL, module not found.

- [x] **Step 3: Implement `messages.ts`**

```ts
/**
 * Everything that travels inside a sealed frame body. Byte 0 picks the
 * kind: 0 is a JSON message, 1 is one chunk of a blob (an image going either
 * way). Blobs are chunked so a screenshot never holds the socket the
 * transcript shares (spec 2026-09-30-mobile-remote-design § 3 binary frame).
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const BLOB_CHUNK_BYTES = 65536;

export type Inner =
  | { kind: 'json'; value: unknown }
  | { kind: 'blob'; id: number; seq: number; last: boolean; bytes: Uint8Array };

const KIND_JSON = 0;
const KIND_BLOB = 1;
const BLOB_HEADER_BYTES = 1 + 4 + 4 + 1;

export function encodeInner(m: Inner): Uint8Array {
  if (m.kind === 'json') {
    const json = new TextEncoder().encode(JSON.stringify(m.value));
    const out = new Uint8Array(1 + json.length);
    out[0] = KIND_JSON;
    out.set(json, 1);
    return out;
  }
  const out = new Uint8Array(BLOB_HEADER_BYTES + m.bytes.length);
  const view = new DataView(out.buffer);
  out[0] = KIND_BLOB;
  view.setUint32(1, m.id);
  view.setUint32(5, m.seq);
  out[9] = m.last ? 1 : 0;
  out.set(m.bytes, BLOB_HEADER_BYTES);
  return out;
}

export function decodeInner(buf: Uint8Array): Inner | null {
  if (buf.length === 0) return null;
  if (buf[0] === KIND_JSON) {
    try {
      return { kind: 'json', value: JSON.parse(new TextDecoder().decode(buf.subarray(1))) };
    } catch {
      return null;
    }
  }
  if (buf[0] === KIND_BLOB) {
    if (buf.length < BLOB_HEADER_BYTES) return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return {
      kind: 'blob',
      id: view.getUint32(1),
      seq: view.getUint32(5),
      last: buf[9] === 1,
      bytes: buf.slice(BLOB_HEADER_BYTES),
    };
  }
  return null;
}

/** Always at least one chunk, so an empty blob still ends. */
export function chunkBlob(id: number, bytes: Uint8Array): Inner[] {
  const chunks: Inner[] = [];
  let seq = 0;
  for (let at = 0; at < bytes.length || seq === 0; at += BLOB_CHUNK_BYTES) {
    const end = Math.min(at + BLOB_CHUNK_BYTES, bytes.length);
    chunks.push({ kind: 'blob', id, seq, last: end >= bytes.length, bytes: bytes.slice(at, end) });
    seq++;
    if (end >= bytes.length) break;
  }
  return chunks;
}

export const NotificationSettingsSchema = z.object({
  needsInput: z.boolean(),
  sessionEnded: z.boolean(),
  sessionFailed: z.boolean(),
  onlyWhenBackground: z.boolean(),
  sound: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;

const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ImageRef = z.string().regex(/^[a-f0-9]{64}\.(png|jpg|gif|webp)$/);

export const PhoneMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), protocol: z.number().int(), app: z.string() }),
  z.object({ t: z.literal('ws'), type: z.enum(['subscribe', 'unsubscribe']), topic: z.string() }),
  z.object({
    t: z.literal('http'), id: z.number().int(), method: HttpMethod, path: z.string(),
    body: z.unknown().optional(),
  }),
  z.object({ t: z.literal('blob_get'), id: z.number().int(), ref: ImageRef }),
  z.object({
    t: z.literal('blob_put'), id: z.number().int(), mediaType: z.string(), bytes: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal('notifications_get') }),
  z.object({ t: z.literal('notifications_set'), settings: NotificationSettingsSchema }),
  z.object({ t: z.literal('seen'), sessionId: z.string() }),
]);
export type PhoneMessage = z.infer<typeof PhoneMessage>;

const ImageRefEntry = z.object({
  ref: ImageRef, w: z.number().nullable(), h: z.number().nullable(), bytes: z.number(),
});

export const MacMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), protocol: z.number().int(), server: z.string(), macName: z.string() }),
  z.object({ t: z.literal('bye'), reason: z.enum(['protocol', 'revoked']) }),
  z.object({ t: z.literal('ws'), frame: z.unknown() }),
  z.object({ t: z.literal('http_res'), id: z.number().int(), status: z.number().int(), body: z.unknown() }),
  z.object({
    t: z.literal('blob_meta'), id: z.number().int(), status: z.number().int(),
    bytes: z.number().int().optional(), mediaType: z.string().optional(),
  }),
  z.object({
    t: z.literal('blob_put_done'), id: z.number().int(),
    entry: ImageRefEntry.optional(), error: z.string().optional(),
  }),
  z.object({ t: z.literal('notifications'), settings: NotificationSettingsSchema }),
]);
export type MacMessage = z.infer<typeof MacMessage>;
```

- [x] **Step 4: Run the tests**

Run: `npm test -w shared`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add shared/src/remote/messages.ts shared/test/messages.test.ts
git commit -m "feat(shared): inner message codec and the tunnel vocabulary"
```

---

### Task 5: Relay API — signed requests, control messages, QR payload

**Files:**
- Create: `shared/src/remote/relayApi.ts`
- Test: `shared/test/relayApi.test.ts`

**Interfaces:**
- Consumes: `Identity`, `sign`, `verify`, `deviceId`, `publicKeyOf`, `toBase64Url`, `fromBase64Url` from Task 1.
- Produces: `DEFAULT_RELAY_URL`, `SIGNED_REQUEST_SKEW_MS`, `PAIRING_TOKEN_TTL_MS`, `RELAY_PING_INTERVAL_MS` (15000), `canonicalJson(value)`, `type SignedRequest`, `signRequest(identity, action, payload, now?)`, `verifyRequest(raw, action, now)`, `authSignature(identity, nonce)`, `verifyAuthSignature(publicKey, nonce, sig)`, `RelayToDevice` / `DeviceToRelay` zod schemas and types, `QrPayload` schema and type, `relayWsUrl(httpUrl, mac)`.

Relay HTTP endpoints (implemented in Task 8; named here because `action` strings are the contract):

| route | action | payload | answer |
|---|---|---|---|
| `POST /pair/token` | `pair.token` | `{ name }` (the Mac's display name) | `{ token, expiresAt }` |
| `POST /pair/redeem` | `pair.redeem` | `{ token, name, platform }` (signed by the phone) | `{ mac, name }` |
| `POST /pair/confirm` | `pair.confirm` | `{ phone, accept }` | `{ ok: true }` |
| `POST /pair/revoke` | `pair.revoke` | `{ phone }` | `{ ok: true }` |
| `GET /health` | — | — | `{ app: 'orbital-relay' }` |

- [x] **Step 1: Write the failing test**

`shared/test/relayApi.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateIdentity, deviceId } from '../src/remote/keys.js';
import {
  DeviceToRelay, QrPayload, RelayToDevice, SIGNED_REQUEST_SKEW_MS, authSignature, canonicalJson,
  relayWsUrl, signRequest, verifyAuthSignature, verifyRequest,
} from '../src/remote/relayApi.js';

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
  it('canonical json sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }))
      .toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
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
    expect(QrPayload.safeParse({ v: 1, relay: 'https://r', mac: 'm', name: 'studio', token: 't' }).success).toBe(true);
    expect(QrPayload.safeParse({ v: 2, relay: 'https://r', mac: 'm', name: 'studio', token: 't' }).success).toBe(false);
  });
  it('derives the websocket url from the http one and anchors it to the Mac', () => {
    expect(relayWsUrl('https://orbital-relay.example', 'm1')).toBe('wss://orbital-relay.example/ws?mac=m1');
    expect(relayWsUrl('http://127.0.0.1:5555/?x=1', 'm1')).toBe('ws://127.0.0.1:5555/ws?mac=m1');
  });
});
```

- [x] **Step 2: Run it to see it fail**

Run: `npm test -w shared -- relayApi`
Expected: FAIL, module not found.

- [x] **Step 3: Implement `relayApi.ts`**

```ts
/**
 * How a device talks to the relay itself: signed HTTP requests for pairing,
 * and the JSON control messages on the WebSocket (text frames). Data frames
 * are binary and live in `frame.ts`; the relay never confuses the two
 * (spec 2026-09-30-mobile-remote-design § 2).
 */
import { z } from 'zod';
import { deviceId, fromBase64Url, publicKeyOf, sign, toBase64Url, verify, type Identity } from './keys.js';

export const DEFAULT_RELAY_URL = 'https://orbital-relay.slothworks.io';
/** How far a signed request's timestamp may sit from the relay's clock. */
export const SIGNED_REQUEST_SKEW_MS = 60_000;
/** How long a pairing QR is good for (9e: "code expires in 1:48"). */
export const PAIRING_TOKEN_TTL_MS = 120_000;
/** Relay → device ping cadence; a device that misses three is gone. */
export const RELAY_PING_INTERVAL_MS = 15_000;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type SignedRequest<T = unknown> = { pub: string; ts: number; payload: T; sig: string };

function signedBytes(action: string, ts: number, payload: unknown): Uint8Array {
  return new TextEncoder().encode(`orbital-relay\n${action}\n${ts}\n${canonicalJson(payload)}`);
}

export function signRequest<T>(identity: Identity, action: string, payload: T, now = Date.now()): SignedRequest<T> {
  return {
    pub: deviceId(identity.publicKey),
    ts: now,
    payload,
    sig: toBase64Url(sign(identity.secretKey, signedBytes(action, now, payload))),
  };
}

const SignedRequestSchema = z.object({
  pub: z.string(), ts: z.number().int(), payload: z.unknown(), sig: z.string(),
});

export type Verified =
  | { ok: true; id: string; publicKey: Uint8Array; payload: unknown }
  | { ok: false; reason: 'malformed' | 'bad_key' | 'stale' | 'bad_signature' };

export function verifyRequest(raw: unknown, action: string, now: number): Verified {
  const parsed = SignedRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  const { pub, ts, payload, sig } = parsed.data;
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
  return { ok: true, id: pub, publicKey, payload };
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
  z.object({ type: z.literal('challenge'), nonce: z.string() }),
  z.object({ type: z.literal('ok'), peers: z.array(z.string()) }),
  z.object({ type: z.literal('presence'), peer: z.string(), online: z.boolean() }),
  z.object({ type: z.literal('pair_request'), phone: z.string(), name: z.string(), platform: z.string() }),
  z.object({ type: z.literal('paired'), mac: z.string(), name: z.string() }),
  z.object({ type: z.literal('rejected'), mac: z.string() }),
  z.object({ type: z.literal('unpaired'), mac: z.string() }),
  z.object({ type: z.literal('error'), code: z.string() }),
]);
export type RelayToDevice = z.infer<typeof RelayToDevice>;

export const DeviceToRelay = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), pub: z.string(), sig: z.string() }),
  z.object({ type: z.literal('push_token'), token: z.string() }),
]);
export type DeviceToRelay = z.infer<typeof DeviceToRelay>;

/** What the Mac encodes into the pairing QR (9e). */
export const QrPayload = z.object({
  v: z.literal(1), relay: z.string(), mac: z.string(), name: z.string(), token: z.string(),
});
export type QrPayload = z.infer<typeof QrPayload>;

/**
 * `mac` is the pair's anchor: the Mac sends its own id, the phone the id
 * from the QR. The relay ignores it; a load balancer in front of several
 * relays hashes on it so both halves of a pair land on one instance
 * (runbook `run-the-relay`). One instance needs nothing of the kind.
 */
export function relayWsUrl(httpUrl: string, mac: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.searchParams.set('mac', mac);
  return url.toString();
}
```

- [x] **Step 4: Run the tests and the typecheck**

Run: `npm test -w shared && npm run typecheck -w shared`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add shared/src/remote/relayApi.ts shared/test/relayApi.test.ts
git commit -m "feat(shared): signed relay requests, control messages and the QR payload"
```

---

### Task 6: `relay/` workspace, config, store and Dockerfile

**Files:**
- Create: `relay/package.json`, `relay/tsconfig.json`, `relay/vitest.config.ts`, `relay/Dockerfile`, `relay/.dockerignore`
- Create: `relay/src/config.ts`, `relay/src/db.ts`, `relay/migrations/0001_initial.ts`, `relay/src/store.ts`, `relay/src/index.ts`
- Test: `relay/test/store.test.ts`

**Interfaces:**
- Consumes: `PAIRING_TOKEN_TTL_MS` from Task 5.
- Produces: `CONFIG` (`port`, `dataDir`, `fcmServiceAccountPath`, `databaseUrl`), `interface RelayStore` (every method async: `upsertDevice`, `device`, `touch`, `setPushToken`, `createPairingToken`, `redeemPairingToken`, `pending`, `confirmPair`, `rejectPair`, `revokePair`, `isPaired`, `peersOf`, `phonesOf`, `pruneExpiredTokens`, `clearForTests`, `close`), `KyselyRelayStore`, `openRelayDb(target)`, `openRelayStore(target): Promise<RelayStore>`.

- [x] **Step 1: Create the workspace**

`relay/package.json`:

```json
{
  "name": "@orbital/relay",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "The blind relay between a Mac running Orbital and its paired phones.",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "esbuild src/index.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/index.mjs --external:better-sqlite3 --banner:js=\"import { createRequire as __relayCreateRequire } from 'node:module'; const require = __relayCreateRequire(import.meta.url);\"",
    "start": "node dist/index.mjs",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@fastify/websocket": "^11.0.0",
    "@orbital/shared": "*",
    "better-sqlite3": "^13.0.3",
    "fastify": "^5.2.0",
    "ws": "^8.18.0",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.13",
    "esbuild": "^0.24.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`relay/tsconfig.json` is a copy of `server/tsconfig.json`. `relay/vitest.config.ts` is a copy of `server/vitest.config.ts`. Inside `shared/` and `relay/`, relative imports use the `.js` suffix the server already uses (`'./keys.js'` for `keys.ts`): TypeScript, esbuild, tsx and vitest all map it to the `.ts` source, and no consumer needs a tsconfig flag for it.

Root `package.json`: `"relay"` goes last in `workspaces`. Add to the ignore list in `.gitignore`: `relay/dist/` and `relay/data/`. Add `'relay/vitest.config.ts'` to `allowDefaultProject` in `eslint.config.js` if Task 1 did not.

Run: `npm install`
Expected: `node_modules/@orbital/relay` symlink exists; `npm run typecheck -w relay` passes on the empty workspace once `src/index.ts` exists (Step 5).

- [x] **Step 2: `config.ts`**

```ts
import { join } from 'node:path';

/** Everything the relay reads from its environment, in one place. */
export const CONFIG = {
  port: Number(process.env.RELAY_PORT ?? 4840),
  dataDir: process.env.RELAY_DATA_DIR ?? join(process.cwd(), 'data'),
  /** A Firebase service-account JSON. Absent means pushes are logged, not sent. */
  fcmServiceAccountPath: process.env.RELAY_FCM_SERVICE_ACCOUNT ?? null,
  /** `postgres://…` for a real deployment. Absent means SQLite under `dataDir` — a laptop, or tests. */
  databaseUrl: process.env.RELAY_DATABASE_URL ?? null,
};
```

- [x] **Step 3: Write the failing store test**

`relay/test/store.test.ts` — one suite, run against SQLite always and against Postgres when `RELAY_TEST_DATABASE_URL` is set (a local `postgres://relay:relay@127.0.0.1:5432/relay_test`; the suite empties its tables before each test):

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { PAIRING_TOKEN_TTL_MS } from '@orbital/shared/remote/relayApi';
import { openRelayStore, type RelayStore } from '../src/store.js';

const backends: [string, () => Promise<RelayStore>][] = [['sqlite', () => openRelayStore(':memory:')]];
if (process.env.RELAY_TEST_DATABASE_URL) {
  backends.push(['postgres', () => openRelayStore(process.env.RELAY_TEST_DATABASE_URL!)]);
}

describe.each(backends)('RelayStore (%s)', (_name, open) => {
  let store: RelayStore;
  beforeEach(async () => {
    store = await open();
    await store.clearForTests();
  });
  afterAll(async () => { await store.close(); });

  it('a pairing token is redeemed once, within its ttl, and then confirmed into a pair', async () => {
    await store.upsertDevice({ id: 'mac1', kind: 'mac', name: 'studio' });
    const token = await store.createPairingToken('mac1', 1000 + PAIRING_TOKEN_TTL_MS);
    expect(await store.redeemPairingToken(token, 'phone1', 'Pixel', 'android', 1000)).toEqual({ mac: 'mac1' });
    expect(await store.redeemPairingToken(token, 'phone2', 'Other', 'ios', 1000)).toBeNull();
    expect(await store.pending('mac1', 'phone1')).toEqual({ name: 'Pixel', platform: 'android' });
    expect(await store.isPaired('mac1', 'phone1')).toBe(false);
    expect(await store.confirmPair('mac1', 'phone1', 2000)).toBe(true);
    expect(await store.isPaired('mac1', 'phone1')).toBe(true);
    expect(await store.isPaired('phone1', 'mac1')).toBe(true);
    expect(await store.pending('mac1', 'phone1')).toBeNull();
    expect(await store.confirmPair('mac1', 'phone1', 2000)).toBe(false);
  });
  it('an expired token answers null', async () => {
    await store.upsertDevice({ id: 'mac1', kind: 'mac', name: 'studio' });
    const token = await store.createPairingToken('mac1', 1000 + PAIRING_TOKEN_TTL_MS);
    expect(await store.redeemPairingToken(token, 'p', 'n', 'android', 1000 + PAIRING_TOKEN_TTL_MS + 1)).toBeNull();
  });
  it('reject clears the pending request; revoke removes the pair', async () => {
    await store.upsertDevice({ id: 'mac1', kind: 'mac', name: 'studio' });
    const t1 = await store.createPairingToken('mac1', 9000);
    await store.redeemPairingToken(t1, 'phone1', 'n', 'android', 1);
    await store.rejectPair('mac1', 'phone1');
    expect(await store.pending('mac1', 'phone1')).toBeNull();
    const t2 = await store.createPairingToken('mac1', 9000);
    await store.redeemPairingToken(t2, 'phone1', 'n', 'android', 1);
    await store.confirmPair('mac1', 'phone1', 2);
    expect(await store.peersOf('mac1')).toEqual(['phone1']);
    expect(await store.phonesOf('mac1')).toEqual(['phone1']);
    await store.revokePair('mac1', 'phone1');
    expect(await store.isPaired('mac1', 'phone1')).toBe(false);
    expect(await store.peersOf('phone1')).toEqual([]);
  });
  it('devices keep a name, a push token and a last-seen stamp', async () => {
    await store.upsertDevice({ id: 'phone1', kind: 'phone', name: 'Pixel', platform: 'android' });
    await store.setPushToken('phone1', 'fcm-abc');
    await store.touch('phone1', 123);
    expect(await store.device('phone1')).toMatchObject({ kind: 'phone', name: 'Pixel', pushToken: 'fcm-abc', lastSeenAt: 123 });
    await store.upsertDevice({ id: 'phone1', kind: 'phone', name: 'Pixel 9' });
    expect((await store.device('phone1'))?.name).toBe('Pixel 9');
    expect(await store.device('nope')).toBeNull();
  });
  it('migrations are idempotent: opening twice is fine', async () => {
    const again = await open();
    expect(await again.device('nope')).toBeNull();
    await again.close();
  });
});
```

- [x] **Step 4: Implement the database, the migration and the store**

One table description serves both dialects; Kysely picks the driver at runtime. Migrations use Kysely's schema builder, which is dialect-agnostic for everything these tables need, and are registered statically so the esbuild bundle carries them (a `FileMigrationProvider` would look for files on disk at runtime).

`relay/src/db.ts`:

```ts
/**
 * The relay's tables, once, for both dialects (spec
 * 2026-09-30-mobile-remote-design § 2). SQLite is for tests and a laptop;
 * every real deployment runs Postgres (`RELAY_DATABASE_URL`). Timestamps are
 * epoch milliseconds in a BIGINT; pg hands those back as strings, so the
 * store converts them (`asNumber`).
 */
import Database from 'better-sqlite3';
import { Kysely, Migrator, PostgresDialect, SqliteDialect, type Migration, type MigrationProvider } from 'kysely';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { migration as m0001 } from '../migrations/0001_initial.js';

export interface DevicesTable {
  id: string;
  kind: 'mac' | 'phone';
  name: string;
  platform: string | null;
  push_token: string | null;
  last_seen_at: number | string | null;
}
export interface PairsTable {
  mac: string;
  phone: string;
  created_at: number | string;
}
export interface PairingTokensTable {
  token: string;
  mac: string;
  expires_at: number | string;
  phone: string | null;
  phone_name: string | null;
  phone_platform: string | null;
  state: 'open' | 'pending' | 'confirmed' | 'rejected';
}
export interface RelayDatabase {
  devices: DevicesTable;
  pairs: PairsTable;
  pairing_tokens: PairingTokensTable;
}

export type RelayDb = Kysely<RelayDatabase>;

/** Every migration, in order, by name. Add a line here for each new file. */
const MIGRATIONS: Record<string, Migration> = {
  '0001_initial': m0001,
};

const provider: MigrationProvider = { getMigrations: async () => MIGRATIONS };

export function isPostgresUrl(target: string): boolean {
  return /^postgres(ql)?:\/\//.test(target);
}

/** `:memory:` or a file path → SQLite; `postgres://…` → Postgres. Migrates to latest. */
export async function openRelayDb(target: string): Promise<RelayDb> {
  let db: RelayDb;
  if (isPostgresUrl(target)) {
    db = new Kysely<RelayDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: target }) }) });
  } else {
    if (target !== ':memory:') mkdirSync(dirname(target), { recursive: true });
    const sqlite = new Database(target);
    sqlite.pragma('journal_mode = WAL');
    db = new Kysely<RelayDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
  }
  const { error } = await new Migrator({ db, provider }).migrateToLatest();
  if (error) {
    await db.destroy();
    throw error instanceof Error ? error : new Error(String(error));
  }
  return db;
}

export function asNumber(v: number | string | null): number | null {
  return v === null ? null : Number(v);
}
```

`relay/migrations/0001_initial.ts`:

```ts
import type { Kysely, Migration } from 'kysely';

export const migration: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.createTable('devices')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('name', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('platform', 'text')
      .addColumn('push_token', 'text')
      .addColumn('last_seen_at', 'bigint')
      .execute();
    await db.schema.createTable('pairs')
      .addColumn('mac', 'text', (c) => c.notNull())
      .addColumn('phone', 'text', (c) => c.notNull())
      .addColumn('created_at', 'bigint', (c) => c.notNull())
      .addPrimaryKeyConstraint('pairs_pk', ['mac', 'phone'])
      .execute();
    await db.schema.createTable('pairing_tokens')
      .addColumn('token', 'text', (c) => c.primaryKey())
      .addColumn('mac', 'text', (c) => c.notNull())
      .addColumn('expires_at', 'bigint', (c) => c.notNull())
      .addColumn('phone', 'text')
      .addColumn('phone_name', 'text')
      .addColumn('phone_platform', 'text')
      .addColumn('state', 'text', (c) => c.notNull().defaultTo('open'))
      .execute();
    await db.schema.createIndex('pairing_tokens_pending')
      .on('pairing_tokens').columns(['mac', 'phone', 'state']).execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('pairing_tokens').execute();
    await db.schema.dropTable('pairs').execute();
    await db.schema.dropTable('devices').execute();
  },
};
```

`relay/tsconfig.json` `include` becomes `["src", "test", "migrations"]`.

`relay/src/store.ts`:

```ts
/**
 * What the relay remembers: who exists, who is paired with whom, which
 * pairing tokens are open, and where to push. Nothing about sessions — that
 * is the whole point (spec 2026-09-30-mobile-remote-design § 2). A pair's
 * existence is also cached on each live connection (`Conn.peers`, ws.ts), so
 * routing a frame never waits on this store.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { asNumber, openRelayDb, type RelayDb } from './db.js';

export type DeviceKind = 'mac' | 'phone';
export type DeviceRow = {
  id: string; kind: DeviceKind; name: string; platform: string | null;
  pushToken: string | null; lastSeenAt: number | null;
};

export interface RelayStore {
  upsertDevice(d: { id: string; kind: DeviceKind; name?: string; platform?: string }): Promise<void>;
  device(id: string): Promise<DeviceRow | null>;
  touch(id: string, now: number): Promise<void>;
  setPushToken(id: string, token: string | null): Promise<void>;
  createPairingToken(mac: string, expiresAt: number): Promise<string>;
  /** Open and unexpired → pending for this phone; anything else → null. */
  redeemPairingToken(token: string, phone: string, name: string, platform: string, now: number): Promise<{ mac: string } | null>;
  pending(mac: string, phone: string): Promise<{ name: string; platform: string } | null>;
  confirmPair(mac: string, phone: string, now: number): Promise<boolean>;
  rejectPair(mac: string, phone: string): Promise<void>;
  revokePair(mac: string, phone: string): Promise<void>;
  isPaired(a: string, b: string): Promise<boolean>;
  /** Every device paired with this one, whichever side it is. */
  peersOf(id: string): Promise<string[]>;
  phonesOf(mac: string): Promise<string[]>;
  pruneExpiredTokens(now: number): Promise<void>;
  /** Empties every table. Tests only; the name says so. */
  clearForTests(): Promise<void>;
  close(): Promise<void>;
}

export class KyselyRelayStore implements RelayStore {
  constructor(private readonly db: RelayDb) {}

  async upsertDevice(d: { id: string; kind: DeviceKind; name?: string; platform?: string }): Promise<void> {
    const name = d.name ?? '';
    await this.db.insertInto('devices')
      .values({ id: d.id, kind: d.kind, name, platform: d.platform ?? null })
      .onConflict((oc) => oc.column('id').doUpdateSet((eb) => ({
        kind: d.kind,
        // An empty name never overwrites a real one: a reconnecting phone
        // does not know its name, the pairing did.
        name: name === '' ? eb.ref('devices.name') : name,
        platform: d.platform ?? eb.ref('devices.platform'),
      })))
      .execute();
  }

  async device(id: string): Promise<DeviceRow | null> {
    const row = await this.db.selectFrom('devices')
      .select(['id', 'kind', 'name', 'platform', 'push_token', 'last_seen_at'])
      .where('id', '=', id).executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id, kind: row.kind, name: row.name, platform: row.platform,
      pushToken: row.push_token, lastSeenAt: asNumber(row.last_seen_at),
    };
  }

  async touch(id: string, now: number): Promise<void> {
    await this.db.updateTable('devices').set({ last_seen_at: now }).where('id', '=', id).execute();
  }

  async setPushToken(id: string, token: string | null): Promise<void> {
    await this.db.updateTable('devices').set({ push_token: token }).where('id', '=', id).execute();
  }

  async createPairingToken(mac: string, expiresAt: number): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await this.db.insertInto('pairing_tokens').values({ token, mac, expires_at: expiresAt, state: 'open' }).execute();
    return token;
  }

  async redeemPairingToken(token: string, phone: string, name: string, platform: string, now: number) {
    const open = await this.db.selectFrom('pairing_tokens').select('mac')
      .where('token', '=', token).where('state', '=', 'open').where('expires_at', '>=', now)
      .executeTakeFirst();
    if (!open) return null;
    // The state check in the UPDATE is what makes a double redeem lose the race.
    const result = await this.db.updateTable('pairing_tokens')
      .set({ state: 'pending', phone, phone_name: name, phone_platform: platform })
      .where('token', '=', token).where('state', '=', 'open')
      .executeTakeFirst();
    return result.numUpdatedRows === 1n ? { mac: open.mac } : null;
  }

  async pending(mac: string, phone: string) {
    const row = await this.db.selectFrom('pairing_tokens')
      .select(['phone_name', 'phone_platform'])
      .where('mac', '=', mac).where('phone', '=', phone).where('state', '=', 'pending')
      .executeTakeFirst();
    return row ? { name: row.phone_name ?? '', platform: row.phone_platform ?? '' } : null;
  }

  async confirmPair(mac: string, phone: string, now: number): Promise<boolean> {
    const result = await this.db.updateTable('pairing_tokens').set({ state: 'confirmed' })
      .where('mac', '=', mac).where('phone', '=', phone).where('state', '=', 'pending')
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) return false;
    await this.db.insertInto('pairs').values({ mac, phone, created_at: now })
      .onConflict((oc) => oc.columns(['mac', 'phone']).doNothing()).execute();
    return true;
  }

  async rejectPair(mac: string, phone: string): Promise<void> {
    await this.db.updateTable('pairing_tokens').set({ state: 'rejected' })
      .where('mac', '=', mac).where('phone', '=', phone).where('state', '=', 'pending').execute();
  }

  async revokePair(mac: string, phone: string): Promise<void> {
    await this.db.deleteFrom('pairs').where('mac', '=', mac).where('phone', '=', phone).execute();
  }

  async isPaired(a: string, b: string): Promise<boolean> {
    const row = await this.db.selectFrom('pairs').select(sql<number>`1`.as('one'))
      .where((eb) => eb.or([
        eb.and([eb('mac', '=', a), eb('phone', '=', b)]),
        eb.and([eb('mac', '=', b), eb('phone', '=', a)]),
      ]))
      .executeTakeFirst();
    return row !== undefined;
  }

  async peersOf(id: string): Promise<string[]> {
    const asMac = await this.db.selectFrom('pairs').select('phone as peer').where('mac', '=', id).execute();
    const asPhone = await this.db.selectFrom('pairs').select('mac as peer').where('phone', '=', id).execute();
    return [...new Set([...asMac, ...asPhone].map((r) => r.peer))].sort();
  }

  async phonesOf(mac: string): Promise<string[]> {
    const rows = await this.db.selectFrom('pairs').select('phone').where('mac', '=', mac).orderBy('phone').execute();
    return rows.map((r) => r.phone);
  }

  async pruneExpiredTokens(now: number): Promise<void> {
    await this.db.deleteFrom('pairing_tokens')
      .where('expires_at', '<', now).where('state', 'in', ['open', 'rejected']).execute();
  }

  async clearForTests(): Promise<void> {
    await this.db.deleteFrom('pairing_tokens').execute();
    await this.db.deleteFrom('pairs').execute();
    await this.db.deleteFrom('devices').execute();
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}

export async function openRelayStore(target: string): Promise<RelayStore> {
  return new KyselyRelayStore(await openRelayDb(target));
}
```

`relay/package.json` dependencies: `"kysely": "^0.28.0"` and `"pg": "^8.13.0"` beside `better-sqlite3`; devDependencies `"@types/pg": "^8.11.0"`. `config.ts` gains `databaseUrl: process.env.RELAY_DATABASE_URL ?? null`, and `index.ts` opens `CONFIG.databaseUrl ?? join(CONFIG.dataDir, 'relay.db')`.

Adding a table or a column later: a new file `relay/migrations/0002_<name>.ts` exporting `migration`, one line in `MIGRATIONS`; it runs on the next boot of every instance, SQLite and Postgres alike.

- [x] **Step 5: `index.ts`, Dockerfile and the root scripts**

`relay/src/index.ts` (the app factory `buildRelay` arrives in Task 7; until then this file only opens the store so the typecheck has an entry point — replace the body in Task 7):

```ts
import { join } from 'node:path';
import { CONFIG } from './config.js';
import { openRelayStore } from './store.js';

const store = await openRelayStore(CONFIG.databaseUrl ?? join(CONFIG.dataDir, 'relay.db'));
console.log(`relay store open (${CONFIG.databaseUrl ? 'postgres' : 'sqlite'})`);
await store.close();
```

`relay/Dockerfile` (build context is the repository root; Dokploy: Dockerfile path `relay/Dockerfile`, context `.`):

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY relay/package.json relay/
RUN npm ci --workspace shared --workspace relay --include-workspace-root=false
COPY shared shared
COPY relay relay
RUN npm run build -w relay

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production RELAY_PORT=4840 RELAY_DATA_DIR=/data
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/relay/dist relay/dist
VOLUME /data
EXPOSE 4840
CMD ["node", "relay/dist/index.mjs"]
```

`relay/.dockerignore`: `dist`, `data`, `node_modules`.

Run: `npm test -w relay && npm run typecheck -w relay && npm run build -w relay && npm run test && npm run typecheck`
Expected: the store tests pass; the root `test` and `typecheck` scripts from Task 1 now run through every workspace.

- [x] **Step 6: Commit**

```bash
git add relay package.json package-lock.json .gitignore eslint.config.js
git commit -m "feat(relay): workspace, store and Dockerfile"
```

---

### Task 7: Relay WebSocket — auth, routing, presence, caps, offline queue

**Files:**
- Create: `relay/src/connections.ts`, `relay/src/ws.ts`, `relay/src/app.ts`
- Modify: `relay/src/index.ts`
- Test: `relay/test/ws.test.ts`, `relay/test/helpers.ts`

**Interfaces:**
- Consumes: `RelayStore` (Task 6); `decodeFrame`, `rewritePeer`, `FLAG_WAKE`, `FLAG_STATE`, `MAX_FRAME_BYTES` (Task 2); `deviceId`, `publicKeyOf` (Task 1); `RelayToDevice`, `DeviceToRelay`, `verifyAuthSignature`, `RELAY_PING_INTERVAL_MS` (Task 5).
- Produces: `MAX_BUFFERED_BYTES`, `OFFLINE_QUEUE_MAX`, `AUTH_TIMEOUT_MS` (10000), `type Conn = { socket; id; peers: Set<string> }`, `class Connections` (`add`, `remove`, `get`, `isOnline`, `sendControl(id, msg)`), `class OfflineQueue` (`push`, `drain`), `type WakeHook = (from: string, to: string, wake: Uint8Array) => void | Promise<void>`, `handleSocket(socket, ctx)`, `buildRelay(opts: { store: RelayStore; onWake?: WakeHook; now?: () => number; pingIntervalMs?: number }): FastifyInstance` with `app.relay = { connections, queue }` decorated for tests.

- [x] **Step 1: Test helpers**

`relay/test/helpers.ts`:

```ts
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { authSignature, RelayToDevice, type RelayToDevice as Control } from '@orbital/shared/remote/relayApi';
import { deviceId, type Identity } from '@orbital/shared/remote/keys';

export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

export type Device = {
  ws: WebSocket;
  id: string;
  control: Control[];
  data: Uint8Array[];
  next(type: Control['type']): Promise<Control>;
  nextData(): Promise<Uint8Array>;
};

/** Opens a socket, answers the challenge, resolves after `ok`. */
export async function connectDevice(base: string, identity: Identity, mac = deviceId(identity.publicKey)): Promise<Device> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?mac=${mac}`);
  const control: Control[] = [];
  const data: Uint8Array[] = [];
  const waiters: { type: string | 'data'; resolve: (v: any) => void }[] = [];
  // A message either satisfies a waiter or is kept; never both, so `control`
  // and `data` hold exactly what nobody has consumed.
  ws.on('message', (raw, isBinary) => {
    if (isBinary) {
      const buf = new Uint8Array(raw as Buffer);
      const i = waiters.findIndex((w) => w.type === 'data');
      if (i >= 0) waiters.splice(i, 1)[0].resolve(buf);
      else data.push(buf);
      return;
    }
    const msg = RelayToDevice.parse(JSON.parse(String(raw)));
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else control.push(msg);
  });
  const next = (type: Control['type']) =>
    new Promise<Control>((resolve) => {
      const i = control.findIndex((m) => m.type === type);
      if (i >= 0) resolve(control.splice(i, 1)[0]);
      else waiters.push({ type, resolve });
    });
  const nextData = () =>
    new Promise<Uint8Array>((resolve) => {
      if (data.length) resolve(data.shift()!);
      else waiters.push({ type: 'data', resolve });
    });
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const challenge = await next('challenge');
  if (challenge.type !== 'challenge') throw new Error('expected challenge');
  ws.send(JSON.stringify({ type: 'auth', pub: deviceId(identity.publicKey), sig: authSignature(identity, challenge.nonce) }));
  await next('ok');
  return { ws, id: deviceId(identity.publicKey), control, data, next, nextData };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

- [x] **Step 2: Write the failing tests**

`relay/test/ws.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { generateIdentity, deviceId, publicKeyOf } from '@orbital/shared/remote/keys';
import { FLAG_STATE, FLAG_WAKE, ZERO_WAKE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import { buildRelay, OFFLINE_QUEUE_MAX } from '../src/app.js';
import { openRelayStore } from '../src/store.js';
import { connectDevice, listen, sleep } from './helpers.js';

function frameTo(id: string, body: number[], flags = 0, wake = ZERO_WAKE) {
  return encodeFrame({ peer: publicKeyOf(id)!, flags, wake, body: new Uint8Array(body) });
}

describe('relay websocket', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  async function relay(onWake = (..._: unknown[]) => {}) {
    const store = await openRelayStore(':memory:');
    const app = buildRelay({ store, onWake });
    const base = await listen(app);
    closers.push(() => app.close());
    const mac = generateIdentity();
    const phone = generateIdentity();
    await store.upsertDevice({ id: deviceId(mac.publicKey), kind: 'mac', name: 'studio' });
    await store.upsertDevice({ id: deviceId(phone.publicKey), kind: 'phone', name: 'Pixel' });
    const token = await store.createPairingToken(deviceId(mac.publicKey), Date.now() + 10_000);
    await store.redeemPairingToken(token, deviceId(phone.publicKey), 'Pixel', 'android', Date.now());
    await store.confirmPair(deviceId(mac.publicKey), deviceId(phone.publicKey), Date.now());
    return { store, app, base, mac, phone };
  }

  it('forwards only within a pair, rewriting the peer to the sender', async () => {
    const { base, mac, phone } = await relay();
    const m = await connectDevice(base, mac);
    const p = await connectDevice(base, phone);
    const stranger = await connectDevice(base, generateIdentity());
    stranger.ws.send(frameTo(m.id, [9]));
    p.ws.send(frameTo(m.id, [1, 2]));
    const got = decodeFrame(await m.nextData())!;
    expect(deviceId(got.peer)).toBe(p.id);
    expect(got.body).toEqual(new Uint8Array([1, 2]));
    await sleep(50);
    expect(m.data).toHaveLength(0);
    expect(stranger.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('presence: ok lists online peers, and peers hear each other come and go', async () => {
    const { base, mac, phone } = await relay();
    const m = await connectDevice(base, mac);
    const p = await connectDevice(base, phone);
    const online = await m.next('presence');
    expect(online).toEqual({ type: 'presence', peer: p.id, online: true });
    p.ws.close();
    const offline = await m.next('presence');
    expect(offline).toEqual({ type: 'presence', peer: p.id, online: false });
  });

  it('queues state frames for an offline phone, drops the rest, drains on connect', async () => {
    const { base, mac, phone } = await relay();
    const m = await connectDevice(base, mac);
    m.ws.send(frameTo(deviceId(phone.publicKey), [1]));
    for (let i = 0; i < OFFLINE_QUEUE_MAX + 2; i++) m.ws.send(frameTo(deviceId(phone.publicKey), [i], FLAG_STATE));
    await sleep(50);
    const p = await connectDevice(base, phone);
    await sleep(50);
    expect(p.data).toHaveLength(OFFLINE_QUEUE_MAX);
    expect(decodeFrame(p.data[0])!.body).toEqual(new Uint8Array([2]));
  });

  it('calls the wake hook only when the addressee is offline', async () => {
    const wakes: unknown[] = [];
    const { base, mac, phone } = await relay((from, to, wake) => wakes.push({ from, to, wake: Buffer.from(wake).toString('hex') }));
    const m = await connectDevice(base, mac);
    const wake = new Uint8Array(16).fill(1);
    m.ws.send(frameTo(deviceId(phone.publicKey), [], FLAG_WAKE | FLAG_STATE, wake));
    await sleep(50);
    expect(wakes).toEqual([{ from: m.id, to: deviceId(phone.publicKey), wake: '01'.repeat(16) }]);
    const p = await connectDevice(base, phone);
    await p.nextData();
    m.ws.send(frameTo(p.id, [], FLAG_WAKE, wake));
    await p.nextData();
    expect(wakes).toHaveLength(1);
  });

  it('closes a socket that fails auth or sends junk before auth', async () => {
    const { base } = await relay();
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'auth', pub: deviceId(generateIdentity().publicKey), sig: 'bad' }));
    const code = await new Promise<number>((r) => ws.once('close', r));
    expect(code).toBe(4001);
  });
});
```

- [x] **Step 3: Run them to see them fail**

Run: `npm test -w relay -- ws`
Expected: FAIL, `../src/app.ts` not found.

- [x] **Step 4: Implement `connections.ts`**

```ts
import type { WebSocket } from 'ws';
import type { RelayToDevice } from '@orbital/shared/remote/relayApi';

/** Past this much unsent data on the target, the source stops being read. */
export const MAX_BUFFERED_BYTES = 4194304;
/** State frames kept for an offline device; older ones fall off the front. */
export const OFFLINE_QUEUE_MAX = 32;

/**
 * `peers` is the pair table for this device, cached at attach and kept
 * current by the pairing routes: routing a frame reads it synchronously, so
 * frames from one socket are forwarded in the order they arrived — an
 * awaited store lookup per frame could reorder them, and the receiver's
 * cipher counter treats a reordered frame as a replay.
 */
export type Conn = { socket: WebSocket; id: string; peers: Set<string> };

export class Connections {
  private byId = new Map<string, Conn>();

  add(conn: Conn): Conn | undefined {
    const previous = this.byId.get(conn.id);
    this.byId.set(conn.id, conn);
    return previous;
  }

  /** Removes only if this socket is still the one registered. */
  remove(conn: Conn): boolean {
    if (this.byId.get(conn.id)?.socket !== conn.socket) return false;
    this.byId.delete(conn.id);
    return true;
  }

  get(id: string): Conn | undefined {
    return this.byId.get(id);
  }

  isOnline(id: string): boolean {
    return this.byId.has(id);
  }

  sendControl(id: string, msg: RelayToDevice): boolean {
    const conn = this.byId.get(id);
    if (!conn) return false;
    try {
      conn.socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
}

export class OfflineQueue {
  private byId = new Map<string, Uint8Array[]>();

  push(id: string, frame: Uint8Array): void {
    let q = this.byId.get(id);
    if (!q) {
      q = [];
      this.byId.set(id, q);
    }
    q.push(frame);
    if (q.length > OFFLINE_QUEUE_MAX) q.splice(0, q.length - OFFLINE_QUEUE_MAX);
  }

  drain(id: string): Uint8Array[] {
    const q = this.byId.get(id) ?? [];
    this.byId.delete(id);
    return q;
  }
}
```

- [x] **Step 5: Implement `ws.ts`**

```ts
/**
 * One socket's life on the relay: challenge, auth, then binary frames routed
 * within pairs and text frames read as control. The body of a binary frame
 * is never looked at (spec 2026-09-30-mobile-remote-design § 2).
 */
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { deviceId, publicKeyOf } from '@orbital/shared/remote/keys';
import { FLAG_STATE, FLAG_WAKE, decodeFrame, rewritePeer } from '@orbital/shared/remote/frame';
import {
  DeviceToRelay, RELAY_PING_INTERVAL_MS, verifyAuthSignature, type RelayToDevice,
} from '@orbital/shared/remote/relayApi';
import { Connections, MAX_BUFFERED_BYTES, OfflineQueue, type Conn } from './connections.js';
import type { RelayStore } from './store.js';

export const AUTH_TIMEOUT_MS = 10_000;
const BACKPRESSURE_POLL_MS = 50;
const MISSED_PINGS_TO_DROP = 3;

export type WakeHook = (from: string, to: string, wake: Uint8Array) => void | Promise<void>;

export type WsContext = {
  store: RelayStore;
  connections: Connections;
  queue: OfflineQueue;
  onWake: WakeHook;
  now: () => number;
  pingIntervalMs: number;
};

export function handleSocket(socket: WebSocket, ctx: WsContext): void {
  const nonce = randomBytes(16).toString('base64url');
  send(socket, { type: 'challenge', nonce });
  const authTimer = setTimeout(() => socket.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);

  socket.once('message', (raw, isBinary) => {
    clearTimeout(authTimer);
    const parsed = isBinary ? null : DeviceToRelay.safeParse(safeJson(raw));
    if (!parsed?.success || parsed.data.type !== 'auth') return socket.close(4001, 'auth required');
    const { pub, sig } = parsed.data;
    const publicKey = publicKeyOf(pub);
    if (!publicKey || !verifyAuthSignature(publicKey, nonce, sig)) return socket.close(4001, 'bad auth');
    // Frames that arrive while the store answers are held by pausing the
    // socket, not buffered by us: `attach` resumes it once `peers` is known.
    socket.pause();
    void (async () => {
      // A device the relay has never met may still connect: a phone has to be
      // online to hear `paired`. It just has no peers yet.
      if (!(await ctx.store.device(pub))) await ctx.store.upsertDevice({ id: pub, kind: 'phone' });
      const peers = new Set(await ctx.store.peersOf(pub));
      await ctx.store.touch(pub, ctx.now());
      if (socket.readyState !== socket.OPEN) return;
      attach({ socket, id: pub, peers }, ctx);
    })().catch(() => socket.close(1011, 'store error'));
  });
}

function attach(conn: Conn, ctx: WsContext): void {
  const { socket, id, peers } = conn;
  const previous = ctx.connections.add(conn);
  // One socket per device: a reconnect supersedes a half-dead predecessor.
  previous?.socket.close(4000, 'superseded');

  send(socket, { type: 'ok', peers: [...peers].filter((p) => ctx.connections.isOnline(p)) });
  for (const p of peers) ctx.connections.sendControl(p, { type: 'presence', peer: id, online: true });
  for (const frame of ctx.queue.drain(id)) socket.send(frame);
  socket.resume();

  let missed = 0;
  const ping = setInterval(() => {
    if (missed >= MISSED_PINGS_TO_DROP) return socket.terminate();
    missed++;
    socket.ping();
  }, ctx.pingIntervalMs);
  socket.on('pong', () => { missed = 0; });

  socket.on('message', (raw, isBinary) => {
    if (isBinary) return route(conn, toBytes(raw), ctx);
    const parsed = DeviceToRelay.safeParse(safeJson(raw));
    if (!parsed.success) return;
    if (parsed.data.type === 'push_token') void ctx.store.setPushToken(id, parsed.data.token);
  });

  socket.on('close', () => {
    clearInterval(ping);
    if (!ctx.connections.remove(conn)) return;
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
  if (frame.flags & FLAG_WAKE) void ctx.onWake(from.id, to, new Uint8Array(frame.wake));
  if (frame.flags & FLAG_STATE) ctx.queue.push(to, buf);
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
```

- [x] **Step 6: Implement `app.ts` and wire `index.ts`**

`relay/src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { MAX_FRAME_BYTES } from '@orbital/shared/remote/frame';
import { RELAY_PING_INTERVAL_MS } from '@orbital/shared/remote/relayApi';
import { Connections, OfflineQueue } from './connections.js';
import { handleSocket, type WakeHook, type WsContext } from './ws.js';
import type { RelayStore } from './store.js';

export { MAX_BUFFERED_BYTES, OFFLINE_QUEUE_MAX } from './connections.js';

export type RelayOptions = {
  store: RelayStore;
  onWake?: WakeHook;
  now?: () => number;
  pingIntervalMs?: number;
};

declare module 'fastify' {
  interface FastifyInstance {
    relay: WsContext;
  }
}

export async function buildRelay(opts: RelayOptions): Promise<FastifyInstance> {
  const app = Fastify();
  const ctx: WsContext = {
    store: opts.store,
    connections: new Connections(),
    queue: new OfflineQueue(),
    onWake: opts.onWake ?? (() => {}),
    now: opts.now ?? Date.now,
    pingIntervalMs: opts.pingIntervalMs ?? RELAY_PING_INTERVAL_MS,
  };
  app.decorate('relay', ctx);
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
  app.get('/ws', { websocket: true }, (socket) => handleSocket(socket, ctx));
  app.get('/health', () => ({ app: 'orbital-relay' }));
  app.addHook('onClose', async () => { await opts.store.close(); });
  return app;
}
```

`buildRelay` is async; update the test's `relay()` helper to `await buildRelay(...)`.

`relay/src/index.ts`:

```ts
import { join } from 'node:path';
import { CONFIG } from './config.js';
import { buildRelay } from './app.js';
import { openRelayStore } from './store.js';

const store = await openRelayStore(CONFIG.databaseUrl ?? join(CONFIG.dataDir, 'relay.db'));
const app = await buildRelay({ store });
await app.listen({ port: CONFIG.port, host: '0.0.0.0' });
console.log(`orbital relay listening on ${CONFIG.port}`);
```

- [x] **Step 7: Run the tests**

Run: `npm test -w relay && npm run typecheck -w relay`
Expected: PASS. If the `superseded` close races the presence test, the second `connectDevice` for the same identity is not in these tests; leave it.

- [x] **Step 8: Commit**

```bash
git add relay/src relay/test
git commit -m "feat(relay): authenticated sockets, pair-scoped routing, presence, caps and the offline queue"
```

---

### Task 8: Relay pairing endpoints

**Files:**
- Create: `relay/src/pairing.ts`
- Modify: `relay/src/app.ts` (register the routes)
- Test: `relay/test/pairing.test.ts`

**Interfaces:**
- Consumes: `RelayStore` (6), `Connections` (7), `verifyRequest`, `PAIRING_TOKEN_TTL_MS` (5).
- Produces: `registerPairingRoutes(app, ctx: WsContext)`; `PAIR_RATE_LIMIT_PER_MIN` (20).

Routes and answers (the `action` strings are from Task 5's table):

| route | 2xx | errors |
|---|---|---|
| `POST /pair/token` | `{ token, expiresAt }` | 401 bad signature |
| `POST /pair/redeem` | `{ mac, name }` | 401; 404 `token_invalid`; 409 `mac_offline` |
| `POST /pair/confirm` | `{ ok: true }` | 401; 404 `no_pending` |
| `POST /pair/revoke` | `{ ok: true }` | 401 |

- [x] **Step 1: Write the failing tests**

`relay/test/pairing.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { generateIdentity, deviceId } from '@orbital/shared/remote/keys';
import { PAIRING_TOKEN_TTL_MS, signRequest } from '@orbital/shared/remote/relayApi';
import { buildRelay } from '../src/app.js';
import { openRelayStore } from '../src/store.js';
import { connectDevice, listen } from './helpers.js';

describe('pairing', () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  async function relay() {
    let now = 1_000_000;
    const store = await openRelayStore(':memory:');
    const app = await buildRelay({ store, now: () => now });
    const base = await listen(app);
    closers.push(() => app.close());
    const mac = generateIdentity();
    const phone = generateIdentity();
    const post = (path: string, body: unknown) =>
      app.inject({ method: 'POST', url: path, payload: body as any });
    return { store, app, base, mac, phone, post, tick: (ms: number) => { now += ms; }, now: () => now };
  }

  it('mints a token for a signed Mac, and redeeming it reaches the online Mac', async () => {
    const r = await relay();
    const m = await connectDevice(r.base, r.mac);
    const minted = await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()));
    expect(minted.statusCode).toBe(200);
    const { token, expiresAt } = minted.json();
    expect(expiresAt).toBe(r.now() + PAIRING_TOKEN_TTL_MS);
    const redeemed = await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, name: 'Pixel', platform: 'android' }, r.now()));
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toEqual({ mac: m.id, name: 'studio' });
    const req = await m.next('pair_request');
    expect(req).toEqual({ type: 'pair_request', phone: deviceId(r.phone.publicKey), name: 'Pixel', platform: 'android' });
    expect((await r.store.device(m.id))?.name).toBe('studio');
  });

  it('a token redeems once and not after its ttl', async () => {
    const r = await relay();
    await connectDevice(r.base, r.mac);
    const { token } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()))).json();
    const redeem = () => r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, name: 'P', platform: 'android' }, r.now()));
    expect((await redeem()).statusCode).toBe(200);
    expect((await redeem()).statusCode).toBe(404);
    const { token: late } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()))).json();
    r.tick(PAIRING_TOKEN_TTL_MS + 1);
    const lateRes = await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token: late, name: 'P', platform: 'android' }, r.now()));
    expect(lateRes.statusCode).toBe(404);
  });

  it('redeem answers 409 while the Mac is offline', async () => {
    const r = await relay();
    const { token } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()))).json();
    const res = await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, name: 'P', platform: 'android' }, r.now()));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'mac_offline' });
  });

  it('confirm pairs and tells the phone; reject tells the phone; revoke unpairs', async () => {
    const r = await relay();
    const m = await connectDevice(r.base, r.mac);
    const p = await connectDevice(r.base, r.phone);
    const { token } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()))).json();
    await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token, name: 'P', platform: 'android' }, r.now()));
    await m.next('pair_request');
    const confirmed = await r.post('/pair/confirm', signRequest(r.mac, 'pair.confirm', { phone: p.id, accept: true }, r.now()));
    expect(confirmed.statusCode).toBe(200);
    expect(await p.next('paired')).toEqual({ type: 'paired', mac: m.id, name: 'studio' });
    expect(await r.store.isPaired(m.id, p.id)).toBe(true);
    expect((await r.post('/pair/confirm', signRequest(r.mac, 'pair.confirm', { phone: p.id, accept: true }, r.now()))).statusCode).toBe(404);

    const revoked = await r.post('/pair/revoke', signRequest(r.mac, 'pair.revoke', { phone: p.id }, r.now()));
    expect(revoked.statusCode).toBe(200);
    expect(await p.next('unpaired')).toEqual({ type: 'unpaired', mac: m.id });
    expect(await r.store.isPaired(m.id, p.id)).toBe(false);

    const { token: t2 } = (await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()))).json();
    await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token: t2, name: 'P', platform: 'android' }, r.now()));
    await r.post('/pair/confirm', signRequest(r.mac, 'pair.confirm', { phone: p.id, accept: false }, r.now()));
    expect(await p.next('rejected')).toEqual({ type: 'rejected', mac: m.id });
    expect(await r.store.isPaired(m.id, p.id)).toBe(false);
  });

  it('rejects an unsigned or wrongly signed request', async () => {
    const r = await relay();
    expect((await r.post('/pair/token', { name: 'studio' })).statusCode).toBe(401);
    const wrongAction = signRequest(r.mac, 'pair.revoke', { name: 'studio' }, r.now());
    expect((await r.post('/pair/token', wrongAction)).statusCode).toBe(401);
  });
});
```

- [x] **Step 2: Run them to see them fail**

Run: `npm test -w relay -- pairing`
Expected: FAIL with 404s (no routes).

- [x] **Step 3: Implement `pairing.ts`**

```ts
/**
 * The four signed endpoints of pairing (spec 2026-09-30-mobile-remote-design
 * § 2 Pairing endpoints). Every request is verified against the identity it
 * claims; the Mac's confirmation is the step that makes a pair exist.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PAIRING_TOKEN_TTL_MS, verifyRequest } from '@orbital/shared/remote/relayApi';
import type { WsContext } from './ws.js';

export const PAIR_RATE_LIMIT_PER_MIN = 20;

const TokenPayload = z.object({ name: z.string().max(80) });
const RedeemPayload = z.object({ token: z.string(), name: z.string().max(80), platform: z.string().max(20) });
const ConfirmPayload = z.object({ phone: z.string(), accept: z.boolean() });
const RevokePayload = z.object({ phone: z.string() });

export function registerPairingRoutes(app: FastifyInstance, ctx: WsContext): void {
  const hits = new Map<string, number[]>();
  const limited = (ip: string): boolean => {
    const now = ctx.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    return recent.length > PAIR_RATE_LIMIT_PER_MIN;
  };

  /** Verifies, parses, and answers the error itself; returns null then. */
  function signed<T extends z.ZodTypeAny>(
    body: unknown, action: string, schema: T, ip: string, reply: FastifyReply,
  ): { id: string; payload: z.infer<T> } | null {
    if (limited(ip)) {
      void reply.code(429).send({ error: 'rate_limited' });
      return null;
    }
    const v = verifyRequest(body, action, ctx.now());
    if (!v.ok) {
      void reply.code(401).send({ error: v.reason });
      return null;
    }
    const parsed = schema.safeParse(v.payload);
    if (!parsed.success) {
      void reply.code(400).send({ error: 'bad_payload' });
      return null;
    }
    return { id: v.id, payload: parsed.data };
  }

  app.post('/pair/token', async (req, reply) => {
    const s = signed(req.body, 'pair.token', TokenPayload, req.ip, reply);
    if (!s) return;
    await ctx.store.upsertDevice({ id: s.id, kind: 'mac', name: s.payload.name });
    await ctx.store.pruneExpiredTokens(ctx.now());
    const expiresAt = ctx.now() + PAIRING_TOKEN_TTL_MS;
    return { token: await ctx.store.createPairingToken(s.id, expiresAt), expiresAt };
  });

  app.post('/pair/redeem', async (req, reply) => {
    const s = signed(req.body, 'pair.redeem', RedeemPayload, req.ip, reply);
    if (!s) return;
    const { token, name, platform } = s.payload;
    const peek = await ctx.store.redeemPairingToken(token, s.id, name, platform, ctx.now());
    if (!peek) return reply.code(404).send({ error: 'token_invalid' });
    // The Mac has to be online to show its confirmation (9o). The token is
    // consumed either way: the 409 tells the phone to wake the Mac and scan a
    // fresh code, which is what 9e's "scan again" does.
    if (!ctx.connections.isOnline(peek.mac)) {
      await ctx.store.rejectPair(peek.mac, s.id);
      return reply.code(409).send({ error: 'mac_offline' });
    }
    await ctx.store.upsertDevice({ id: s.id, kind: 'phone', name, platform });
    ctx.connections.sendControl(peek.mac, { type: 'pair_request', phone: s.id, name, platform });
    return { mac: peek.mac, name: (await ctx.store.device(peek.mac))?.name ?? '' };
  });

  app.post('/pair/confirm', async (req, reply) => {
    const s = signed(req.body, 'pair.confirm', ConfirmPayload, req.ip, reply);
    if (!s) return;
    const { phone, accept } = s.payload;
    if (!(await ctx.store.pending(s.id, phone))) return reply.code(404).send({ error: 'no_pending' });
    if (accept) {
      await ctx.store.confirmPair(s.id, phone, ctx.now());
      // The live connections learn about the pair now, not at their next attach.
      ctx.connections.get(s.id)?.peers.add(phone);
      ctx.connections.get(phone)?.peers.add(s.id);
      ctx.connections.sendControl(phone, { type: 'paired', mac: s.id, name: (await ctx.store.device(s.id))?.name ?? '' });
      // Both are online right now, and neither has heard about the other yet.
      ctx.connections.sendControl(s.id, { type: 'presence', peer: phone, online: ctx.connections.isOnline(phone) });
      ctx.connections.sendControl(phone, { type: 'presence', peer: s.id, online: true });
    } else {
      await ctx.store.rejectPair(s.id, phone);
      ctx.connections.sendControl(phone, { type: 'rejected', mac: s.id });
    }
    return { ok: true };
  });

  app.post('/pair/revoke', async (req, reply) => {
    const s = signed(req.body, 'pair.revoke', RevokePayload, req.ip, reply);
    if (!s) return;
    await ctx.store.revokePair(s.id, s.payload.phone);
    ctx.connections.get(s.id)?.peers.delete(s.payload.phone);
    ctx.connections.get(s.payload.phone)?.peers.delete(s.id);
    ctx.connections.sendControl(s.payload.phone, { type: 'unpaired', mac: s.id });
    return { ok: true };
  });
}
```

In `app.ts`, after the `/health` route: `registerPairingRoutes(app, ctx);` with the import.

- [x] **Step 4: Run the tests**

Run: `npm test -w relay && npm run typecheck -w relay`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add relay/src/pairing.ts relay/src/app.ts relay/test/pairing.test.ts
git commit -m "feat(relay): signed pairing endpoints"
```

---

### Task 9: Push — the wake tracker and the FCM sender

**Files:**
- Create: `relay/src/push.ts`
- Modify: `relay/src/app.ts`, `relay/src/index.ts`
- Test: `relay/test/push.test.ts`

**Interfaces:**
- Consumes: `WakeHook` (7), `RelayStore` (6), `CONFIG` (6).
- Produces: `interface PushSender { send(token: string, payload: { macName: string; count: number }): Promise<void> }`, `class LogPushSender`, `class FcmPushSender`, `class WakeTracker` (`add(phone, wake): number`, `clear(phone)`), `wakeHook(store, tracker, sender): WakeHook`, `loadServiceAccount(path)`.

Push text is fixed (9g): title `Orbital · <macName>`, body `A session needs your input` or `<count> sessions need your input`. The relay sends on every wake frame that meets an offline phone; the Mac debounces per session, so a repeat here is a repeat on purpose.

- [x] **Step 1: Write the failing tests**

`relay/test/push.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { FcmPushSender, WakeTracker, pushText, wakeHook } from '../src/push.js';
import { openRelayStore } from '../src/store.js';

describe('WakeTracker', () => {
  it('counts distinct wake tokens per phone until cleared', () => {
    const t = new WakeTracker();
    const a = new Uint8Array(16).fill(1);
    const b = new Uint8Array(16).fill(2);
    expect(t.add('p', a)).toBe(1);
    expect(t.add('p', a)).toBe(1);
    expect(t.add('p', b)).toBe(2);
    expect(t.add('q', a)).toBe(1);
    t.clear('p');
    expect(t.add('p', a)).toBe(1);
  });
});

describe('pushText', () => {
  it('names the Mac and pluralises', () => {
    expect(pushText('studio', 1)).toEqual({ title: 'Orbital · studio', body: 'A session needs your input' });
    expect(pushText('studio', 3)).toEqual({ title: 'Orbital · studio', body: '3 sessions need your input' });
  });
});

describe('wakeHook', () => {
  it('sends to the phone token with the running count, and skips a phone without a token', async () => {
    const store = await openRelayStore(':memory:');
    await store.upsertDevice({ id: 'mac', kind: 'mac', name: 'studio' });
    await store.upsertDevice({ id: 'phone', kind: 'phone', name: 'Pixel' });
    await store.setPushToken('phone', 'fcm-1');
    await store.upsertDevice({ id: 'mute', kind: 'phone', name: 'NoToken' });
    const sender = { send: vi.fn(async () => {}) };
    const hook = wakeHook(store, new WakeTracker(), sender);
    await hook('mac', 'phone', new Uint8Array(16).fill(1));
    await hook('mac', 'phone', new Uint8Array(16).fill(2));
    await hook('mac', 'mute', new Uint8Array(16).fill(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(sender.send.mock.calls).toEqual([
      ['fcm-1', { macName: 'studio', count: 1 }],
      ['fcm-1', { macName: 'studio', count: 2 }],
    ]);
  });
});

describe('FcmPushSender', () => {
  it('exchanges a service-account JWT for a bearer and posts the message', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
      return new Response('{}', { status: 200 });
    });
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const sender = new FcmPushSender(
      { project_id: 'proj', client_email: 'svc@proj.iam', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' },
      fetchImpl as any,
      () => 1_700_000_000_000,
    );
    await sender.send('fcm-1', { macName: 'studio', count: 1 });
    await sender.send('fcm-1', { macName: 'studio', count: 2 });
    expect(calls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://fcm.googleapis.com/v1/projects/proj/messages:send',
      'https://fcm.googleapis.com/v1/projects/proj/messages:send',
    ]);
    const sent = JSON.parse(calls[1].init.body as string);
    expect(sent.message.token).toBe('fcm-1');
    expect(sent.message.notification).toEqual({ title: 'Orbital · studio', body: 'A session needs your input' });
    expect(sent.message.android.collapse_key).toBe('needs-input');
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
});
```

- [x] **Step 2: Run them to see them fail**

Run: `npm test -w relay -- push`
Expected: FAIL, module not found.

- [x] **Step 3: Implement `push.ts`**

```ts
/**
 * The one thing the relay says to a phone that is not connected: a generic
 * push, through Firebase Cloud Messaging, counting how many sessions wait
 * without knowing which (spec 2026-09-30-mobile-remote-design § 5).
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RelayStore } from './store.js';
import type { WakeHook } from './ws.js';

export type PushPayload = { macName: string; count: number };

export interface PushSender {
  send(token: string, payload: PushPayload): Promise<void>;
}

export class LogPushSender implements PushSender {
  async send(token: string, payload: PushPayload): Promise<void> {
    console.log(`push (not sent, no FCM configured) to ${token.slice(0, 8)}…`, payload);
  }
}

/** Distinct wake tokens per phone since it was last online. */
export class WakeTracker {
  private pending = new Map<string, Set<string>>();

  add(phone: string, wake: Uint8Array): number {
    let set = this.pending.get(phone);
    if (!set) {
      set = new Set();
      this.pending.set(phone, set);
    }
    set.add(Buffer.from(wake).toString('hex'));
    return set.size;
  }

  clear(phone: string): void {
    this.pending.delete(phone);
  }
}

export function pushText(macName: string, count: number): { title: string; body: string } {
  return {
    title: `Orbital · ${macName}`,
    body: count === 1 ? 'A session needs your input' : `${count} sessions need your input`,
  };
}

export function wakeHook(store: RelayStore, tracker: WakeTracker, sender: PushSender): WakeHook {
  return async (from, to, wake) => {
    try {
      const phone = await store.device(to);
      if (!phone?.pushToken) return;
      const count = tracker.add(to, wake);
      const macName = (await store.device(from))?.name || 'your Mac';
      await sender.send(phone.pushToken, { macName, count });
    } catch (err) {
      console.warn('push failed', err instanceof Error ? err.message : err);
    }
  };
}

export type ServiceAccount = {
  project_id: string; client_email: string; private_key: string; token_uri: string;
};

export function loadServiceAccount(path: string): ServiceAccount {
  return JSON.parse(readFileSync(path, 'utf8')) as ServiceAccount;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export class FcmPushSender implements PushSender {
  private bearer: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly account: ServiceAccount,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async send(token: string, payload: PushPayload): Promise<void> {
    const { title, body } = pushText(payload.macName, payload.count);
    const res = await this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title, body },
            android: { collapse_key: 'needs-input', priority: 'high', notification: { channel_id: 'needs_input' } },
            apns: { headers: { 'apns-collapse-id': 'needs-input' } },
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`fcm ${res.status}`);
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.bearer && this.bearer.expiresAt > now + 60_000) return this.bearer.token;
    const iat = Math.floor(now / 1000);
    const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64(JSON.stringify({
      iss: this.account.client_email, scope: FCM_SCOPE, aud: this.account.token_uri, iat, exp: iat + 3600,
    }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const jwt = `${header}.${claims}.${signer.sign(this.account.private_key, 'base64url')}`;
    const res = await this.fetchImpl(this.account.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
    });
    if (!res.ok) throw new Error(`oauth ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.bearer = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
    return json.access_token;
  }
}

function b64(text: string): string {
  return Buffer.from(text).toString('base64url');
}
```

- [x] **Step 4: Wire it**

`app.ts`: `RelayOptions` gains `push?: PushSender`; when `onWake` is not given, build `wakeHook(opts.store, tracker, opts.push ?? new LogPushSender())` with a `WakeTracker` held on `ctx` (add `tracker: WakeTracker` to `WsContext`), and in `ws.ts` `attach()` call `ctx.tracker.clear(id)` right after `connections.add` — a phone that came online has seen everything.

`index.ts`: `push: CONFIG.fcmServiceAccountPath ? new FcmPushSender(loadServiceAccount(CONFIG.fcmServiceAccountPath)) : new LogPushSender()`.

- [x] **Step 5: Run everything in the relay**

Run: `npm test -w relay && npm run typecheck -w relay && npm run build -w relay`
Expected: PASS; `relay/dist/index.mjs` exists.

- [x] **Step 6: Commit**

```bash
git add relay/src relay/test
git commit -m "feat(relay): wake tracking and FCM push for offline phones"
```

---

### Task 10: Mac identity, the paired-devices table and the settings rows

**Files:**
- Create: `server/src/remote/identity.ts`, `server/src/remote/devices.ts`
- Modify: `server/src/db/schema.ts` (new table), `server/src/db/database.ts` (`DEFAULT_SETTINGS`), `server/package.json` (dependency on `@orbital/shared`)
- Create: `server/drizzle/0021_remote_devices.sql` + meta (generated)
- Test: `server/test/remoteDevices.test.ts`

**Interfaces:**
- Consumes: `generateIdentity`, `identityFromSecret`, `toBase64Url`, `fromBase64Url`, `type Identity` (1); `NotificationSettings` (4).
- Produces: `loadOrCreateIdentity(dataDir): Identity`, `IDENTITY_FILE` (`remote-identity.json`), `macDisplayName(stored: string, hostname?: string): string`, `class DeviceStore` (`list()`, `get(id)`, `add(d)`, `remove(id)`, `touch(id, now)`, `setNotifications(id, s)`), `type RemoteDeviceRow`.

- [x] **Step 1: Schema and migration**

`server/package.json` dependencies: add `"@orbital/shared": "*"`. Run `npm install`.

`server/src/db/schema.ts`, after `narrations`:

```ts
/**
 * Phones paired with this Mac (spec 2026-09-30-mobile-remote-design § 3).
 * `id` is the phone's device id (its public key, base64url). `notifications`
 * is the phone's own five rows as JSON — copied from the desktop's at pairing
 * and edited only from the phone (§ 5).
 */
export const remoteDevices = sqliteTable('remote_devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  pairedAt: integer('paired_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  notifications: text('notifications').notNull(),
});
export type RemoteDeviceRow = typeof remoteDevices.$inferSelect;
```

Run: `npm run db:generate -w server -- --name remote_devices`
Expected: `server/drizzle/0021_remote_devices.sql` with one `CREATE TABLE`, and `meta/0021_snapshot.json` + a new `_journal.json` entry.

`server/src/db/database.ts` `DEFAULT_SETTINGS`, at the end:

```ts
  /**
   * Mobile remote (spec 2026-09-30-mobile-remote-design). Off by default:
   * nothing connects anywhere until the user turns it on in Settings → Mobile.
   */
  remote_enabled: 'false',
  /** Empty means the hosted default, `DEFAULT_RELAY_URL`; anyone may run their own. */
  remote_relay_url: '',
  /** Empty means the machine's network name (`macDisplayName`). */
  remote_mac_name: '',
```

- [x] **Step 2: Write the failing test**

`server/test/remoteDevices.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { DeviceStore } from '../src/remote/devices.js';
import { IDENTITY_FILE, loadOrCreateIdentity, macDisplayName } from '../src/remote/identity.js';

const settings = { needsInput: true, sessionEnded: false, sessionFailed: true, onlyWhenBackground: true, sound: true };

describe('identity', () => {
  it('creates a private key file once and reads it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-remote-'));
    const a = loadOrCreateIdentity(dir);
    const b = loadOrCreateIdentity(dir);
    expect(b.publicKey).toEqual(a.publicKey);
    expect(statSync(join(dir, IDENTITY_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, IDENTITY_FILE), 'utf8'))).toHaveProperty('secretKey');
  });
  it('display name prefers the stored one and strips .local from the hostname', () => {
    expect(macDisplayName('studio', 'Tomas-MacBook-Pro.local')).toBe('studio');
    expect(macDisplayName('', 'Tomas-MacBook-Pro.local')).toBe('Tomas-MacBook-Pro');
    expect(macDisplayName('  ', 'box')).toBe('box');
  });
});

describe('DeviceStore', () => {
  it('adds, lists, touches, updates notifications and removes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-remote-'));
    const db = openDb(join(dir, 'index.db'));
    const store = new DeviceStore(db);
    store.add({ id: 'p1', name: 'Pixel', platform: 'android', pairedAt: 10, notifications: settings });
    expect(store.list()).toEqual([{ id: 'p1', name: 'Pixel', platform: 'android', pairedAt: 10, lastSeenAt: null, notifications: settings }]);
    store.touch('p1', 20);
    expect(store.get('p1')?.lastSeenAt).toBe(20);
    store.setNotifications('p1', { ...settings, sound: false });
    expect(store.get('p1')?.notifications.sound).toBe(false);
    store.remove('p1');
    expect(store.get('p1')).toBeNull();
    expect(store.list()).toEqual([]);
  });
  it('a row with unreadable notifications falls back to every flag on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-remote-'));
    const db = openDb(join(dir, 'index.db'));
    const store = new DeviceStore(db);
    store.add({ id: 'p1', name: 'Pixel', platform: 'android', pairedAt: 10, notifications: settings });
    db.run(`UPDATE remote_devices SET notifications = 'junk' WHERE id = 'p1'` as any);
    expect(store.get('p1')?.notifications).toEqual({ needsInput: true, sessionEnded: true, sessionFailed: true, onlyWhenBackground: true, sound: true });
  });
});
```

If `db.run` with a raw string does not type-check, use `import { sql } from 'drizzle-orm'` and `db.run(sql\`UPDATE remote_devices SET notifications = 'junk' WHERE id = 'p1'\`)`.

- [x] **Step 3: Run it to see it fail**

Run: `npm test -w server -- remoteDevices`
Expected: FAIL, modules not found.

- [x] **Step 4: Implement `identity.ts`**

```ts
/**
 * This Mac's identity on the relay: one Ed25519 pair in the data dir, made
 * the first time the feature is enabled and never rotated by the app (spec
 * 2026-09-30-mobile-remote-design § 1). A Node process has no Keychain, so
 * the file's mode is the whole protection — the same as the SQLite file
 * beside it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  fromBase64Url, generateIdentity, identityFromSecret, toBase64Url, type Identity,
} from '@orbital/shared/remote/keys';

export const IDENTITY_FILE = 'remote-identity.json';

export function loadOrCreateIdentity(dataDir: string): Identity {
  const path = join(dataDir, IDENTITY_FILE);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { secretKey?: string };
    if (typeof raw.secretKey === 'string') return identityFromSecret(fromBase64Url(raw.secretKey));
  }
  const identity = generateIdentity();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, JSON.stringify({ secretKey: toBase64Url(identity.secretKey) }), { mode: 0o600 });
  return identity;
}

/** The stored name, or the machine's network name without Bonjour's suffix. */
export function macDisplayName(stored: string, host: string = hostname()): string {
  const name = stored.trim();
  if (name) return name;
  return host.replace(/\.local$/i, '');
}
```

- [x] **Step 5: Implement `devices.ts`**

```ts
import { eq } from 'drizzle-orm';
import { NotificationSettingsSchema, type NotificationSettings } from '@orbital/shared/remote/messages';
import { remoteDevices } from '../db/schema.js';
import type { OrbitalDb } from '../db/database.js';

export type RemoteDevice = {
  id: string; name: string; platform: string; pairedAt: number; lastSeenAt: number | null;
  notifications: NotificationSettings;
};

const ALL_ON: NotificationSettings = {
  needsInput: true, sessionEnded: true, sessionFailed: true, onlyWhenBackground: true, sound: true,
};

/** The phones paired with this Mac (spec 2026-09-30-mobile-remote-design § 3). */
export class DeviceStore {
  constructor(private readonly db: OrbitalDb) {}

  list(): RemoteDevice[] {
    return this.db.select().from(remoteDevices).orderBy(remoteDevices.pairedAt).all().map(fromRow);
  }

  get(id: string): RemoteDevice | null {
    const row = this.db.select().from(remoteDevices).where(eq(remoteDevices.id, id)).get();
    return row ? fromRow(row) : null;
  }

  add(d: Omit<RemoteDevice, 'lastSeenAt'>): void {
    this.db.insert(remoteDevices).values({
      id: d.id, name: d.name, platform: d.platform, pairedAt: d.pairedAt,
      notifications: JSON.stringify(d.notifications),
    }).onConflictDoUpdate({
      target: remoteDevices.id,
      set: { name: d.name, platform: d.platform, pairedAt: d.pairedAt, notifications: JSON.stringify(d.notifications) },
    }).run();
  }

  remove(id: string): void {
    this.db.delete(remoteDevices).where(eq(remoteDevices.id, id)).run();
  }

  touch(id: string, now: number): void {
    this.db.update(remoteDevices).set({ lastSeenAt: now }).where(eq(remoteDevices.id, id)).run();
  }

  setNotifications(id: string, settings: NotificationSettings): void {
    this.db.update(remoteDevices).set({ notifications: JSON.stringify(settings) }).where(eq(remoteDevices.id, id)).run();
  }
}

function fromRow(row: typeof remoteDevices.$inferSelect): RemoteDevice {
  let notifications = ALL_ON;
  try {
    const parsed = NotificationSettingsSchema.safeParse(JSON.parse(row.notifications));
    if (parsed.success) notifications = parsed.data;
  } catch {
    // Unreadable JSON reads as "every flag on", the same default a fresh pairing gets.
  }
  return {
    id: row.id, name: row.name, platform: row.platform, pairedAt: row.pairedAt,
    lastSeenAt: row.lastSeenAt, notifications,
  };
}
```

- [x] **Step 6: Run the tests**

Run: `npm test -w server -- remoteDevices && npm test -w server -- database && npm run typecheck -w server`
Expected: PASS. `database.test.ts` may assert the full `DEFAULT_SETTINGS` key list; if so, add the three keys there.

- [x] **Step 7: Commit**

```bash
git add server/src/remote/identity.ts server/src/remote/devices.ts server/src/db/schema.ts server/src/db/database.ts server/drizzle server/package.json package-lock.json server/test/remoteDevices.test.ts server/test/database.test.ts
git commit -m "feat(server): remote identity, paired devices table and settings rows"
```

---

### Task 11: The notification rules move to `shared/`

**Files:**
- Create: `shared/src/notifications.ts` (moved from `desktop/src/lib/notifications.ts`)
- Modify: `desktop/src/lib/notifications.ts` (becomes a re-export), `desktop/package.json` (depend on `@orbital/shared`)
- Move test: `desktop/test/notifications.test.ts` → `shared/test/notifications.test.ts` (find the file with `ls desktop/test | grep -i notif`; keep its contents, fix the import path)

**Interfaces:**
- Consumes: nothing.
- Produces: `SessionNotifier`, `NotificationSettings`, `DEFAULT_NOTIFICATION_SETTINGS`, `parseNotificationSettings`, `DesktopNotification` (renamed `SessionNotification`; desktop keeps `DesktopNotification` as an alias) — all exported from `@orbital/shared/notifications`.

The spec (§ 3, § 5) wants one set of rules deciding both the desktop's notifications and the Mac's `wake` frames. The class is already pure (it imports nothing from electron); it moves, and the desktop keeps importing the same names from the same path.

- [x] **Step 1: Move the file**

```bash
git mv desktop/src/lib/notifications.ts shared/src/notifications.ts
git mv desktop/test/notifications.test.ts shared/test/notifications.test.ts
```

In `shared/src/notifications.ts`: rename `DesktopNotification` to `SessionNotification` and add `export type DesktopNotification = SessionNotification;` below it. Replace `import { basename } from 'node:path'` with a local helper — the file will later be bundled for a WebView where `node:path` does not exist:

```ts
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}
```

In `shared/test/notifications.test.ts`: the import becomes `'../src/notifications.js'`. `NotificationSettings` here and `NotificationSettings` from `messages.ts` (Task 4) have the same five fields; make `notifications.ts` import the type from `./remote/messages.js` and delete its own declaration so there is one.

- [x] **Step 2: The desktop re-exports**

`desktop/src/lib/notifications.ts`:

```ts
/**
 * The rules live in `@orbital/shared/notifications` now, because the Mac's
 * remote module applies the same fold to decide `wake` frames for a phone
 * (spec 2026-09-30-mobile-remote-design § 5). Nothing in the desktop changes.
 */
export * from '@orbital/shared/notifications';
```

`desktop/package.json`: add `"dependencies": { "@orbital/shared": "*" }` (the file has only devDependencies today). Run `npm install`.

- [x] **Step 3: Run every suite that touches it**

Run: `npm test -w shared && npm test -w desktop && npm run typecheck -w desktop && npm run build -w desktop`
Expected: PASS; `desktop/dist/main.cjs` builds with the shared code inlined (esbuild follows the symlink).

- [x] **Step 4: Commit**

```bash
git add shared/src/notifications.ts shared/test/notifications.test.ts desktop/src/lib/notifications.ts desktop/test desktop/package.json package-lock.json
git commit -m "refactor: session notification rules move to shared for the remote wake"
```

---

### Task 12: The allowlist

**Files:**
- Create: `server/src/remote/allowlist.ts`
- Test: `server/test/remoteAllowlist.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isAllowed(method: string, path: string): boolean`, `ALLOWED_ROUTES` (readonly list of `[method, template]`).

- [x] **Step 1: Write the failing test**

`server/test/remoteAllowlist.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isAllowed } from '../src/remote/allowlist.js';

describe('remote allowlist', () => {
  it('allows the session, decision, spawn and catalogue routes', () => {
    for (const [m, p] of [
      ['GET', '/api/sessions'], ['GET', '/api/sessions/abc'], ['GET', '/api/sessions/abc/messages'],
      ['GET', '/api/sessions/abc/messages?limit=30&before=x'],
      ['GET', '/api/sessions/abc/subagents/toolu_1/messages'],
      ['POST', '/api/sessions'], ['POST', '/api/sessions/abc/messages'],
      ['POST', '/api/sessions/abc/decision/d1'], ['POST', '/api/sessions/abc/interrupt'],
      ['POST', '/api/sessions/abc/model'], ['POST', '/api/sessions/abc/permission-mode'],
      ['POST', '/api/sessions/abc/end'], ['POST', '/api/sessions/abc/reopen'], ['POST', '/api/sessions/abc/clear'],
      ['PATCH', '/api/sessions/abc'], ['PUT', '/api/sessions/abc/pinned'], ['PUT', '/api/sessions/abc/tags'],
      ['POST', '/api/sessions/abc/tasks/t1/stop'], ['GET', '/api/sessions/abc/tasks/t1/output'],
      ['GET', '/api/tags'], ['GET', '/api/projects'], ['GET', '/api/models'], ['GET', '/api/commands'],
      ['GET', '/api/sessions/abc/walkthrough'], ['GET', '/api/sessions/abc/walkthrough/summary'],
      ['GET', '/api/health'],
    ]) expect(isAllowed(m, p), `${m} ${p}`).toBe(true);
  });
  it('denies the file system, the editor, settings, errors, rules and dev routes', () => {
    for (const [m, p] of [
      ['GET', '/api/files?path=/etc/passwd'], ['GET', '/api/files/complete'], ['GET', '/api/commands/content'],
      ['GET', '/api/sessions/abc/ide/open-files'], ['POST', '/api/sessions/abc/ide/open-file'],
      ['GET', '/api/settings'], ['PATCH', '/api/settings'], ['PATCH', '/api/settings/'],
      ['GET', '/api/errors'], ['POST', '/api/errors'], ['GET', '/api/tag-rules'], ['POST', '/api/tag-rules/preview'],
      ['POST', '/api/tags'], ['DELETE', '/api/tags/1'], ['POST', '/api/dev/sessions/abc/simulate-compaction'],
      ['POST', '/api/attachments'], ['POST', '/api/sessions/abc/attachments'], ['GET', '/api/images/abc.png'],
      ['POST', '/api/sessions/abc/rewind'], ['POST', '/api/sessions/abc/retitle'],
      ['POST', '/api/sessions/abc/walkthrough/narrate'], ['POST', '/api/models/validate'],
      ['POST', '/api/branch-status/refresh'], ['GET', '/api/sessions/retention-preview'],
      ['GET', '/api/remote'], ['POST', '/api/remote/pair'], ['DELETE', '/api/remote/devices/x'],
      ['GET', '/ws'], ['GET', '/'], ['GET', '/index.html'],
    ]) expect(isAllowed(m, p), `${m} ${p}`).toBe(false);
  });
  it('is strict about shape: method case, traversal, empty segments, encoded slashes', () => {
    expect(isAllowed('get', '/api/sessions')).toBe(false);
    expect(isAllowed('GET', '/api/sessions/../files')).toBe(false);
    expect(isAllowed('GET', '/api/sessions//messages')).toBe(false);
    expect(isAllowed('GET', '/api/sessions/a%2F..%2Fx/messages')).toBe(false);
    expect(isAllowed('GET', '/api/sessions/abc/')).toBe(true);
    expect(isAllowed('GET', 'api/sessions')).toBe(false);
  });
});
```

Note `GET /api/sessions/retention-preview` is denied while `GET /api/sessions/:id` is allowed: the literal segment `retention-preview` is checked before the template.

- [x] **Step 2: Run it to see it fail**

Run: `npm test -w server -- remoteAllowlist`
Expected: FAIL, module not found.

- [x] **Step 3: Implement `allowlist.ts`**

```ts
/**
 * What a phone may call through the tunnel. A literal list, not a pattern:
 * every route is named, and a new route on the server is NOT reachable from
 * a phone until someone adds it here (spec 2026-09-30-mobile-remote-design
 * § 3). What is missing is as deliberate as what is present — see the spec's
 * Global Constraints in the backend plan for the denied set and why.
 */
export const ALLOWED_ROUTES: readonly (readonly [method: string, template: string])[] = [
  ['GET', '/api/health'],
  ['GET', '/api/sessions'],
  ['GET', '/api/sessions/count'],
  ['POST', '/api/sessions'],
  ['GET', '/api/sessions/:id'],
  ['PATCH', '/api/sessions/:id'],
  ['GET', '/api/sessions/:id/messages'],
  ['POST', '/api/sessions/:id/messages'],
  ['GET', '/api/sessions/:id/subagents/:toolUseId/messages'],
  ['POST', '/api/sessions/:id/tasks/:taskId/stop'],
  ['GET', '/api/sessions/:id/tasks/:taskId/output'],
  ['PUT', '/api/sessions/:id/pinned'],
  ['PUT', '/api/sessions/:id/tags'],
  ['POST', '/api/sessions/:id/decision/:decisionId'],
  ['POST', '/api/sessions/:id/interrupt'],
  ['POST', '/api/sessions/:id/model'],
  ['POST', '/api/sessions/:id/permission-mode'],
  ['POST', '/api/sessions/:id/end'],
  ['POST', '/api/sessions/:id/reopen'],
  ['POST', '/api/sessions/:id/clear'],
  ['GET', '/api/sessions/:id/walkthrough'],
  ['GET', '/api/sessions/:id/walkthrough/summary'],
  ['GET', '/api/tags'],
  ['GET', '/api/projects'],
  ['GET', '/api/models'],
  ['GET', '/api/commands'],
];

/** Literal paths that would otherwise match a `:id` template. */
const RESERVED_SEGMENTS = new Set(['retention-preview', 'count']);

export function isAllowed(method: string, rawPath: string): boolean {
  const path = rawPath.split('?')[0].replace(/\/+$/, '') || '/';
  if (!path.startsWith('/')) return false;
  const segments = path.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('%'))) return false;
  for (const [m, template] of ALLOWED_ROUTES) {
    if (m !== method) continue;
    const parts = template.slice(1).split('/');
    if (parts.length !== segments.length) continue;
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      if (parts[i].startsWith(':')) ok = !RESERVED_SEGMENTS.has(segments[i]);
      else ok = parts[i] === segments[i];
    }
    if (ok) return true;
  }
  return false;
}
```

- [x] **Step 4: Run the tests**

Run: `npm test -w server -- remoteAllowlist`
Expected: PASS. (`GET /api/sessions/count` is allowed by its own literal line and `count` is reserved so `/api/sessions/:id` never claims it.)

- [x] **Step 5: Commit**

```bash
git add server/src/remote/allowlist.ts server/test/remoteAllowlist.test.ts
git commit -m "feat(server): the remote allowlist"
```

---

### Task 13: The Mac's relay client

**Files:**
- Create: `server/src/remote/relayClient.ts`
- Test: `server/test/remoteRelayClient.test.ts`

**Interfaces:**
- Consumes: `Identity`, `deviceId` (1); `RelayToDevice`, `DeviceToRelay`, `authSignature`, `relayWsUrl`, `signRequest` (5).
- Produces: `class RelayClient extends EventEmitter` with `constructor(opts: { relayUrl: string; identity: Identity; WebSocketImpl?: typeof WebSocket; fetchImpl?: typeof fetch; reconnectDelayMs?: number })`, `start()`, `stop()`, `status: 'off' | 'connecting' | 'online'`, `sendData(frame: Uint8Array): boolean`, `post<T>(path, action, payload): Promise<{ status: number; body: T }>`, `peersOnline: Set<string>`; events `status(status)`, `control(msg: RelayToDevice)`, `data(frame: Uint8Array)`. `RECONNECT_DELAY_MS` (3000), `RECONNECT_MAX_MS` (30000).

This is the same job `web/src/lib/ws.ts` does towards the server, in Node: connect, authenticate, reconnect with backoff, and tell everyone when the state changes. `post` is the signed HTTP side for pairing.

- [x] **Step 1: Write the failing test**

`server/test/remoteRelayClient.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { generateIdentity, deviceId, publicKeyOf } from '@orbital/shared/remote/keys';
import { verifyAuthSignature } from '@orbital/shared/remote/relayApi';
import { RelayClient } from '../src/remote/relayClient.js';

/** A relay stand-in: challenges, checks the signature, then echoes binary frames back. */
function fakeRelay() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const sockets: WebSocket[] = [];
  let authed: string[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify({ type: 'challenge', nonce: 'n-' + sockets.length }));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return ws.send(raw);
      const msg = JSON.parse(String(raw));
      if (msg.type === 'auth') {
        const ok = verifyAuthSignature(publicKeyOf(msg.pub)!, 'n-' + sockets.length, msg.sig);
        if (!ok) return ws.close(4001);
        authed.push(msg.pub);
        ws.send(JSON.stringify({ type: 'ok', peers: ['peer-a'] }));
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, sockets, authed: () => authed, close: () => wss.close() };
}

describe('RelayClient', () => {
  const closers: (() => void)[] = [];
  afterEach(() => closers.splice(0).forEach((c) => c()));

  it('authenticates, reports online with the peers, round-trips data, and reconnects after a drop', async () => {
    const relay = fakeRelay();
    closers.push(relay.close);
    const me = generateIdentity();
    const client = new RelayClient({ relayUrl: relay.url, identity: me, reconnectDelayMs: 20 });
    closers.push(() => client.stop());
    const statuses: string[] = [];
    client.on('status', (s) => statuses.push(s));
    client.start();
    await waitFor(() => client.status === 'online');
    expect(relay.authed()).toEqual([deviceId(me.publicKey)]);
    expect([...client.peersOnline]).toEqual(['peer-a']);

    const got = new Promise<Uint8Array>((r) => client.once('data', r));
    expect(client.sendData(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(await got).toEqual(new Uint8Array([1, 2, 3]));

    relay.sockets[0].close();
    await waitFor(() => client.status === 'connecting');
    await waitFor(() => client.status === 'online');
    expect(relay.authed()).toHaveLength(2);
    expect(statuses).toEqual(['connecting', 'online', 'connecting', 'online']);
  });

  it('sendData answers false while offline and stop() ends reconnecting', async () => {
    const relay = fakeRelay();
    closers.push(relay.close);
    const client = new RelayClient({ relayUrl: relay.url, identity: generateIdentity(), reconnectDelayMs: 20 });
    expect(client.sendData(new Uint8Array([1]))).toBe(false);
    client.start();
    await waitFor(() => client.status === 'online');
    client.stop();
    expect(client.status).toBe('off');
    await new Promise((r) => setTimeout(r, 60));
    expect(relay.authed()).toHaveLength(1);
  });

  it('post signs the body and parses the answer', async () => {
    const seen: unknown[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ token: 't', expiresAt: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const me = generateIdentity();
    const client = new RelayClient({ relayUrl: 'http://relay.test', identity: me, fetchImpl });
    const res = await client.post<{ token: string }>('/pair/token', 'pair.token', { name: 'studio' });
    expect(res).toEqual({ status: 200, body: { token: 't', expiresAt: 1 } });
    expect(seen[0]).toMatchObject({ url: 'http://relay.test/pair/token', body: { pub: deviceId(me.publicKey), payload: { name: 'studio' } } });
  });
});

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
```

- [x] **Step 2: Run it to see it fail**

Run: `npm test -w server -- remoteRelayClient`
Expected: FAIL, module not found.

- [x] **Step 3: Implement `relayClient.ts`**

```ts
/**
 * The Mac's one outbound connection to the relay: challenge → signed auth →
 * frames, and back again after every drop with a growing delay. Mirrors what
 * `web/src/lib/ws.ts` does towards this server (spec
 * 2026-09-22-ws-reconnect-resync-design), minus topics — the relay has none.
 * The Mac never listens; this socket is the only way in (spec
 * 2026-09-30-mobile-remote-design § 3).
 */
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { deviceId, type Identity } from '@orbital/shared/remote/keys';
import {
  RelayToDevice, authSignature, relayWsUrl, signRequest, type DeviceToRelay,
} from '@orbital/shared/remote/relayApi';

export const RECONNECT_DELAY_MS = 3_000;
export const RECONNECT_MAX_MS = 30_000;

export type RelayStatus = 'off' | 'connecting' | 'online';

export type RelayClientOptions = {
  relayUrl: string;
  identity: Identity;
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  reconnectDelayMs?: number;
};

export class RelayClient extends EventEmitter {
  status: RelayStatus = 'off';
  readonly peersOnline = new Set<string>();
  private ws: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly fetchImpl: typeof fetch;
  private readonly baseDelay: number;

  constructor(private readonly opts: RelayClientOptions) {
    super();
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseDelay = opts.reconnectDelayMs ?? RECONNECT_DELAY_MS;
  }

  get id(): string {
    return deviceId(this.opts.identity.publicKey);
  }

  start(): void {
    if (this.status !== 'off') return;
    this.connect();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    this.setStatus('off');
    ws?.close();
  }

  sendData(frame: Uint8Array): boolean {
    if (this.status !== 'online' || !this.ws) return false;
    try {
      this.ws.send(frame, { binary: true });
      return true;
    } catch {
      return false;
    }
  }

  sendControl(msg: DeviceToRelay): boolean {
    if (this.status !== 'online' || !this.ws) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  async post<T>(path: string, action: string, payload: unknown): Promise<{ status: number; body: T }> {
    const res = await this.fetchImpl(new URL(path, this.opts.relayUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signRequest(this.opts.identity, action, payload)),
    });
    const text = await res.text();
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = { error: text } as T;
    }
    return { status: res.status, body };
  }

  private connect(): void {
    this.setStatus('connecting');
    const ws = new this.WebSocketImpl(relayWsUrl(this.opts.relayUrl, this.id));
    this.ws = ws;
    ws.on('message', (raw, isBinary) => {
      if (this.ws !== ws) return;
      if (isBinary) {
        const buf = raw as Buffer;
        this.emit('data', new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        return;
      }
      let msg: RelayToDevice;
      try {
        msg = RelayToDevice.parse(JSON.parse(String(raw)));
      } catch {
        return;
      }
      if (msg.type === 'challenge') {
        ws.send(JSON.stringify({ type: 'auth', pub: this.id, sig: authSignature(this.opts.identity, msg.nonce) }));
        return;
      }
      if (msg.type === 'ok') {
        this.attempt = 0;
        this.peersOnline.clear();
        for (const p of msg.peers) this.peersOnline.add(p);
        this.setStatus('online');
      }
      if (msg.type === 'presence') {
        if (msg.online) this.peersOnline.add(msg.peer);
        else this.peersOnline.delete(msg.peer);
      }
      this.emit('control', msg);
    });
    ws.on('error', () => { /* close follows; that is where we react */ });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.peersOnline.clear();
      if (this.status === 'off') return;
      this.setStatus('connecting');
      const delay = Math.min(this.baseDelay * 2 ** this.attempt++, RECONNECT_MAX_MS);
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }

  private setStatus(status: RelayStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }
}
```

- [x] **Step 4: Run the tests**

Run: `npm test -w server -- remoteRelayClient`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add server/src/remote/relayClient.ts server/test/remoteRelayClient.test.ts
git commit -m "feat(server): outbound relay client with signed auth and reconnect"
```

---

### Task 14: Phone session and device watcher

**Files:**
- Create: `server/src/remote/phoneSession.ts`, `server/src/remote/deviceWatcher.ts`, `server/src/remote/wake.ts`
- Modify: `server/package.json` (dependency on `@noble/hashes`)
- Test: `server/test/remotePhoneSession.test.ts`

**Interfaces:**
- Consumes: `Hub` (existing `server/src/api/hub.ts`), `ImageStore` (existing), `startHandshake`, `SessionCipher` (3), `encodeInner`, `decodeInner`, `chunkBlob`, `PhoneMessage`, `MacMessage`, `PROTOCOL_VERSION`, `NotificationSettings` (4), `encodeFrame`, `FLAG_WAKE`, `FLAG_STATE`, `ZERO_WAKE` (2), `SessionNotifier` (11), `allowedPath` (12), `DeviceStore` (10).
- Produces:
  - `wakeToken(secret: Uint8Array, sessionId: string): Uint8Array` (16 bytes, HMAC-SHA256 truncated), `wakeSecret(identity): Uint8Array`.
  - `class DeviceWatcher` — `constructor(opts: { deviceId: string; hub: Hub; settings: () => NotificationSettings; onWake: (sessionId: string) => void })`, `start(initialSessions: unknown[])`, `seen(sessionId)`, `stop()`.
  - `class PhoneSession` — `constructor(opts: PhoneSessionOptions)`, `receive(body: Uint8Array): void` (one decrypted-or-handshake frame body), `close(reason?: 'protocol' | 'revoked')`, `readonly ready: boolean`; `PhoneSessionOptions = { deviceId, identity, phonePublicKey, hub, inject: (req: { method; url; payload? }) => Promise<{ statusCode: number; body: string }>, images: ImageStore, imagesDir: string, serverVersion: string, macName: string, notifications: { get(): NotificationSettings; set(s): void }, send: (body: Uint8Array) => void, onSeen: (sessionId) => void, onClose: () => void }`.
  - `BLOB_PUT_MAX_BYTES` = `ATTACHMENT_MAX_BYTES` (import it from routes).

Two objects per paired phone: the **watcher** lives as long as the remote service runs and decides wakes (so a phone that is offline still gets its push); the **session** lives per connection and does the tunnelling. The watcher is a hub subscriber on `sessions` and `errors` through a virtual socket, feeding a `SessionNotifier` with that phone's settings.

- [x] **Step 1: Write the failing tests**

`server/test/remotePhoneSession.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateIdentity, deviceId } from '@orbital/shared/remote/keys';
import { startHandshake, type SessionCipher } from '@orbital/shared/remote/handshake';
import { BLOB_CHUNK_BYTES, PROTOCOL_VERSION, chunkBlob, decodeInner, encodeInner, type MacMessage } from '@orbital/shared/remote/messages';
import { Hub } from '../src/api/hub.js';
import { createImageStore } from '../src/images/store.js';
import { DeviceWatcher } from '../src/remote/deviceWatcher.js';
import { PhoneSession } from '../src/remote/phoneSession.js';
import { wakeToken } from '../src/remote/wake.js';

const allOn = { needsInput: true, sessionEnded: true, sessionFailed: true, onlyWhenBackground: true, sound: true };

/** A phone on the other end: completes the handshake and speaks the inner codec. */
function makePhone(mac: ReturnType<typeof generateIdentity>, session: () => PhoneSession) {
  const me = generateIdentity();
  const hs = startHandshake(me, mac.publicKey, 'initiator');
  let cipher: SessionCipher | null = null;
  const out: MacMessage[] = [];
  const blobs: { id: number; seq: number; last: boolean; bytes: Uint8Array }[] = [];
  const onMacBody = (body: Uint8Array) => {
    if (!cipher) {
      cipher = hs.complete(body);
      return;
    }
    const inner = decodeInner(cipher.open(body)!)!;
    if (inner.kind === 'json') out.push(inner.value as MacMessage);
    else blobs.push(inner);
  };
  const send = (value: unknown) => session().receive(cipher!.seal(encodeInner({ kind: 'json', value })));
  const sendBlob = (chunk: ReturnType<typeof chunkBlob>[number]) => session().receive(cipher!.seal(encodeInner(chunk)));
  return { me, hs, out, blobs, onMacBody, send, sendBlob, hasCipher: () => cipher !== null };
}

function build(opts: { inject?: PhoneSession['opts']['inject'] } = {}) {
  const mac = generateIdentity();
  const hub = new Hub({ heartbeatIntervalMs: 60_000 });
  const dir = mkdtempSync(join(tmpdir(), 'orbital-remote-'));
  const images = createImageStore(dir);
  let session!: PhoneSession;
  const phone = makePhone(mac, () => session);
  const notifications = { current: allOn, get: () => notifications.current, set: (s: typeof allOn) => { notifications.current = s; } };
  const onSeen = vi.fn();
  const onClose = vi.fn();
  session = new PhoneSession({
    deviceId: deviceId(phone.me.publicKey), identity: mac, phonePublicKey: phone.me.publicKey, hub,
    inject: opts.inject ?? (async () => ({ statusCode: 500, body: '{}' })),
    images, imagesDir: dir, serverVersion: '0.15.0', macName: 'studio',
    notifications, send: phone.onMacBody, onSeen, onClose,
  });
  session.receive(phone.hs.message);
  return { mac, hub, images, session, phone, notifications, onSeen, onClose };
}

describe('PhoneSession', () => {
  it('completes the handshake and answers hello with the protocol, server version and Mac name', () => {
    const { phone } = build();
    expect(phone.hasCipher()).toBe(true);
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'orbital-mobile/0.1.0' });
    expect(phone.out).toEqual([{ t: 'hello', protocol: PROTOCOL_VERSION, server: '0.15.0', macName: 'studio' }]);
  });
  it('a protocol mismatch answers bye and closes', () => {
    const { phone, onClose } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION + 1, app: 'x' });
    expect(phone.out).toEqual([{ t: 'bye', reason: 'protocol' }]);
    expect(onClose).toHaveBeenCalled();
  });
  it('subscribes to hub topics and forwards their frames verbatim', () => {
    const { phone, hub } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    phone.send({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'working' });
    hub.publish('session:s1', { event: 'message' });
    expect(phone.out.at(-1)).toEqual({ t: 'ws', frame: { topic: 'sessions', event: 'status', sessionId: 's1', status: 'working' } });
    phone.send({ t: 'ws', type: 'unsubscribe', topic: 'sessions' });
    expect(hub.subscriberCount('sessions')).toBe(0);
  });
  it('http goes through inject only when allowed, and answers 403 otherwise', async () => {
    const inject = vi.fn(async (req: { method: string; url: string }) => ({ statusCode: 200, body: JSON.stringify({ url: req.url }) }));
    const { phone } = build({ inject });
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    phone.send({ t: 'http', id: 1, method: 'GET', path: '/api/sessions?limit=2' });
    phone.send({ t: 'http', id: 2, method: 'GET', path: '/api/files?path=/etc/passwd' });
    await new Promise((r) => setTimeout(r, 0));
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0][0]).toMatchObject({ method: 'GET', url: '/api/sessions?limit=2' });
    expect(phone.out).toContainEqual({ t: 'http_res', id: 1, status: 200, body: { url: '/api/sessions?limit=2' } });
    expect(phone.out).toContainEqual({ t: 'http_res', id: 2, status: 403, body: { error: 'not_allowed' } });
  });
  it('blob_get streams a stored image in chunks; a missing ref answers 404', async () => {
    const { phone, images } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(BLOB_CHUNK_BYTES + 10, 1)]);
    const entry = images.putBytes('image/png', png)!;
    phone.send({ t: 'blob_get', id: 7, ref: entry.ref });
    await new Promise((r) => setTimeout(r, 0));
    expect(phone.out).toContainEqual({ t: 'blob_meta', id: 7, status: 200, bytes: png.length, mediaType: 'image/png' });
    expect(phone.blobs.map((b) => [b.id, b.seq, b.last])).toEqual([[7, 0, false], [7, 1, true]]);
    expect(Buffer.concat(phone.blobs.map((b) => b.bytes))).toEqual(png);
    phone.send({ t: 'blob_get', id: 8, ref: 'f'.repeat(64) + '.png' });
    await new Promise((r) => setTimeout(r, 0));
    expect(phone.out).toContainEqual({ t: 'blob_meta', id: 8, status: 404 });
  });
  it('blob_put assembles chunks into the image store and answers the entry', async () => {
    const { phone, images } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(100, 2)]);
    phone.send({ t: 'blob_put', id: 3, mediaType: 'image/png', bytes: png.length });
    for (const chunk of chunkBlob(3, new Uint8Array(png))) phone.sendBlob(chunk);
    await new Promise((r) => setTimeout(r, 0));
    const done = phone.out.find((m) => m.t === 'blob_put_done');
    expect(done).toMatchObject({ t: 'blob_put_done', id: 3, entry: { bytes: png.length } });
    expect(images.read((done as any).entry.ref)).not.toBeNull();
    phone.send({ t: 'blob_put', id: 4, mediaType: 'text/plain', bytes: 1 });
    phone.sendBlob({ kind: 'blob', id: 4, seq: 0, last: true, bytes: new Uint8Array([1]) });
    await new Promise((r) => setTimeout(r, 0));
    expect(phone.out).toContainEqual({ t: 'blob_put_done', id: 4, error: 'not_image' });
  });
  it('notifications round-trip and seen reaches the watcher hook', () => {
    const { phone, notifications, onSeen } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    phone.send({ t: 'notifications_get' });
    expect(phone.out.at(-1)).toEqual({ t: 'notifications', settings: allOn });
    phone.send({ t: 'notifications_set', settings: { ...allOn, sessionEnded: false } });
    expect(notifications.current.sessionEnded).toBe(false);
    expect(phone.out.at(-1)).toEqual({ t: 'notifications', settings: { ...allOn, sessionEnded: false } });
    phone.send({ t: 'seen', sessionId: 's9' });
    expect(onSeen).toHaveBeenCalledWith('s9');
  });
  it('ignores everything before hello except hello, and a tampered body', () => {
    const { phone, session } = build();
    phone.send({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    expect(phone.out).toEqual([]);
    session.receive(new Uint8Array([0, 1, 2]));
    expect(phone.out).toEqual([]);
  });
});

describe('DeviceWatcher', () => {
  it('wakes once per session entering needs_input until seen, honouring the settings', () => {
    const hub = new Hub({ heartbeatIntervalMs: 60_000 });
    const wakes: string[] = [];
    let settings = allOn;
    const w = new DeviceWatcher({ deviceId: 'p1', hub, settings: () => settings, onWake: (id) => wakes.push(id) });
    w.start([{ id: 's1', title: 'one', status: 'working' }]);
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'working' });
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
    expect(wakes).toEqual(['s1', 's1']);
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'working' });
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
    hub.publish('sessions', { event: 'upsert', session: { id: 's1', title: 'one', status: 'needs_input' } });
    expect(wakes).toEqual(['s1', 's1', 's1']);
    settings = { ...allOn, needsInput: false };
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'working' });
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
    expect(wakes).toHaveLength(3);
    w.stop();
    expect(hub.subscriberCount('sessions')).toBe(0);
  });
  it('a session failure wakes too', () => {
    const hub = new Hub({ heartbeatIntervalMs: 60_000 });
    const wakes: string[] = [];
    const w = new DeviceWatcher({ deviceId: 'p1', hub, settings: () => allOn, onWake: (id) => wakes.push(id) });
    w.start([]);
    hub.publish('errors', { event: 'error', error: { kind: 'session_failed', sessionId: 's2', message: 'boom\nstack' } });
    expect(wakes).toEqual(['s2']);
  });
});

describe('wakeToken', () => {
  it('is 16 bytes, stable per session and secret, and opaque', () => {
    const secret = new Uint8Array(32).fill(5);
    const a = wakeToken(secret, 's1');
    expect(a).toHaveLength(16);
    expect(wakeToken(secret, 's1')).toEqual(a);
    expect(wakeToken(secret, 's2')).not.toEqual(a);
    expect(wakeToken(new Uint8Array(32).fill(6), 's1')).not.toEqual(a);
  });
});
```

- [x] **Step 2: Run them to see them fail**

Run: `npm test -w server -- remotePhoneSession`
Expected: FAIL, modules not found.

- [x] **Step 3: Implement `wake.ts`**

```ts
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
```

- [x] **Step 4: Implement `deviceWatcher.ts`**

```ts
/**
 * Decides, for one paired phone, which session events deserve a `wake` —
 * whether or not that phone is connected right now. The desktop's own
 * notification rules (`SessionNotifier`) are the judge, with the phone's
 * settings; this class only adds the debounce: one wake per session until
 * the phone opens it or the session moves on (spec
 * 2026-09-30-mobile-remote-design § 3 Wake flag, § 5).
 */
import { EventEmitter } from 'node:events';
import { SessionNotifier, type NotificationSettings } from '@orbital/shared/notifications';
import type { Hub } from '../api/hub.js';

export type DeviceWatcherOptions = {
  deviceId: string;
  hub: Hub;
  settings: () => NotificationSettings;
  onWake: (sessionId: string) => void;
};

export class DeviceWatcher {
  private readonly notifier = new SessionNotifier();
  private readonly pending = new Set<string>();
  private socket: (EventEmitter & { send(data: string): void }) | null = null;

  constructor(private readonly opts: DeviceWatcherOptions) {}

  /** `initialSessions` seeds the notifier so the first sighting is never news. */
  start(initialSessions: unknown[]): void {
    for (const session of initialSessions) this.notifier.onEvent({ topic: 'sessions', event: 'upsert', session });
    const socket = Object.assign(new EventEmitter(), { send: (data: string) => this.onFrame(data) });
    this.socket = socket;
    this.opts.hub.handleSocket(socket);
    socket.emit('message', JSON.stringify({ type: 'subscribe', topic: 'sessions' }));
    socket.emit('message', JSON.stringify({ type: 'subscribe', topic: 'errors' }));
  }

  seen(sessionId: string): void {
    this.pending.delete(sessionId);
  }

  stop(): void {
    this.socket?.emit('close');
    this.socket = null;
  }

  private onFrame(data: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    // A session leaving needs_input retires its debounce, whichever way it went.
    if (frame.topic === 'sessions') {
      const id = typeof frame.sessionId === 'string' ? frame.sessionId
        : frame.session && typeof frame.session === 'object' ? String((frame.session as { id?: unknown }).id ?? '') : '';
      const status = typeof frame.status === 'string' ? frame.status
        : frame.session && typeof frame.session === 'object' ? (frame.session as { status?: unknown }).status : undefined;
      if (id && status && status !== 'needs_input') this.pending.delete(id);
      if (frame.event === 'remove' && id) this.pending.delete(id);
    }
    this.notifier.setSettings(this.opts.settings());
    const note = this.notifier.onEvent(frame);
    if (!note?.sessionId) return;
    if (this.pending.has(note.sessionId)) return;
    this.pending.add(note.sessionId);
    this.opts.onWake(note.sessionId);
  }
}
```

The notifier's `needs_input` rule fires on the transition into `needs_input` and `sessionEnded` on `working → ended`; both are wakes. The test's expectation of three wakes for three transitions (with a `working` in between each) follows from that.

- [x] **Step 5: Implement `phoneSession.ts`**

```ts
/**
 * One connected phone, from its handshake to its close. Everything it sends
 * is decrypted here and handed to the parts of the server that already
 * exist: hub control frames to `Hub` through a virtual socket, REST calls to
 * Fastify's `inject()` behind the allowlist, images to the image store
 * (spec 2026-09-30-mobile-remote-design § 3 Dispatcher).
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Identity } from '@orbital/shared/remote/keys';
import { startHandshake, type Handshake, type SessionCipher } from '@orbital/shared/remote/handshake';
import {
  MacMessage, PROTOCOL_VERSION, PhoneMessage, chunkBlob, decodeInner, encodeInner,
  type NotificationSettings,
} from '@orbital/shared/remote/messages';
import type { Hub } from '../api/hub.js';
import { ATTACHMENT_MAX_BYTES } from '../api/routes.js';
import type { ImageStore } from '../images/store.js';
import { allowedPath } from './allowlist.js';

export const BLOB_PUT_MAX_BYTES = ATTACHMENT_MAX_BYTES;

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

export type InjectFn = (req: { method: string; url: string; payload?: unknown }) => Promise<{ statusCode: number; body: string }>;

export type PhoneSessionOptions = {
  deviceId: string;
  identity: Identity;
  phonePublicKey: Uint8Array;
  hub: Hub;
  inject: InjectFn;
  images: ImageStore;
  imagesDir: string;
  serverVersion: string;
  macName: string;
  notifications: { get(): NotificationSettings; set(s: NotificationSettings): void };
  /** Sends one body — handshake or ciphertext — to the phone. */
  send: (body: Uint8Array) => void;
  onSeen: (sessionId: string) => void;
  onClose: () => void;
};

type Upload = { mediaType: string; expected: number; parts: Uint8Array[]; received: number; nextSeq: number };

export class PhoneSession {
  private handshake: Handshake | null;
  private cipher: SessionCipher | null = null;
  private greeted = false;
  private closed = false;
  private readonly socket: EventEmitter & { send(data: string): void };
  private readonly uploads = new Map<number, Upload>();

  constructor(readonly opts: PhoneSessionOptions) {
    this.handshake = startHandshake(opts.identity, opts.phonePublicKey, 'responder');
    this.socket = Object.assign(new EventEmitter(), {
      send: (data: string) => {
        if (!this.greeted) return;
        try {
          this.sendJson({ t: 'ws', frame: JSON.parse(data) });
        } catch {
          /* a heartbeat or junk: not for the phone */
        }
      },
    });
  }

  get ready(): boolean {
    return this.greeted && !this.closed;
  }

  receive(body: Uint8Array): void {
    if (this.closed) return;
    if (!this.cipher) {
      // The responder's half is signed over both ephemerals, so it exists only
      // once the phone's half verified (`Handshake.message` is set by
      // `complete` for a responder); `complete` is single-use.
      const handshake = this.handshake;
      const cipher = handshake?.complete(body) ?? null;
      if (!cipher || !handshake?.message) return;
      this.cipher = cipher;
      this.handshake = null;
      this.opts.send(handshake.message);
      return;
    }
    const plain = this.cipher.open(body);
    if (!plain) return;
    const inner = decodeInner(plain);
    if (!inner) return;
    if (inner.kind === 'blob') return this.onChunk(inner);
    const parsed = PhoneMessage.safeParse(inner.value);
    if (!parsed.success) return;
    this.onMessage(parsed.data);
  }

  close(reason?: 'protocol' | 'revoked'): void {
    if (this.closed) return;
    if (reason && this.cipher) this.sendJson({ t: 'bye', reason });
    this.closed = true;
    this.socket.emit('close');
    this.opts.onClose();
  }

  private onMessage(msg: PhoneMessage): void {
    if (!this.greeted) {
      if (msg.t !== 'hello') return;
      if (msg.protocol !== PROTOCOL_VERSION) return this.close('protocol');
      this.greeted = true;
      this.opts.hub.handleSocket(this.socket);
      this.sendJson({ t: 'hello', protocol: PROTOCOL_VERSION, server: this.opts.serverVersion, macName: this.opts.macName });
      return;
    }
    switch (msg.t) {
      case 'hello':
        return;
      case 'ws':
        this.socket.emit('message', JSON.stringify({ type: msg.type, topic: msg.topic }));
        return;
      case 'http':
        void this.onHttp(msg);
        return;
      case 'blob_get':
        this.onBlobGet(msg.id, msg.ref);
        return;
      case 'blob_put':
        if (msg.bytes > BLOB_PUT_MAX_BYTES) return this.sendJson({ t: 'blob_put_done', id: msg.id, error: 'too_large' });
        this.uploads.set(msg.id, { mediaType: msg.mediaType, expected: msg.bytes, parts: [], received: 0, nextSeq: 0 });
        return;
      case 'notifications_get':
        this.sendJson({ t: 'notifications', settings: this.opts.notifications.get() });
        return;
      case 'notifications_set':
        this.opts.notifications.set(msg.settings);
        this.sendJson({ t: 'notifications', settings: this.opts.notifications.get() });
        return;
      case 'seen':
        this.opts.onSeen(msg.sessionId);
        return;
    }
  }

  private async onHttp(msg: Extract<PhoneMessage, { t: 'http' }>): Promise<void> {
    // `allowedPath` returns the canonical string Fastify will route, or null;
    // the raw `msg.path` is never handed to `inject()` (Task 12 review: the
    // WHATWG parser would otherwise rewrite `\` and `#` into a denied route).
    const path = allowedPath(msg.method, msg.path);
    if (path === null) {
      return this.sendJson({ t: 'http_res', id: msg.id, status: 403, body: { error: 'not_allowed' } });
    }
    try {
      const res = await this.opts.inject({ method: msg.method, url: path, payload: msg.body });
      let body: unknown = res.body;
      try {
        body = JSON.parse(res.body);
      } catch {
        /* a non-JSON answer travels as text */
      }
      this.sendJson({ t: 'http_res', id: msg.id, status: res.statusCode, body });
    } catch (err) {
      this.sendJson({ t: 'http_res', id: msg.id, status: 500, body: { error: err instanceof Error ? err.message : String(err) } });
    }
  }

  private onBlobGet(id: number, ref: string): void {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(this.opts.imagesDir, ref));
    } catch {
      return this.sendJson({ t: 'blob_meta', id, status: 404 });
    }
    const ext = ref.slice(ref.lastIndexOf('.') + 1);
    this.sendJson({ t: 'blob_meta', id, status: 200, bytes: bytes.length, mediaType: IMAGE_CONTENT_TYPES[ext] });
    for (const chunk of chunkBlob(id, new Uint8Array(bytes))) this.sendInner(encodeInner(chunk));
  }

  private onChunk(chunk: { id: number; seq: number; last: boolean; bytes: Uint8Array }): void {
    const up = this.uploads.get(chunk.id);
    if (!up) return;
    if (chunk.seq !== up.nextSeq) {
      this.uploads.delete(chunk.id);
      return this.sendJson({ t: 'blob_put_done', id: chunk.id, error: 'out_of_order' });
    }
    up.nextSeq++;
    up.parts.push(chunk.bytes);
    up.received += chunk.bytes.length;
    if (up.received > Math.max(up.expected, BLOB_PUT_MAX_BYTES)) {
      this.uploads.delete(chunk.id);
      return this.sendJson({ t: 'blob_put_done', id: chunk.id, error: 'too_large' });
    }
    if (!chunk.last) return;
    this.uploads.delete(chunk.id);
    const entry = this.opts.images.putBytes(up.mediaType, Buffer.concat(up.parts.map((p) => Buffer.from(p))));
    if (!entry) return this.sendJson({ t: 'blob_put_done', id: chunk.id, error: 'not_image' });
    this.sendJson({ t: 'blob_put_done', id: chunk.id, entry });
  }

  private sendJson(msg: MacMessage): void {
    this.sendInner(encodeInner({ kind: 'json', value: msg }));
  }

  private sendInner(plain: Uint8Array): void {
    if (!this.cipher || this.closed) return;
    this.opts.send(this.cipher.seal(plain));
  }
}
```

`wake.ts` imports `@noble/hashes` directly, so `server/package.json` gains `"@noble/hashes": "^2.0.0"` in `dependencies` (run `npm install`); relying on hoisting from `shared/` would break the esbuild bundle the desktop ships.

- [x] **Step 6: Run the tests**

Run: `npm test -w server -- remotePhoneSession && npm run typecheck -w server`
Expected: PASS. If `images.read` is not on `ImageStore`'s public type in the test, assert through `readFileSync(join(dir, entry.ref))` instead.

- [x] **Step 7: Commit**

```bash
git add server/src/remote/wake.ts server/src/remote/deviceWatcher.ts server/src/remote/phoneSession.ts server/test/remotePhoneSession.test.ts server/package.json package-lock.json
git commit -m "feat(server): phone session tunnel and the per-device wake watcher"
```

---

### Task 15: `RemoteService`, the `/api/remote` routes and the wiring

**Files:**
- Create: `server/src/remote/service.ts`, `server/src/api/remoteRoutes.ts`
- Modify: `server/src/api/routes.ts` (`RouteContext.remote`, the settings PATCH hook, call `registerRemoteRoutes`), `server/src/index.ts` (construct, start, stop; `dataDir` override)
- Test: `server/test/remoteRoutes.test.ts`

**Interfaces:**
- Consumes: everything from 10, 12, 13, 14; `Hub`, `OrbitalDb`, `ImageStore`; `fingerprint`, `publicKeyOf`, `deviceId` (1); `encodeFrame`, `decodeFrame`, `FLAG_WAKE`, `FLAG_STATE`, `ZERO_WAKE` (2); `QrPayload`, `DEFAULT_RELAY_URL` (5); `parseNotificationSettings` (11).
- Produces:
  - `class RemoteService` — `constructor(opts: RemoteServiceOptions)`, `start()`, `stop()`, `settingsChanged()`, `status(): RemoteStatus`, `startPairing(): Promise<{ qr: string; expiresAt: number } | { error: 'disabled' | 'offline' | 'relay_error' }>`, `confirmPairing(accept: boolean, phone: string): Promise<boolean>`, `revoke(id: string): Promise<boolean>`.
  - `type RemoteStatus = { enabled: boolean; relay: 'off' | 'connecting' | 'online'; relayUrl: string; macId: string | null; macName: string; devices: (RemoteDevice & { online: boolean })[]; pendingPair: { phone: string; name: string; platform: string; fingerprint: string } | null; pairing: { expiresAt: number } | null }`.
  - Hub topic `remote`: `{ event: 'status', ...RemoteStatus }` on every change; `{ event: 'pair_request', phone, name, platform, fingerprint }` when a phone redeemed a code.
  - Routes: `GET /api/remote` → `RemoteStatus`; `POST /api/remote/pair` → `{ qr, expiresAt }` or 409 `{ error }`; `POST /api/remote/pair/confirm` body `{ accept: boolean, phone: string }` → `{ ok: true }`, 404 when nothing is pending, 409 `mismatch` when `phone` is not the pending one (amended 2026-10-01, Task 15 review); `DELETE /api/remote/devices/:id` → `{ ok: true }` or 404.
  - `RemoteServiceOptions = { db; hub; dataDir; images; imagesDir; serverVersion; inject: InjectFn; settings: { get(key): string }; allSettings: () => Record<string, string>; now?: () => number; clientFactory?: (opts: RelayClientOptions) => RelayClient }`.

- [x] **Step 1: Write the failing route test**

`server/test/remoteRoutes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { settings as settingsTable } from '../src/db/schema.js';

async function server(enabled: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-remote-'));
  const dbPath = join(dir, 'index.db');
  const db = openDb(dbPath);
  db.insert(settingsTable).values({ key: 'remote_enabled', value: String(enabled) })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: String(enabled) } }).run();
  db.insert(settingsTable).values({ key: 'remote_relay_url', value: 'http://127.0.0.1:1' })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: 'http://127.0.0.1:1' } }).run();
  return buildServer({ dbPath, claudeDir: join(dir, 'claude'), dataDir: dir });
}

describe('/api/remote', () => {
  it('reports a disabled service and refuses to pair', async () => {
    const app = await server(false);
    const status = await app.inject({ method: 'GET', url: '/api/remote' });
    expect(status.json()).toMatchObject({ enabled: false, relay: 'off', devices: [], pendingPair: null, macId: null });
    const pair = await app.inject({ method: 'POST', url: '/api/remote/pair' });
    expect(pair.statusCode).toBe(409);
    expect(pair.json()).toEqual({ error: 'disabled' });
    await app.close();
  });
  it('an enabled service has an identity and reports connecting while the relay is unreachable', async () => {
    const app = await server(true);
    const status = await app.inject({ method: 'GET', url: '/api/remote' });
    expect(status.json()).toMatchObject({ enabled: true, relay: 'connecting', relayUrl: 'http://127.0.0.1:1' });
    expect(status.json().macId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(status.json().macName).not.toBe('');
    const pair = await app.inject({ method: 'POST', url: '/api/remote/pair' });
    expect(pair.statusCode).toBe(409);
    expect(pair.json()).toEqual({ error: 'offline' });
    expect((await app.inject({ method: 'POST', url: '/api/remote/pair/confirm', payload: { accept: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/remote/devices/nope' })).statusCode).toBe(404);
    await app.close();
  });
  it('a settings change to remote_enabled starts and stops the service', async () => {
    const app = await server(false);
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { remote_enabled: 'true' } });
    expect((await app.inject({ method: 'GET', url: '/api/remote' })).json().enabled).toBe(true);
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { remote_enabled: 'false' } });
    expect((await app.inject({ method: 'GET', url: '/api/remote' })).json()).toMatchObject({ enabled: false, relay: 'off' });
    await app.close();
  });
});
```

- [x] **Step 2: Run it to see it fail**

Run: `npm test -w server -- remoteRoutes`
Expected: FAIL (404s; `dataDir` is not an override yet).

- [x] **Step 3: Implement `service.ts`**

```ts
/**
 * The Mac side of the mobile remote, assembled: identity, the relay
 * connection, pairing, one `DeviceWatcher` per paired phone (alive while the
 * service runs) and one `PhoneSession` per connected phone (alive per
 * connection). Off is the default and off means nothing here is constructed
 * (spec 2026-09-30-mobile-remote-design § 3).
 */
import { deviceId, fingerprint, publicKeyOf, type Identity } from '@orbital/shared/remote/keys';
import { FLAG_STATE, FLAG_WAKE, ZERO_WAKE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import { DEFAULT_RELAY_URL, type QrPayload, type RelayToDevice } from '@orbital/shared/remote/relayApi';
import { parseNotificationSettings } from '@orbital/shared/notifications';
import type { Hub } from '../api/hub.js';
import type { OrbitalDb } from '../db/database.js';
import type { ImageStore } from '../images/store.js';
import { DeviceStore, type RemoteDevice } from './devices.js';
import { DeviceWatcher } from './deviceWatcher.js';
import { loadOrCreateIdentity, macDisplayName } from './identity.js';
import { PhoneSession, type InjectFn } from './phoneSession.js';
import { RelayClient, type RelayClientOptions } from './relayClient.js';
import { wakeSecret, wakeToken } from './wake.js';

export type RemoteStatus = {
  enabled: boolean;
  relay: 'off' | 'connecting' | 'online';
  relayUrl: string;
  macId: string | null;
  macName: string;
  devices: (RemoteDevice & { online: boolean })[];
  pendingPair: { phone: string; name: string; platform: string; fingerprint: string } | null;
  pairing: { expiresAt: number } | null;
};

export type RemoteServiceOptions = {
  db: OrbitalDb;
  hub: Hub;
  dataDir: string;
  images: ImageStore;
  imagesDir: string;
  serverVersion: string;
  inject: InjectFn;
  settings: { get(key: string): string };
  allSettings: () => Record<string, string>;
  now?: () => number;
  clientFactory?: (opts: RelayClientOptions) => RelayClient;
};

export class RemoteService {
  private identity: Identity | null = null;
  private client: RelayClient | null = null;
  private readonly devices: DeviceStore;
  private readonly watchers = new Map<string, DeviceWatcher>();
  private readonly sessions = new Map<string, PhoneSession>();
  private pendingPair: RemoteStatus['pendingPair'] = null;
  private pairing: RemoteStatus['pairing'] = null;
  private readonly now: () => number;

  constructor(private readonly opts: RemoteServiceOptions) {
    this.devices = new DeviceStore(opts.db);
    this.now = opts.now ?? Date.now;
  }

  private get enabled(): boolean {
    return this.opts.settings.get('remote_enabled') === 'true';
  }

  private get relayUrl(): string {
    return this.opts.settings.get('remote_relay_url').trim() || DEFAULT_RELAY_URL;
  }

  private get macName(): string {
    return macDisplayName(this.opts.settings.get('remote_mac_name'));
  }

  start(): void {
    if (!this.enabled || this.client) return;
    this.identity = loadOrCreateIdentity(this.opts.dataDir);
    const client = (this.opts.clientFactory ?? ((o) => new RelayClient(o)))({
      relayUrl: this.relayUrl, identity: this.identity,
    });
    this.client = client;
    client.on('status', () => {
      // A new connection means new session keys: every phone re-handshakes.
      if (client.status !== 'online') this.closeSessions();
      this.publishStatus();
    });
    client.on('control', (msg: RelayToDevice) => this.onControl(msg));
    client.on('data', (frame: Uint8Array) => this.onData(frame));
    for (const device of this.devices.list()) this.watch(device.id);
    client.start();
    this.publishStatus();
  }

  stop(): void {
    this.closeSessions();
    for (const w of this.watchers.values()) w.stop();
    this.watchers.clear();
    this.client?.stop();
    this.client = null;
    this.identity = null;
    this.pendingPair = null;
    this.pairing = null;
    this.publishStatus();
  }

  /** Re-reads every setting: a toggle, a relay URL or a name change applies now. */
  settingsChanged(): void {
    this.stop();
    this.start();
  }

  status(): RemoteStatus {
    const online = this.client?.peersOnline ?? new Set<string>();
    return {
      enabled: this.enabled,
      relay: this.client?.status ?? 'off',
      relayUrl: this.relayUrl,
      macId: this.identity ? deviceId(this.identity.publicKey) : null,
      macName: this.macName,
      devices: this.devices.list().map((d) => ({ ...d, online: online.has(d.id) })),
      pendingPair: this.pendingPair,
      pairing: this.pairing && this.pairing.expiresAt > this.now() ? this.pairing : null,
    };
  }

  async startPairing(): Promise<{ qr: string; expiresAt: number } | { error: 'disabled' | 'offline' | 'relay_error' }> {
    if (!this.enabled || !this.client || !this.identity) return { error: 'disabled' };
    if (this.client.status !== 'online') return { error: 'offline' };
    const res = await this.client.post<{ token: string; expiresAt: number }>('/pair/token', 'pair.token', { name: this.macName });
    if (res.status !== 200) return { error: 'relay_error' };
    this.pairing = { expiresAt: res.body.expiresAt };
    this.pendingPair = null;
    const qr: QrPayload = {
      v: 1, relay: this.relayUrl, mac: deviceId(this.identity.publicKey), name: this.macName, token: res.body.token,
    };
    this.publishStatus();
    return { qr: JSON.stringify(qr), expiresAt: res.body.expiresAt };
  }

  async confirmPairing(accept: boolean): Promise<boolean> {
    const pending = this.pendingPair;
    if (!pending || !this.client) return false;
    const res = await this.client.post('/pair/confirm', 'pair.confirm', { phone: pending.phone, accept });
    if (res.status !== 200) return false;
    this.pendingPair = null;
    this.pairing = null;
    if (accept) {
      this.devices.add({
        id: pending.phone, name: pending.name, platform: pending.platform, pairedAt: this.now(),
        notifications: parseNotificationSettings(this.opts.allSettings()),
      });
      this.watch(pending.phone);
    }
    this.publishStatus();
    return true;
  }

  async revoke(id: string): Promise<boolean> {
    if (!this.devices.get(id) || !this.client) return false;
    this.sessions.get(id)?.close('revoked');
    this.sessions.delete(id);
    this.watchers.get(id)?.stop();
    this.watchers.delete(id);
    this.devices.remove(id);
    await this.client.post('/pair/revoke', 'pair.revoke', { phone: id });
    this.publishStatus();
    return true;
  }

  private onControl(msg: RelayToDevice): void {
    if (msg.type === 'pair_request' && this.identity) {
      const phoneKey = publicKeyOf(msg.phone);
      if (!phoneKey) return;
      this.pendingPair = {
        phone: msg.phone, name: msg.name, platform: msg.platform,
        fingerprint: fingerprint(this.identity.publicKey, phoneKey),
      };
      this.opts.hub.publish('remote', { event: 'pair_request', ...this.pendingPair });
      this.publishStatus();
      return;
    }
    if (msg.type === 'presence') {
      if (msg.online) this.devices.touch(msg.peer, this.now());
      else {
        this.sessions.get(msg.peer)?.close();
        this.sessions.delete(msg.peer);
      }
      this.publishStatus();
    }
  }

  private onData(buf: Uint8Array): void {
    const frame = decodeFrame(buf);
    if (!frame || !this.identity || !this.client) return;
    const from = deviceId(frame.peer);
    const device = this.devices.get(from);
    if (!device || frame.body.length === 0) return;
    let session = this.sessions.get(from);
    if (!session) {
      const phonePublicKey = new Uint8Array(frame.peer);
      const client = this.client;
      session = new PhoneSession({
        deviceId: from, identity: this.identity, phonePublicKey, hub: this.opts.hub,
        inject: this.opts.inject, images: this.opts.images, imagesDir: this.opts.imagesDir,
        serverVersion: this.opts.serverVersion, macName: this.macName,
        notifications: {
          get: () => this.devices.get(from)?.notifications ?? device.notifications,
          set: (s) => this.devices.setNotifications(from, s),
        },
        send: (body) => client.sendData(encodeFrame({ peer: phonePublicKey, flags: 0, wake: ZERO_WAKE, body })),
        onSeen: (sessionId) => this.watchers.get(from)?.seen(sessionId),
        onClose: () => {
          if (this.sessions.get(from) === session) this.sessions.delete(from);
        },
      });
      this.sessions.set(from, session);
    }
    session.receive(frame.body);
  }

  private watch(id: string): void {
    if (this.watchers.has(id) || !this.identity) return;
    const secret = wakeSecret(this.identity);
    const phoneKey = publicKeyOf(id);
    if (!phoneKey) return;
    const watcher = new DeviceWatcher({
      deviceId: id, hub: this.opts.hub,
      settings: () => this.devices.get(id)?.notifications ?? parseNotificationSettings({}),
      // Sent whether or not the phone is connected: the relay forwards to a
      // connected phone (which ignores an empty body) and pushes otherwise.
      onWake: (sessionId) => this.client?.sendData(encodeFrame({
        peer: phoneKey, flags: FLAG_WAKE | FLAG_STATE, wake: wakeToken(secret, sessionId), body: new Uint8Array(0),
      })),
    });
    void this.opts.inject({ method: 'GET', url: '/api/sessions?limit=200' }).then((res) => {
      let initial: unknown[] = [];
      try {
        // The route answers `{ sessions: [...] }` (routes.ts, GET /api/sessions).
        const parsed = JSON.parse(res.body) as { sessions?: unknown };
        if (Array.isArray(parsed.sessions)) initial = parsed.sessions;
      } catch {
        /* an empty seed only means the first sighting of each session is not news */
      }
      if (this.watchers.get(id) === watcher) watcher.start(initial);
    });
    this.watchers.set(id, watcher);
  }

  private closeSessions(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  private publishStatus(): void {
    this.opts.hub.publish('remote', { event: 'status', ...this.status() });
  }
}
```

- [x] **Step 4: Implement `remoteRoutes.ts` and hook the settings PATCH**

`server/src/api/remoteRoutes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { RemoteService } from '../remote/service.js';

/** Settings → Mobile talks to these; the phone never can (they are not allowlisted). */
export function registerRemoteRoutes(app: FastifyInstance, remote: RemoteService): void {
  app.get('/api/remote', () => remote.status());

  app.post('/api/remote/pair', async (_req, reply) => {
    const res = await remote.startPairing();
    if ('error' in res) return reply.code(409).send(res);
    return res;
  });

  app.post('/api/remote/pair/confirm', async (req, reply) => {
    const body = (req.body ?? {}) as { accept?: unknown };
    if (typeof body.accept !== 'boolean') return reply.code(400).send({ error: 'accept must be a boolean' });
    if (!(await remote.confirmPairing(body.accept))) return reply.code(404).send({ error: 'no_pending' });
    return { ok: true };
  });

  app.delete('/api/remote/devices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await remote.revoke(id))) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
```

`routes.ts`: add `remote: RemoteService;` to `RouteContext` (import the type), call `registerRemoteRoutes(app, ctx.remote)` next to the other registrations at the top of `registerRoutes`, and in `PATCH /api/settings` track `let remoteSettings = false;` set when `k.startsWith('remote_')`, then after the loop `if (remoteSettings) ctx.remote.settingsChanged();`.

- [x] **Step 5: Wire it in `index.ts`**

Add `dataDir?: string;` to `buildServer`'s overrides (doc: "where the identity file and images live; tests point it at a temp dir"), and use `const dataDir = overrides.dataDir ?? CONFIG.dataDir;` for `imagesDir` too (`join(dataDir, 'images')`).

After `const app = Fastify()` and before `registerRoutes`:

```ts
  // The mobile remote (spec 2026-09-30-mobile-remote-design § 3). Built
  // whether or not it is enabled — `start()` is what reads the switch — so the
  // routes always have something to ask. `inject` is how a phone's REST call
  // enters: in-process, same routes, same host guard satisfied by the header.
  const remote = new RemoteService({
    db, hub, dataDir, images, imagesDir,
    serverVersion: process.env.ORBITAL_VERSION ?? 'dev',
    inject: async (req) => {
      const res = await app.inject({
        method: req.method as 'GET', url: req.url, payload: req.payload as any,
        headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      });
      return { statusCode: res.statusCode, body: res.body };
    },
    settings: settingsStore,
    allSettings: () => Object.fromEntries(db.select().from(settingsTable).all().map((r) => [r.key, r.value])),
  });
```

Pass `remote` in the `registerRoutes` context; call `remote.start()` right after `registerRoutes`; in the `onClose` hook add `remote.stop();`.

`ORBITAL_VERSION` is not set by anything yet; the desktop's fork of the server is where it belongs and is a follow-up outside this plan (`docs/chores/desktop-follow-ups.md` gets a line in Task 17).

- [x] **Step 6: Run the server suite**

Run: `npm test -w server && npm run typecheck -w server && npm run lint`
Expected: PASS. `routes.test.ts` builds its own `registerRoutes` context by hand in places — those now need a `remote`; give them `new RemoteService({...})` with the test's db and hub, or if the test's context object is typed loosely, `remote: { status: () => ({}) } as any` is acceptable there since nothing in those tests calls the remote routes.

- [x] **Step 7: Commit**

```bash
git add server/src/remote/service.ts server/src/api/remoteRoutes.ts server/src/api/routes.ts server/src/index.ts server/test/remoteRoutes.test.ts server/test/routes.test.ts
git commit -m "feat(server): the remote service, pairing routes and settings hook"
```

---

### Task 16: End to end — relay, Mac and a fake phone in one process

**Files:**
- Create: `server/test/remoteFakePhone.ts`, `server/test/remoteEndToEnd.test.ts`
- Modify: `server/package.json` (devDependency on `@orbital/relay` so the test can `buildRelay`)

**Interfaces:**
- Consumes: `buildRelay`, `openRelayStore` (6–9); `buildServer` (15); the whole of `shared/`.
- Produces: `class FakePhone` for later tests: `connect(relayUrl)`, `redeem(qr)`, `handshake(macId)`, `hello()`, `send(msg)`, `next(t)`, `nextBlob()`, `close()`.

- [x] **Step 1: The fake phone**

`server/test/remoteFakePhone.ts`:

```ts
import WebSocket from 'ws';
import { generateIdentity, deviceId, publicKeyOf, type Identity } from '@orbital/shared/remote/keys';
import { startHandshake, type Handshake, type SessionCipher } from '@orbital/shared/remote/handshake';
import { ZERO_WAKE, decodeFrame, encodeFrame } from '@orbital/shared/remote/frame';
import {
  MacMessage, PROTOCOL_VERSION, QrPayload, decodeInner, encodeInner, type Inner, type PhoneMessage,
} from '@orbital/shared/remote/messages';
import { RelayToDevice, authSignature, relayWsUrl, signRequest } from '@orbital/shared/remote/relayApi';

type Waiter = { match: (x: unknown) => boolean; resolve: (x: any) => void };

export class FakePhone {
  readonly identity: Identity = generateIdentity();
  readonly control: RelayToDevice[] = [];
  readonly messages: MacMessage[] = [];
  readonly blobs: Extract<Inner, { kind: 'blob' }>[] = [];
  private ws: WebSocket | null = null;
  private hs: Handshake | null = null;
  private cipher: SessionCipher | null = null;
  private macKey: Uint8Array | null = null;
  private waiters: Waiter[] = [];
  private relayUrl = '';
  private token = '';

  get id(): string {
    return deviceId(this.identity.publicKey);
  }

  /** Reads the QR, then connects anchored to that Mac — the order a real phone follows. */
  async connect(qrText: string): Promise<void> {
    const qr = QrPayload.parse(JSON.parse(qrText));
    this.relayUrl = qr.relay;
    this.macKey = publicKeyOf(qr.mac);
    this.token = qr.token;
    const ws = new WebSocket(relayWsUrl(qr.relay, qr.mac));
    this.ws = ws;
    ws.on('message', (raw, isBinary) => (isBinary ? this.onData(new Uint8Array(raw as Buffer)) : this.onControl(String(raw))));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const challenge = await this.nextControl('challenge');
    ws.send(JSON.stringify({ type: 'auth', pub: this.id, sig: authSignature(this.identity, (challenge as any).nonce) }));
    await this.nextControl('ok');
  }

  async redeem(name = 'Pixel', platform = 'android'): Promise<{ status: number; body: any }> {
    const res = await fetch(new URL('/pair/redeem', this.relayUrl), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signRequest(this.identity, 'pair.redeem', { token: this.token, name, platform })),
    });
    return { status: res.status, body: await res.json() };
  }

  /** Sends the initiator half and waits for the responder half. */
  async handshake(): Promise<void> {
    if (!this.macKey) throw new Error('redeem first');
    this.hs = startHandshake(this.identity, this.macKey, 'initiator');
    this.sendFrame(this.hs.message);
    await this.wait((x) => x === 'cipher');
  }

  async hello(app = 'orbital-mobile/test'): Promise<MacMessage> {
    this.send({ t: 'hello', protocol: PROTOCOL_VERSION, app });
    return this.next('hello');
  }

  send(msg: PhoneMessage): void {
    this.sendInner(encodeInner({ kind: 'json', value: msg }));
  }

  sendBlob(chunk: Extract<Inner, { kind: 'blob' }>): void {
    this.sendInner(encodeInner(chunk));
  }

  next<T extends MacMessage['t']>(t: T, pred: (m: Extract<MacMessage, { t: T }>) => boolean = () => true): Promise<Extract<MacMessage, { t: T }>> {
    const i = this.messages.findIndex((m) => m.t === t && pred(m as any));
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0] as any);
    return this.wait((x) => typeof x === 'object' && x !== null && (x as any).t === t && pred(x as any));
  }

  nextControl(type: RelayToDevice['type']): Promise<RelayToDevice> {
    const i = this.control.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.control.splice(i, 1)[0]);
    return this.wait((x) => typeof x === 'object' && x !== null && (x as any).type === type);
  }

  nextBlob(): Promise<Extract<Inner, { kind: 'blob' }>> {
    if (this.blobs.length) return Promise.resolve(this.blobs.shift()!);
    return this.wait((x) => typeof x === 'object' && x !== null && (x as any).kind === 'blob');
  }

  close(): void {
    this.ws?.close();
  }

  private sendInner(plain: Uint8Array): void {
    if (!this.cipher) throw new Error('no cipher');
    this.sendFrame(this.cipher.seal(plain));
  }

  private sendFrame(body: Uint8Array): void {
    this.ws!.send(encodeFrame({ peer: this.macKey!, flags: 0, wake: ZERO_WAKE, body }), { binary: true });
  }

  private onControl(text: string): void {
    const msg = RelayToDevice.parse(JSON.parse(text));
    this.control.push(msg);
    this.offer(msg);
  }

  private onData(buf: Uint8Array): void {
    const frame = decodeFrame(buf);
    if (!frame || frame.body.length === 0) return;
    if (!this.cipher) {
      this.cipher = this.hs?.complete(frame.body) ?? null;
      if (this.cipher) this.offer('cipher');
      return;
    }
    const plain = this.cipher.open(frame.body);
    if (!plain) return;
    const inner = decodeInner(plain);
    if (!inner) return;
    if (inner.kind === 'blob') {
      this.blobs.push(inner);
      this.offer(inner);
      return;
    }
    const msg = MacMessage.parse(inner.value);
    this.messages.push(msg);
    this.offer(msg);
  }

  private offer(x: unknown): void {
    const i = this.waiters.findIndex((w) => w.match(x));
    if (i < 0) return;
    const [w] = this.waiters.splice(i, 1);
    if (typeof x === 'object' && x !== null) {
      const list: unknown[] = (x as any).kind === 'blob' ? this.blobs : 't' in (x as any) ? this.messages : this.control;
      const at = list.indexOf(x);
      if (at >= 0) list.splice(at, 1);
    }
    w.resolve(x);
  }

  private wait<T>(match: (x: unknown) => boolean, ms = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake phone timed out')), ms);
      this.waiters.push({ match, resolve: (x) => { clearTimeout(timer); resolve(x); } });
    });
  }
}
```

- [x] **Step 2: The end-to-end test**

`server/test/remoteEndToEnd.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildRelay } from '@orbital/relay/app';
import { openRelayStore } from '@orbital/relay/store';
import { fingerprint, publicKeyOf } from '@orbital/shared/remote/keys';
import { chunkBlob } from '@orbital/shared/remote/messages';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { settings as settingsTable } from '../src/db/schema.js';
import { FakePhone } from './remoteFakePhone.js';

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

async function until(cond: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('mobile remote, end to end', () => {
  const closers: (() => Promise<unknown> | unknown)[] = [];
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

  it('pairs, tunnels the api and hub, moves an image both ways, and revokes', async () => {
    const relay = await buildRelay({ store: await openRelayStore(':memory:') });
    const relayUrl = await listen(relay);
    closers.push(() => relay.close());

    const dir = mkdtempSync(join(tmpdir(), 'orbital-e2e-'));
    const dbPath = join(dir, 'index.db');
    const db = openDb(dbPath);
    for (const [key, value] of [['remote_enabled', 'true'], ['remote_relay_url', relayUrl], ['remote_mac_name', 'studio']]) {
      db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value } }).run();
    }
    const app = await buildServer({ dbPath, claudeDir: join(dir, 'claude'), dataDir: dir });
    closers.push(() => app.close());
    const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({ method, url, payload: payload as any });

    await until(async () => (await api('GET', '/api/remote')).json().relay === 'online');

    // Pair: QR on the Mac, redeem from the phone, fingerprint matches, confirm on the Mac.
    const pair = await api('POST', '/api/remote/pair');
    expect(pair.statusCode).toBe(200);
    const phone = new FakePhone();
    closers.push(() => phone.close());
    await phone.connect(pair.json().qr);
    const redeemed = await phone.redeem();
    expect(redeemed).toMatchObject({ status: 200, body: { name: 'studio' } });
    await until(async () => (await api('GET', '/api/remote')).json().pendingPair !== null);
    const status = (await api('GET', '/api/remote')).json();
    expect(status.pendingPair).toMatchObject({ phone: phone.id, name: 'Pixel', platform: 'android' });
    expect(status.pendingPair.fingerprint).toBe(fingerprint(publicKeyOf(status.macId)!, phone.identity.publicKey));
    expect((await api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.id })).statusCode).toBe(200);
    expect(await phone.nextControl('paired')).toMatchObject({ type: 'paired', name: 'studio' });
    await until(async () => (await api('GET', '/api/remote')).json().devices.some((d: any) => d.id === phone.id && d.online));

    // Tunnel: handshake, hello, a hub subscription, an allowed and a denied call.
    await phone.handshake();
    expect(await phone.hello()).toMatchObject({ t: 'hello', macName: 'studio' });
    phone.send({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    phone.send({ t: 'http', id: 1, method: 'GET', path: '/api/sessions' });
    const sessions = await phone.next('http_res', (m) => m.id === 1);
    expect(sessions.status).toBe(200);
    phone.send({ t: 'http', id: 2, method: 'GET', path: '/api/files?path=/etc/passwd' });
    expect(await phone.next('http_res', (m) => m.id === 2)).toMatchObject({ status: 403 });

    // An image up, then the same image down.
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(70_000, 7)]);
    phone.send({ t: 'blob_put', id: 10, mediaType: 'image/png', bytes: png.length });
    for (const chunk of chunkBlob(10, new Uint8Array(png))) phone.sendBlob(chunk);
    const done = await phone.next('blob_put_done', (m) => m.id === 10);
    expect(done.entry?.bytes).toBe(png.length);
    phone.send({ t: 'blob_get', id: 11, ref: done.entry!.ref });
    expect(await phone.next('blob_meta', (m) => m.id === 11)).toMatchObject({ status: 200, bytes: png.length });
    const parts: Uint8Array[] = [];
    for (;;) {
      const chunk = await phone.nextBlob();
      parts.push(chunk.bytes);
      if (chunk.last) break;
    }
    expect(Buffer.concat(parts)).toEqual(png);

    // The phone's own notification rows.
    phone.send({ t: 'notifications_set', settings: { needsInput: true, sessionEnded: false, sessionFailed: true, onlyWhenBackground: true, sound: false } });
    expect((await phone.next('notifications')).settings.sessionEnded).toBe(false);

    // Revoke on the Mac: the tunnel says bye, the relay says unpaired, the device is gone.
    expect((await api('DELETE', `/api/remote/devices/${phone.id}`)).statusCode).toBe(200);
    expect(await phone.next('bye')).toEqual({ t: 'bye', reason: 'revoked' });
    expect(await phone.nextControl('unpaired')).toMatchObject({ type: 'unpaired' });
    expect((await api('GET', '/api/remote')).json().devices).toEqual([]);
  }, 20_000);
});
```

`server/package.json` devDependencies: `"@orbital/relay": "*"`; the relay's `package.json` gets `"exports": { "./*": "./src/*.ts" }` so `@orbital/relay/app` resolves to source. Run `npm install`.

- [x] **Step 3: Run it**

Run: `npm test -w server -- remoteEndToEnd`
Expected: PASS. The three likeliest failures and their meaning: the `online` wait times out (the Mac's `RelayClient` is not auth'ing — check `relayWsUrl`); `pendingPair` never appears (the relay's `pair_request` is not reaching `onControl` — check `RelayClient` emits `control` for every message); `bye` never arrives (`revoke()` closes the session after the post instead of before — order in Task 15 is close first).

- [x] **Step 4: Whole repository**

Run: `npm run test && npm run typecheck && npm run lint && atlas validate`
Expected: all green.

- [x] **Step 5: Commit**

```bash
git add server/test/remoteFakePhone.ts server/test/remoteEndToEnd.test.ts server/package.json relay/package.json package-lock.json
git commit -m "test(server): relay, Mac and a fake phone end to end"
```

---

### Task 17: Documents, the runbook and the pull request

**Files:**
- Create: `docs/ops/run-the-relay.md` (runbook)
- Create: `docs/decisions/the-phone-tunnels-the-api-behind-an-allowlist.md` (adr)
- Create: `docs/decisions/remote-identity-is-ed25519-with-ephemeral-session-keys.md` (adr)
- Modify: `docs/superpowers/specs/2026-09-30-mobile-remote-design.md` (§ 1 amendment, status `active`), this plan (status `done`), `docs/chores/desktop-follow-ups.md` (one line: pass `ORBITAL_VERSION` to the forked server), `README.md` (a short "Mobile remote" section pointing at the spec and the runbook)

- [x] **Step 1: The runbook**

`docs/ops/run-the-relay.md`, frontmatter `type: runbook`, `status: in-force`, `domain: remote`, related `2026-09-30-mobile-remote-design`. Body, in this order, each a short section:

1. **What it is** — the blind relay, what it stores (devices, pairs, pairing tokens, push tokens) and what it never sees.
2. **Deploy on Dokploy** — a Postgres service first (Dokploy's own template), then the application: type Docker; repository root as build context; Dockerfile path `relay/Dockerfile`; port 4840; env `RELAY_DATABASE_URL` (the Postgres service's internal URL; required for a real deployment, SQLite is for tests and a laptop), `RELAY_PORT`, `RELAY_FCM_SERVICE_ACCOUNT` (mount the Firebase service-account JSON as a secret file and point this at it; absent means pushes are only logged); the domain with TLS from the Dokploy proxy; health check `GET /health` answering `{"app":"orbital-relay"}`. The schema is created on boot; there are no migrations to run.
2a. **More than one instance** — not needed today and not built; what IS built is the hook for it. Every device connects to `/ws?mac=<id>` (the Mac's own id, or on a phone the id from the QR), so a load balancer that hashes on that query parameter keeps both halves of a pair on one instance. Dokploy's Traefik does not hash on a query parameter; put nginx in front with `hash $arg_mac consistent;` in the `upstream` block. Pairing HTTP calls may land anywhere, since they go through Postgres and the Mac's connection (a `pair_request` is sent only by the instance holding the Mac — so the redeem endpoint, too, must be routed by `?mac=`: the phone appends it to the redeem URL; add that one line when and if this is ever switched on).
3. **Point Orbital at it** — Settings → Mobile → Advanced → Relay URL (the `remote_relay_url` row) on the Mac; the QR carries it to the phone.
4. **Run it locally** — `npm run dev -w relay`, then `remote_relay_url` = `http://127.0.0.1:4840`.
5. **Rotate or wipe** — deleting `/data/relay.db` unpairs everyone; there is nothing else to lose.
6. **Logs** — what is logged (connections, pushes, errors) and what is never logged (bodies).

- [x] **Step 2: The two ADRs**

Both `type: adr`, `status: in-force`, `domain: remote`, related to the spec. Each: Context (two paragraphs at most), Decision (one), Consequences (bullets), Alternatives ruled out (bullets with why). The first records tunnelling the existing API + hub behind a literal allowlist over a purpose-built mobile protocol and over the claude.ai bridge. The second records one Ed25519 identity per device with a signed ephemeral X25519 handshake per connection, superseding the spec's "X25519 pair + Ed25519 pair", and why (forward secrecy, no persisted counters, the relay cannot substitute a key the fingerprint would not catch).

- [x] **Step 3: Spec and plan status**

In the spec's § 1, replace the first two bullets with the one-identity version and add "Amended 2026-10-01 by [[remote-identity-is-ed25519-with-ephemeral-session-keys]]". Set the spec's `status: active` (the backend is built, the phone is not). Set this plan's `status: done` and tick every box above.

- [x] **Step 4: Validate and commit**

```bash
atlas validate
git add docs README.md
git commit -m "docs: relay runbook, two ADRs, spec amended for the backend"
```

- [x] **Step 5: The pull request**

```bash
git push -u origin feat/mobile-remote-backend
gh pr create --title "Mobile remote backend: shared protocol, relay, Mac side" --body-file - <<'PR'
## What

The backend half of docs/superpowers/specs/2026-09-30-mobile-remote-design.md: a `shared/` workspace with the wire protocol, a `relay/` service for Dokploy, and `server/src/remote/` on the Mac. No phone yet; a fake phone in `server/test/remoteFakePhone.ts` drives the end-to-end test.

## How to try it

1. `npm run dev -w relay` in one terminal.
2. `npm run dev` in another; PATCH `/api/settings` with `remote_enabled: 'true'` and `remote_relay_url: 'http://127.0.0.1:4840'`.
3. `GET /api/remote` reports `relay: 'online'`; `POST /api/remote/pair` returns the QR payload.

## Not in this PR

Settings → Mobile UI, the phone, `ORBITAL_VERSION` from the desktop fork (chore noted).
PR
```

Then ask whether to bump the desktop version (server changed, so the DMG changes): propose **minor**, since a new subsystem ships dark behind `remote_enabled`. Do not bump without an answer.
