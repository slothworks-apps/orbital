---
id: 2026-10-16-device-channel
title: Device group, part 1 — one identity, one channel per pair in both directions
status: done
type: plan
domain: remote
related:
  - 2026-10-16-device-group-design
  - a-device-has-one-identity-and-one-channel-per-pair
tags:
  - remote
  - server
  - mobile
---
# Device channel implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Orbital device talks to a paired device over one end-to-end channel that carries asks and answers in both directions, and a Mac (or server) can pair with another Mac and ask it things — while shipped phones and shipped Macs keep working unchanged.

**Architecture:** A new transport-agnostic `Channel` in `shared/` owns the handshake, the `hello` exchange, the asking half (moved out of the phone's `RemoteClient`) and a hook for a serving half. The server's `PhoneSession` splits into that `Channel` plus a `ServingHalf` (inject behind the allowlist, hub topics, blobs, files, uploads). The phone's `RemoteClient` keeps its socket code and public API and runs its tunnel on a `Channel`. The server learns to redeem another device's pairing code (`POST /api/remote/join`) and to initiate a channel when the rule says it should.

**Tech Stack:** TypeScript, zod 4, vitest, Fastify `inject`, drizzle (SQLite), `ws`; `@noble/*` crypto already in `shared/`.

**Spec:** `docs/superpowers/specs/2026-10-16-device-group-design.md` (§ 1, § 5, § 9; sub-project 1 of § 14). ADR: `docs/decisions/a-device-has-one-identity-and-one-channel-per-pair.md`.

## Global Constraints

- `PROTOCOL_VERSION` stays `1`: a shipped Mac closes a phone whose `hello.protocol` differs.
- A shipped phone parses the server's `hello` as `{ t: 'hello', protocol: number, server: string, macName: string }`: the server's `hello` always carries `server` and `macName`.
- A shipped Mac parses a phone's `hello` as `{ t: 'hello', protocol: number, app: string }`: every device's `hello` always carries `app`.
- A phone always initiates the handshake; a device paired through an older Mac's code (no `kind` in the QR) initiates towards it; between two other members the lower device id initiates; a device answers any handshake that arrives while it has no channel.
- Ask ids: the initiator numbers from `1`, the responder from `RESPONDER_FIRST_ID` = `2 ** 31`.
- Device kinds: `'desktop' | 'headless' | 'phone'`. Capabilities: `'sessions' | 'map' | 'ide' | 'folderPicker' | 'presence'`. An unknown kind or capability in a peer's `hello` is kept as a string, never a parse failure.
- The relay does not change in this plan.
- Nothing user-visible ships in this part: no changelog line, no version bump (spec § 14: parts 1–3 ship together). `POST /api/remote/join` stays off the phone allowlist.
- Comments refer to constants by name, never restate their values.
- Typecheck with the npm scripts (`npm run typecheck -w shared`, `-w server`, `-w web`); a bare `npx tsc --noEmit` in `web/` checks nothing.
- Commit messages carry no attribution trailer.

## Review Focus

1. **A shipped phone against the new server** (old `hello`, initiator, uploads with ids from 1) — greets, is served, gets refused as too old exactly as before. Pinned in Task 5 (`legacy phone hello`).
2. **A new phone against a shipped Mac** (old `hello` without `capabilities`, responder) — the phone treats it as serving, asks work, the silence watchdog runs. Pinned in Task 4 (`old Mac hello`).
3. **A peer that reconnects on a new socket mid-channel** — the responder rehandshakes, the initiator reopens on presence, nothing asked before the drop resolves twice. Pinned in Task 7 (`B restarts`).
4. **Both sides asking at once with blob transfers in flight** — a chunk for this side's download is never taken as the peer's upload. Pinned in Task 3 (`concurrent blob both ways`).
5. **An answer too large for one frame on a server-to-server channel** — the asker gets 413, nothing throws into the relay loop. Pinned in Task 3 (`oversized answer`).

---

## File structure

| file | responsibility |
|---|---|
| `shared/src/remote/device.ts` (new) | device kinds, capabilities, OS names, the initiator rule |
| `shared/src/remote/messages.ts` | `HelloMessage`, `AskMessage` (was `PhoneMessage`), `AnswerMessage` (was `MacMessage`), `parseChannelMessage`, `peerServes` |
| `shared/src/remote/relayApi.ts` | `kind` in the sealed pairing device and in `QrPayload`; `parsePairingCode`, `encodePairingCode` |
| `shared/src/remote/channel.ts` (new) | one end-to-end channel: handshake, hello, asking half, serving hook, silence |
| `shared/src/remote/client.ts` | the phone's relay socket; its tunnel is a `Channel` |
| `server/src/remote/servingHalf.ts` (new) | what a peer's asks reach on this server (was the body of `PhoneSession`) |
| `server/src/remote/deviceChannel.ts` (new) | `openDeviceChannel`: a `Channel` with a `ServingHalf` and the server's hello judge |
| `server/src/remote/phoneSession.ts` | deleted |
| `server/src/remote/service.ts` | channels per device, the initiator rule, `join` |
| `server/src/remote/devices.ts`, `server/src/db/schema.ts`, `server/drizzle/0028_*.sql` | a device's `kind` |
| `server/src/remote/identity.ts` | `serverDeviceKind()` |
| `server/src/api/remoteRoutes.ts` | `POST /api/remote/join` |

---

### Task 1: Device kinds and the initiator rule

**Files:**
- Create: `shared/src/remote/device.ts`
- Test: `shared/test/device.test.ts`

**Interfaces:**
- Produces: `type DeviceKind = 'desktop' | 'headless' | 'phone'`; `type Capability = 'sessions' | 'map' | 'ide' | 'folderPicker' | 'presence'`; `capabilitiesOf(kind: DeviceKind): Capability[]`; `initiates(self: { id: string; kind: DeviceKind }, peer: { id: string; kind: string | null }): boolean`; `osName(platform: string): string`; `RESPONDER_FIRST_ID: number`.

- [ ] **Step 1: Write the failing test**

```ts
// shared/test/device.test.ts
import { describe, expect, it } from 'vitest';
import { RESPONDER_FIRST_ID, capabilitiesOf, initiates, osName } from '../src/remote/device.js';

describe('initiates', () => {
  const a = 'AAAA';
  const b = 'BBBB';
  it('a phone always initiates', () => {
    expect(initiates({ id: b, kind: 'phone' }, { id: a, kind: 'desktop' })).toBe(true);
  });
  it('never initiates towards a phone', () => {
    expect(initiates({ id: a, kind: 'desktop' }, { id: b, kind: 'phone' })).toBe(false);
  });
  it('initiates towards a device paired through an older Mac code', () => {
    expect(initiates({ id: b, kind: 'desktop' }, { id: a, kind: null })).toBe(true);
  });
  it('between two other members the lower id initiates, and exactly one does', () => {
    expect(initiates({ id: a, kind: 'desktop' }, { id: b, kind: 'headless' })).toBe(true);
    expect(initiates({ id: b, kind: 'headless' }, { id: a, kind: 'desktop' })).toBe(false);
  });
  it('a kind it does not know counts as a member, not as a phone', () => {
    expect(initiates({ id: a, kind: 'desktop' }, { id: b, kind: 'tablet' })).toBe(true);
    expect(initiates({ id: b, kind: 'desktop' }, { id: a, kind: 'tablet' })).toBe(false);
  });
});

describe('capabilitiesOf', () => {
  it('a phone serves nothing and a headless server only sessions', () => {
    expect(capabilitiesOf('phone')).toEqual([]);
    expect(capabilitiesOf('headless')).toEqual(['sessions']);
    expect(capabilitiesOf('desktop')).toContain('sessions');
  });
});

describe('osName', () => {
  it('names Node and Capacitor platforms', () => {
    expect(osName('darwin')).toBe('macos');
    expect(osName('linux')).toBe('linux');
    expect(osName('ios')).toBe('ios');
  });
});

it('responder ids never meet initiator ids a phone can reach', () => {
  expect(RESPONDER_FIRST_ID).toBeGreaterThan(2 ** 30);
  expect(RESPONDER_FIRST_ID).toBeLessThan(2 ** 32);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run -w shared test/device.test.ts` (from the repo root: `npm test -w shared -- device`)
Expected: FAIL, cannot resolve `../src/remote/device.js`.

- [ ] **Step 3: Implement**

```ts
// shared/src/remote/device.ts
/**
 * What a device in a group is (spec 2026-10-16-device-group-design § 1, § 8):
 * its kind, what it does, and which side of a pair opens the channel (§ 5).
 */

export type DeviceKind = 'desktop' | 'headless' | 'phone';
export type Capability = 'sessions' | 'map' | 'ide' | 'folderPicker' | 'presence';

/**
 * The first ask id of a channel's responder. The initiator numbers from 1;
 * a blob chunk's id (a 32-bit field) then says on its own whether it
 * answers this side's ask or carries the peer's upload.
 */
export const RESPONDER_FIRST_ID = 2 ** 31;

export function capabilitiesOf(kind: DeviceKind): Capability[] {
  if (kind === 'phone') return [];
  if (kind === 'headless') return ['sessions'];
  return ['sessions', 'map', 'ide', 'folderPicker', 'presence'];
}

/**
 * Whether this device opens the channel to `peer`. `peer.kind` null: paired
 * through the code of a Mac from before kinds, which only ever answers.
 */
export function initiates(self: { id: string; kind: DeviceKind }, peer: { id: string; kind: string | null }): boolean {
  if (self.kind === 'phone') return true;
  if (peer.kind === 'phone') return false;
  if (peer.kind === null) return true;
  return self.id < peer.id;
}

/** A Node `process.platform` or a Capacitor platform, as a device names its OS. */
export function osName(platform: string): string {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return platform;
}
```

- [ ] **Step 4: Run the test**

Run: `npm test -w shared -- device`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/remote/device.ts shared/test/device.test.ts
git commit -m "Device kinds, capabilities and which side opens a channel"
```

---

### Task 2: One hello for every device, asks and answers named for what they are

**Files:**
- Modify: `shared/src/remote/messages.ts`
- Modify: `shared/src/remote/relayApi.ts` (sealed device `kind`, `QrPayload.kind`, pairing-code helpers)
- Modify (mechanical rename): `shared/src/remote/client.ts`, `server/src/remote/phoneSession.ts`, `server/test/remoteFakePhone.ts`, `server/test/remotePhoneSession.test.ts`, `shared/test/client.test.ts`, `shared/test/messages.test.ts`
- Test: `shared/test/messages.test.ts`, `shared/test/relayApi.test.ts`

**Interfaces:**
- Produces: `HelloMessage` (zod) and its type; `AskMessage` (the former `PhoneMessage` without `hello`); `AnswerMessage` (the former `MacMessage` without `hello`); `type ChannelMessage = { kind: 'hello'; msg: HelloMessage } | { kind: 'ask'; msg: AskMessage } | { kind: 'answer'; msg: AnswerMessage }`; `parseChannelMessage(value: unknown): ChannelMessage | null`; `peerServes(hello: HelloMessage): boolean`; `PairingDevice = { name: string; platform: string; kind?: string }`; `QrPayload.kind?: string`; `parsePairingCode(code: string): QrPayload | null`; `encodePairingCode(qrJson: string): string`.
- The names `PhoneMessage` and `MacMessage` are gone after this task.

- [ ] **Step 1: Write the failing tests**

Append to `shared/test/messages.test.ts`:

```ts
import { HelloMessage, PROTOCOL_VERSION, parseChannelMessage, peerServes } from '../src/remote/messages.js';

describe('parseChannelMessage', () => {
  it('reads a shipped phone hello and a shipped Mac hello', () => {
    expect(parseChannelMessage({ t: 'hello', protocol: 1, app: 'orbital-mobile/0.9.0' })?.kind).toBe('hello');
    expect(parseChannelMessage({ t: 'hello', protocol: 1, server: '0.30.0', macName: 'studio' })?.kind).toBe('hello');
  });
  it('keeps a kind and capabilities it does not know', () => {
    const parsed = parseChannelMessage({ t: 'hello', protocol: 1, app: 'x/1', kind: 'tablet', capabilities: ['sessions', 'teleport'] });
    expect(parsed).toEqual({ kind: 'hello', msg: expect.objectContaining({ kind: 'tablet', capabilities: ['sessions', 'teleport'] }) });
  });
  it('tells a subscribe (ask) from a hub frame (answer)', () => {
    expect(parseChannelMessage({ t: 'ws', type: 'subscribe', topic: 'sessions' })?.kind).toBe('ask');
    expect(parseChannelMessage({ t: 'ws', frame: { topic: 'sessions' } })?.kind).toBe('answer');
  });
  it('reads every ask and answer kind once', () => {
    expect(parseChannelMessage({ t: 'http', id: 1, method: 'GET', path: '/api/health' })?.kind).toBe('ask');
    expect(parseChannelMessage({ t: 'http_res', id: 1, status: 200, body: {} })?.kind).toBe('answer');
    expect(parseChannelMessage({ t: 'bye', reason: 'revoked' })?.kind).toBe('answer');
    expect(parseChannelMessage({ t: 'nonsense' })).toBeNull();
  });
});

describe('peerServes', () => {
  const hello = (extra: object) => HelloMessage.parse({ t: 'hello', protocol: PROTOCOL_VERSION, ...extra });
  it('a shipped Mac serves, a shipped phone does not', () => {
    expect(peerServes(hello({ server: '0.30.0', macName: 'studio' }))).toBe(true);
    expect(peerServes(hello({ app: 'orbital-mobile/0.9.0' }))).toBe(false);
  });
  it('a device that names its capabilities serves when it runs sessions', () => {
    expect(peerServes(hello({ app: 'a/1', server: '1', macName: 'm', capabilities: [] }))).toBe(false);
    expect(peerServes(hello({ app: 'a/1', capabilities: ['sessions'] }))).toBe(true);
  });
});
```

Append to `shared/test/relayApi.test.ts`:

```ts
import { encodePairingCode, openPairingDevice, parsePairingCode, sealPairingDevice } from '../src/remote/relayApi.js';
import { deviceId, generateIdentity } from '../src/remote/keys.js';

describe('pairing device kind', () => {
  it('seals and opens a kind, and opens a device sealed without one', () => {
    const secret = new Uint8Array(16).fill(7);
    const key = generateIdentity().publicKey;
    const withKind = sealPairingDevice(secret, key, { name: 'studio', platform: 'macos', kind: 'desktop' });
    expect(openPairingDevice(secret, key, withKind)).toEqual({ name: 'studio', platform: 'macos', kind: 'desktop' });
    const without = sealPairingDevice(secret, key, { name: 'Pixel', platform: 'android' });
    expect(openPairingDevice(secret, key, without)).toEqual({ name: 'Pixel', platform: 'android' });
  });
});

describe('pairing code', () => {
  const mac = deviceId(generateIdentity().publicKey);
  const qr = JSON.stringify({ v: 1, relay: 'https://r', mac, name: 'studio', token: 't', secret: 's', kind: 'desktop' });
  it('reads the QR JSON and its one-word form', () => {
    expect(parsePairingCode(qr)?.kind).toBe('desktop');
    expect(parsePairingCode(encodePairingCode(qr))?.mac).toBe(mac);
  });
  it('refuses anything else', () => {
    expect(parsePairingCode('hello')).toBeNull();
    expect(parsePairingCode(JSON.stringify({ v: 1, relay: 'r', mac: 'nope', name: 'n', token: 't', secret: 's' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -w shared -- messages relayApi`
Expected: FAIL (`parseChannelMessage` is not exported, `kind` is dropped by `openPairingDevice`, `parsePairingCode` is not exported).

- [ ] **Step 3: Implement in `messages.ts`**

Replace the two unions at the bottom of `shared/src/remote/messages.ts` (`export const PhoneMessage = …` through `export type MacMessage = …`) with the following. Every variant other than `hello` keeps its exact schema and doc comment; only the union names change and `hello` moves out.

```ts
/**
 * Every device's greeting, both ways, the initiator's first (spec
 * 2026-10-16-device-group-design § 5). A shipped phone sends only
 * `protocol` and `app`; a shipped Mac only `protocol`, `server` and
 * `macName`, and a shipped phone requires those two of whatever serves it.
 * `kind` and `capabilities` stay strings: a device from a later release may
 * name one this one does not know.
 */
export const HelloMessage = z.object({
  t: z.literal('hello'),
  protocol: z.number().int(),
  app: z.string().optional(),
  server: z.string().optional(),
  macName: z.string().optional(),
  version: z.string().optional(),
  kind: z.string().max(20).optional(),
  os: z.string().max(20).optional(),
  name: z.string().max(80).optional(),
  capabilities: z.array(z.string().max(32)).max(32).optional(),
});
export type HelloMessage = z.infer<typeof HelloMessage>;

/** What a device asks of the one that serves (until 2026-10-16 `PhoneMessage`, the phone being the only asker). */
export const AskMessage = z.discriminatedUnion('t', [
  /* every PhoneMessage variant except `hello`, unchanged */
]);
export type AskMessage = z.infer<typeof AskMessage>;

/** What the serving device answers (until 2026-10-16 `MacMessage`). */
export const AnswerMessage = z.discriminatedUnion('t', [
  /* every MacMessage variant except `hello`, unchanged */
]);
export type AnswerMessage = z.infer<typeof AnswerMessage>;

export type ChannelMessage =
  | { kind: 'hello'; msg: HelloMessage }
  | { kind: 'ask'; msg: AskMessage }
  | { kind: 'answer'; msg: AnswerMessage };

/**
 * One inner JSON message, sorted. `ws` is the one `t` both sides use: a
 * subscribe names `type` and `topic`, a hub frame carries `frame`, so the
 * ask is tried first.
 */
export function parseChannelMessage(value: unknown): ChannelMessage | null {
  const t = (value as { t?: unknown } | null)?.t;
  if (t === 'hello') {
    const hello = HelloMessage.safeParse(value);
    return hello.success ? { kind: 'hello', msg: hello.data } : null;
  }
  const ask = AskMessage.safeParse(value);
  if (ask.success) return { kind: 'ask', msg: ask.data };
  const answer = AnswerMessage.safeParse(value);
  return answer.success ? { kind: 'answer', msg: answer.data } : null;
}

/** Whether the peer runs sessions this device may ask about: by its capabilities, else a shipped Mac by its `server`. */
export function peerServes(hello: HelloMessage): boolean {
  return hello.capabilities ? hello.capabilities.includes('sessions') : hello.server !== undefined;
}
```

When copying the variants, the comment placeholders above are replaced by the literal variant list from the old unions (in `AskMessage`: `ws`, `http`, `blob_get`, `file_get`, `blob_put`, `notifications_get`, `notifications_set`, `seen`; in `AnswerMessage`: `bye`, `ws`, `http_res`, `blob_meta`, `blob_put_done`, `notifications`).

- [ ] **Step 4: Implement in `relayApi.ts`**

```ts
/** What a device tells the one whose code it redeems, for the confirmation and the paired list. `kind`: absent from a phone that predates kinds. */
export type PairingDevice = { name: string; platform: string; kind?: string };
const PairingDeviceSchema = z.object({
  name: z.string().max(PAIR_NAME_MAX_CHARS),
  platform: z.string().max(PAIR_PLATFORM_MAX_CHARS),
  kind: z.string().max(PAIR_PLATFORM_MAX_CHARS).optional(),
});
```

In `sealPairingDevice`, seal `kind` when present:

```ts
  const plain = new TextEncoder().encode(JSON.stringify({
    name: device.name.slice(0, PAIR_NAME_MAX_CHARS), platform: device.platform.slice(0, PAIR_PLATFORM_MAX_CHARS),
    ...(device.kind !== undefined ? { kind: device.kind.slice(0, PAIR_PLATFORM_MAX_CHARS) } : {}),
  }));
```

`openPairingDevice` returns `parsed.data` as before; with the schema above an absent `kind` stays absent.

Add `kind` to `QrPayload` (a shipped phone's schema strips it):

```ts
export const QrPayload = z.object({
  v: z.literal(1), relay: z.string(), mac: z.string(), name: z.string(), token: z.string(), secret: z.string(),
  relaySecret: z.string().optional(),
  /** The kind of the device that shows the code; absent from a Mac from before kinds. */
  kind: z.string().max(PAIR_PLATFORM_MAX_CHARS).optional(),
});
```

Add the pairing-code helpers at the end of the file (`publicKeyOf`, `fromBase64Url` and `toBase64Url` are already imported from `./keys.js`; add any that is not):

```ts
/**
 * A pairing code as a device pastes it: the QR's JSON as is, or as one
 * base64url word (`encodePairingCode`). Null for anything else, a `mac`
 * that is not a device id included.
 */
export function parsePairingCode(code: string): QrPayload | null {
  const text = code.trim();
  const candidates = [text];
  try {
    candidates.push(new TextDecoder().decode(fromBase64Url(text)));
  } catch {
    /* not base64url */
  }
  for (const candidate of candidates) {
    try {
      const parsed = QrPayload.safeParse(JSON.parse(candidate));
      if (parsed.success && publicKeyOf(parsed.data.mac)) return parsed.data;
    } catch {
      /* the next form */
    }
  }
  return null;
}

/** The QR's JSON as one word to copy. */
export function encodePairingCode(qrJson: string): string {
  return toBase64Url(new TextEncoder().encode(qrJson));
}
```

- [ ] **Step 5: Rename the users**

In each file listed under Modify (mechanical rename), replace the type `PhoneMessage` with `AskMessage | HelloMessage` where a `hello` is sent or matched, and with `AskMessage` elsewhere; replace `MacMessage` likewise with `AnswerMessage | HelloMessage` / `AnswerMessage`. Where code calls `PhoneMessage.safeParse(x)` or `MacMessage.safeParse(x)`, call `parseChannelMessage(x)` and branch on `.kind`. These files are rewritten in Tasks 3–5; this step only keeps them compiling.

Run: `npm run typecheck -w shared && npm run typecheck -w server && npm run typecheck -w web`
Expected: no errors.

- [ ] **Step 6: Run the tests**

Run: `npm test -w shared && npm test -w server -- remote`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add shared server/src/remote server/test
git commit -m "One hello for every device; asks and answers named for what they are; kind in pairing"
```

---

### Task 3: `Channel` — one end-to-end channel, both directions

**Files:**
- Create: `shared/src/remote/channel.ts`
- Test: `shared/test/channel.test.ts`

**Interfaces:**
- Consumes: `initiates` is not used here; `RESPONDER_FIRST_ID` (Task 1); `HelloMessage`, `AskMessage`, `AnswerMessage`, `parseChannelMessage`, `peerServes` (Task 2).
- Produces (all exported from `channel.ts`):
  - the types and class moved from `client.ts`: `HttpMethod`, `ByeReason`, `TunnelResponse`, `BlobResult`, `FileResult`, `GetFileOptions`, `PutBlobResult`, `TunnelFailure`, `TunnelError`, and the constants `HANDSHAKE_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `TUNNEL_SILENCE_TIMEOUT_MS`;
  - `MAX_INNER_BYTES` (moved from `server/src/remote/phoneSession.ts`);
  - `type OwnHello = Omit<HelloMessage, 't' | 'protocol'>`;
  - `type BlobChunk = { id: number; seq: number; last: boolean; bytes: Uint8Array }`;
  - `interface ChannelReply { json(msg: AnswerMessage): void; inner(chunk: BlobChunk): void }`;
  - `interface ChannelServer { open(reply: ChannelReply, peer: HelloMessage): void; ask(msg: AskMessage): void; chunk(chunk: BlobChunk): void; reset(): void }`;
  - `type HelloVerdict = { reason: ByeReason; needed?: string } | null`;
  - `type ChannelEvent = { type: 'hello'; hello: HelloMessage } | { type: 'ready'; ready: boolean } | { type: 'hub'; frame: unknown } | { type: 'bye'; reason: ByeReason; needed?: string } | { type: 'silent' } | { type: 'closed' }`;
  - `type ChannelOptions = { identity: Identity; peerKey: Uint8Array; role: Role; hello: OwnHello; send(body: Uint8Array): void; serve?: ChannelServer; judge?(hello: HelloMessage): HelloVerdict; handshakeTimeoutMs?: number; requestTimeoutMs?: number; silenceTimeoutMs?: number }`;
  - `class Channel` with `start()`, `receive(body)`, `close(reason?, needed?)`, `on(listener)`, getters `ready`, `serves`, `peer`, field `dropped`, and the asking API `request`, `getBlob`, `getFile`, `putBlob`, `getNotifications`, `setNotifications`, `seen`, `subscribe`, `unsubscribe` with the signatures `RemoteClient` has today.

- [ ] **Step 1: Write the failing test**

```ts
// shared/test/channel.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateIdentity } from '../src/remote/keys.js';
import { Channel, MAX_INNER_BYTES, TunnelError, type ChannelReply, type ChannelServer } from '../src/remote/channel.js';
import { RESPONDER_FIRST_ID } from '../src/remote/device.js';
import type { AskMessage, HelloMessage } from '../src/remote/messages.js';

const desktop = (name: string) => ({
  app: `orbital-desktop/1.0.0`, server: '1.0.0', macName: name, version: '1.0.0', kind: 'desktop', os: 'macos', name,
  capabilities: ['sessions'],
});

/** A serving half that answers `GET /echo` with its own name, and keeps every upload. */
function echoServer(name: string) {
  let reply: ChannelReply | null = null;
  const uploads = new Map<number, Uint8Array[]>();
  const server: ChannelServer & { uploads: typeof uploads } = {
    uploads,
    open: (r) => { reply = r; },
    reset: () => { reply = null; uploads.clear(); },
    ask: (msg: AskMessage) => {
      if (msg.t === 'http') {
        const body = msg.path === '/huge' ? 'x'.repeat(MAX_INNER_BYTES + 10) : { from: name, path: msg.path };
        reply!.json({ t: 'http_res', id: msg.id, status: 200, body });
      }
      if (msg.t === 'blob_get') {
        const bytes = new Uint8Array(70_000).fill(name === 'a' ? 1 : 2);
        reply!.json({ t: 'blob_meta', id: msg.id, status: 200, bytes: bytes.length, mediaType: 'image/png' });
        reply!.inner({ id: msg.id, seq: 0, last: false, bytes: bytes.slice(0, 65_536) });
        reply!.inner({ id: msg.id, seq: 1, last: true, bytes: bytes.slice(65_536) });
      }
      if (msg.t === 'blob_put') uploads.set(msg.id, []);
    },
    chunk: (c) => {
      uploads.get(c.id)?.push(c.bytes);
      if (c.last) reply!.json({ t: 'blob_put_done', id: c.id, entry: { ref: `${'a'.repeat(64)}.png`, w: 1, h: 1, bytes: 1 } });
    },
  };
  return server;
}

/** Two channels wired back to back through a queue, as the relay would carry their frames. */
function pair(opts: { aServes?: boolean; bServes?: boolean; bHello?: Partial<HelloMessage> } = {}) {
  const aId = generateIdentity();
  const bId = generateIdentity();
  const queue: (() => void)[] = [];
  const pump = () => { while (queue.length) queue.shift()!(); };
  const aServer = echoServer('a');
  const bServer = echoServer('b');
  const a: Channel = new Channel({
    identity: aId, peerKey: bId.publicKey, role: 'initiator', hello: desktop('a'),
    send: (body) => queue.push(() => b.receive(body)), serve: opts.aServes === false ? undefined : aServer,
  });
  const b: Channel = new Channel({
    identity: bId, peerKey: aId.publicKey, role: 'responder', hello: { ...desktop('b'), ...opts.bHello },
    send: (body) => queue.push(() => a.receive(body)), serve: opts.bServes === false ? undefined : bServer,
  });
  return { a, b, pump, aServer, bServer, aId, bId };
}

describe('Channel', () => {
  afterEach(() => vi.useRealTimers());

  it('greets both ways and asks in both directions', async () => {
    const { a, b, pump } = pair();
    a.start();
    pump();
    expect(a.ready && b.ready).toBe(true);
    expect(a.peer?.name).toBe('b');
    expect(b.peer?.name).toBe('a');
    const fromB = a.request('GET', '/x');
    const fromA = b.request('GET', '/y');
    pump();
    await expect(fromB).resolves.toEqual({ status: 200, body: { from: 'b', path: '/x' } });
    await expect(fromA).resolves.toEqual({ status: 200, body: { from: 'a', path: '/y' } });
  });

  it('concurrent blob both ways: a chunk for a download is never taken as the peer upload', async () => {
    const { a, b, pump, aServer } = pair();
    a.start();
    pump();
    const down = b.getBlob(`${'b'.repeat(64)}.png`);
    const up = b.putBlob(new Uint8Array(10).fill(9), 'image/png');
    const downA = a.getBlob(`${'c'.repeat(64)}.png`);
    pump();
    expect((await down).bytes[0]).toBe(1);
    expect((await downA).bytes[0]).toBe(2);
    await expect(up).resolves.toMatchObject({ kind: 'ok' });
    expect([...aServer.uploads.keys()].every((id) => id >= RESPONDER_FIRST_ID)).toBe(true);
  });

  it('oversized answer: the asker gets 413, nothing throws', async () => {
    const { a, b, pump } = pair();
    a.start();
    pump();
    const req = a.request('GET', '/huge');
    pump();
    await expect(req).resolves.toEqual({ status: 413, body: { error: 'too_large' } });
    expect(b.ready).toBe(true);
  });

  it('asking a peer that serves nothing fails at once', async () => {
    const { a, pump } = pair({ bHello: { capabilities: [] }, bServes: false });
    a.start();
    pump();
    await expect(a.request('GET', '/x')).rejects.toEqual(new TunnelError('offline'));
  });

  it('a judge refusal closes the responder with bye before it greets', () => {
    const aId = generateIdentity();
    const bId = generateIdentity();
    const events: string[] = [];
    let b: Channel;
    const a = new Channel({
      identity: aId, peerKey: bId.publicKey, role: 'initiator', hello: { app: 'orbital-mobile/0.0.1', kind: 'phone' },
      send: (body) => b.receive(body),
    });
    a.on((e) => events.push(e.type === 'bye' ? `bye:${e.reason}` : e.type));
    b = new Channel({
      identity: bId, peerKey: aId.publicKey, role: 'responder', hello: desktop('b'),
      send: (body) => a.receive(body), judge: () => ({ reason: 'app_too_old', needed: '9.0.0' }),
    });
    a.start();
    expect(events).toContain('bye:app_too_old');
    expect(b.ready).toBe(false);
  });

  it('the responder rehandshakes when the initiator starts over, and fails what was in flight', async () => {
    const { a, b, pump } = pair();
    a.start();
    pump();
    const pending = b.request('GET', '/z');
    a.start(); // a new socket on the initiator's side: fresh handshake, same identity
    pump();
    await expect(pending).rejects.toEqual(new TunnelError('lost'));
    expect(a.ready && b.ready).toBe(true);
  });

  it('the initiator retries a handshake nobody answered', () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    const a = new Channel({
      identity: generateIdentity(), peerKey: generateIdentity().publicKey, role: 'initiator', hello: desktop('a'),
      send: (body) => sent.push(body), handshakeTimeoutMs: 100,
    });
    a.start();
    vi.advanceTimersByTime(250);
    expect(sent.length).toBe(3);
    a.close();
    vi.advanceTimersByTime(250);
    expect(sent.length).toBe(3);
  });

  it('says silent when a serving peer goes quiet', () => {
    vi.useFakeTimers();
    const { a, pump } = pair();
    const events: string[] = [];
    a.on((e) => events.push(e.type));
    a.start();
    pump();
    vi.advanceTimersByTime(60 * 60_000);
    expect(events).toContain('silent');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -w shared -- channel`
Expected: FAIL, cannot resolve `../src/remote/channel.js`.

- [ ] **Step 3: Implement `shared/src/remote/channel.ts`**

Start the file with the module comment and imports:

```ts
/**
 * One end-to-end channel between two paired devices, over whatever carries
 * its frames (spec 2026-10-16-device-group-design § 5; ADR
 * a-device-has-one-identity-and-one-channel-per-pair). Both sides ask and
 * both may serve: the asking half is the one the phone has always had, the
 * serving half is the caller's (`ChannelServer`). The handshake and the
 * cipher are `handshake.ts`'s. No DOM, no Node.
 *
 * Nothing here throws into a caller's frame loop: a bad frame is dropped and
 * counted (`dropped`), a listener that throws is its own problem.
 */
import type { Identity } from './keys.js';
import { concat } from './keys.js';
import { FRAME_HEADER_BYTES, MAX_FRAME_BYTES } from './frame.js';
import {
  GCM_TAG_BYTES, HANDSHAKE_BYTES, NONCE_BYTES, startHandshake, type Handshake, type Role, type SessionCipher,
} from './handshake.js';
import {
  PROTOCOL_VERSION, chunkBlob, decodeInner, encodeInner, parseChannelMessage, peerServes,
  type AnswerMessage, type AskMessage, type FileAs, type HelloMessage, type ImageRefEntry, type Inner,
  type NotificationSettings,
} from './messages.js';
import { RELAY_PING_INTERVAL_MS } from './relayApi.js';
import { RESPONDER_FIRST_ID } from './device.js';
```

Then move from `shared/src/remote/client.ts` into this file, verbatim with their doc comments: `TUNNEL_SILENCE_TIMEOUT_MS`, `HANDSHAKE_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `ByeReason`, `HttpMethod`, `TunnelResponse`, `BlobResult`, `FileResult`, `GetFileOptions`, `PutBlobResult`, `TunnelFailure`, `TunnelError`, `Timer`, `Waiter`, `BlobWaiter`, and the free function `concat` use. Move `MAX_INNER_BYTES` and its doc comment from `server/src/remote/phoneSession.ts`.

Then the new types and the class:

```ts
export type OwnHello = Omit<HelloMessage, 't' | 'protocol'>;
export type BlobChunk = { id: number; seq: number; last: boolean; bytes: Uint8Array };

/** How a serving half answers: an answer, or one chunk of a blob it sends. */
export interface ChannelReply {
  json(msg: AnswerMessage): void;
  inner(chunk: BlobChunk): void;
}

/**
 * What a device that serves plugs in. `open` once the peer's hello is
 * accepted, `reset` whenever the keys change or the channel ends — whatever
 * was tied to the old connection (subscriptions, half-sent uploads) goes.
 */
export interface ChannelServer {
  open(reply: ChannelReply, peer: HelloMessage): void;
  ask(msg: AskMessage): void;
  chunk(chunk: BlobChunk): void;
  reset(): void;
}

export type HelloVerdict = { reason: ByeReason; needed?: string } | null;

export type ChannelEvent =
  | { type: 'hello'; hello: HelloMessage }
  /** True once the peer's hello is in; false when that tunnel is gone. */
  | { type: 'ready'; ready: boolean }
  /** A hub frame from the serving peer, verbatim. */
  | { type: 'hub'; frame: unknown }
  | { type: 'bye'; reason: ByeReason; needed?: string }
  /** A serving peer said nothing for `silenceTimeoutMs`: the caller drops the link it rides on. */
  | { type: 'silent' }
  | { type: 'closed' };

export type ChannelOptions = {
  identity: Identity;
  peerKey: Uint8Array;
  role: Role;
  hello: OwnHello;
  /** One frame body — a handshake half or a ciphertext — to the peer. */
  send(body: Uint8Array): void;
  /** Absent on a device that serves nothing: the peer's asks are ignored and time out there. */
  serve?: ChannelServer;
  /** The responder's check of the peer's hello; a refusal answers with `bye` and closes. */
  judge?(hello: HelloMessage): HelloVerdict;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  silenceTimeoutMs?: number;
};

export class Channel {
  dropped = 0;
  private handshake: Handshake | null = null;
  private handshakeTimer: Timer | null = null;
  private cipher: SessionCipher | null = null;
  private peerHello: HelloMessage | null = null;
  private closed = false;
  private silenceTimer: Timer | null = null;
  private nextId: number;
  private readonly topics = new Set<string>();
  private readonly requests = new Map<number, Waiter<TunnelResponse>>();
  private readonly blobs = new Map<number, BlobWaiter>();
  private readonly puts = new Map<number, Waiter<PutBlobResult>>();
  private readonly notificationWaiters: Waiter<NotificationSettings>[] = [];
  private readonly listeners = new Set<(event: ChannelEvent) => void>();
  private readonly opts: ChannelOptions;
  private readonly reply: ChannelReply = {
    json: (msg) => { this.sendJson(msg); },
    inner: (chunk) => { this.sendInner({ kind: 'blob', ...chunk }); },
  };

  constructor(opts: ChannelOptions) {
    this.opts = opts;
    this.nextId = opts.role === 'initiator' ? 1 : RESPONDER_FIRST_ID;
  }

  /** The peer's hello is in: asks go through, if it serves. */
  get ready(): boolean {
    return this.cipher !== null && this.peerHello !== null && !this.closed;
  }

  get peer(): HelloMessage | null {
    return this.peerHello;
  }

  get serves(): boolean {
    return this.peerHello !== null && peerServes(this.peerHello);
  }

  on(listener: (event: ChannelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * The initiator's half, now and again every `handshakeTimeoutMs` until a
   * reply completes it; anything tied to a previous handshake is dropped
   * first. A responder only answers, so this does nothing there.
   */
  start(): void {
    if (this.opts.role !== 'initiator' || this.closed) return;
    this.reset('lost');
    const handshake = startHandshake(this.opts.identity, this.opts.peerKey, 'initiator');
    this.handshake = handshake;
    this.opts.send(handshake.message!);
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (!this.cipher) this.start();
    }, this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  }

  receive(body: Uint8Array): void {
    if (this.closed) return;
    if (this.silenceTimer) this.armSilence();
    if (!this.cipher) return this.completeHandshake(body);
    const plain = this.cipher.open(body);
    if (!plain) {
      if (this.opts.role === 'responder' && body.length === HANDSHAKE_BYTES) this.rehandshake(body);
      else this.dropped++;
      return;
    }
    const inner = decodeInner(plain);
    if (!inner) {
      this.dropped++;
      return;
    }
    if (inner.kind === 'blob') return this.onBlob(inner);
    const parsed = parseChannelMessage(inner.value);
    if (!parsed) {
      this.dropped++;
      return;
    }
    if (parsed.kind === 'hello') return this.onHello(parsed.msg);
    // A `bye` comes before any hello when the responder refuses one.
    if (parsed.kind === 'answer') return this.onAnswer(parsed.msg);
    if (this.peerHello) this.opts.serve?.ask(parsed.msg);
  }

  /** `reason` goes to the peer as `bye` when there are keys to send it with. */
  close(reason?: ByeReason, needed?: string): void {
    if (this.closed) return;
    if (reason && this.cipher) this.sendJson({ t: 'bye', reason, ...(needed !== undefined ? { needed } : {}) });
    this.reset('lost');
    this.closed = true;
    this.emit({ type: 'closed' });
  }

  private completeHandshake(body: Uint8Array): void {
    if (this.opts.role === 'responder') {
      // `complete` is single-use, so a bad first frame leaves nothing to retry.
      const handshake = startHandshake(this.opts.identity, this.opts.peerKey, 'responder');
      const cipher = handshake.complete(body);
      if (!cipher || !handshake.message) return this.close();
      this.cipher = cipher;
      this.opts.send(handshake.message);
      return;
    }
    const handshake = this.handshake;
    if (!handshake || body.length !== HANDSHAKE_BYTES) {
      this.dropped++;
      return;
    }
    this.handshake = null;
    const cipher = handshake.complete(body);
    // A reply that does not verify used the handshake up; the armed timer sends a fresh one.
    if (!cipher) {
      this.dropped++;
      return;
    }
    this.handshakeTimer = this.clear(this.handshakeTimer);
    this.cipher = cipher;
    this.sendJson(this.ownHello());
  }

  /**
   * A body the keys cannot open but sized like a handshake: the initiator
   * started over on a new socket while this side kept the channel. It
   * completes only if it verifies against the peer's identity, so nobody
   * else can reset the channel (as `PhoneSession` did until 2026-10-16).
   */
  private rehandshake(body: Uint8Array): void {
    const handshake = startHandshake(this.opts.identity, this.opts.peerKey, 'responder');
    const cipher = handshake.complete(body);
    if (!cipher || !handshake.message) return;
    this.reset('lost');
    this.cipher = cipher;
    this.opts.send(handshake.message);
  }

  private onHello(hello: HelloMessage): void {
    if (this.peerHello) return;
    if (this.opts.role === 'responder') {
      if (hello.protocol !== PROTOCOL_VERSION) return this.close('protocol');
      const verdict = this.opts.judge?.(hello) ?? null;
      if (verdict) return this.close(verdict.reason, verdict.needed);
    }
    this.peerHello = hello;
    if (this.opts.role === 'responder') this.sendJson(this.ownHello());
    this.opts.serve?.open(this.reply, hello);
    this.emit({ type: 'hello', hello });
    if (this.serves) {
      this.armSilence();
      // The peer dropped the previous connection's subscriptions.
      for (const topic of this.topics) this.sendJson({ t: 'ws', type: 'subscribe', topic });
    }
    this.emit({ type: 'ready', ready: true });
  }

  private ownHello(): HelloMessage {
    return { t: 'hello', protocol: PROTOCOL_VERSION, ...this.opts.hello };
  }
```

Then move from `client.ts`, adapting only the names given here:

- `request`, `getBlob`, `getFile`, `receiveBlob`, `putBlob`, `getNotifications`, `setNotifications`, `seen`, `subscribe`, `unsubscribe`, `askNotifications`, `fail`, `rearmBlob`: verbatim, except that every `if (!this.ready) return Promise.reject(new TunnelError('offline'))` becomes `if (!this.ready || !this.serves) return Promise.reject(new TunnelError('offline'))`, `seen` and `subscribe`/`unsubscribe` send only `if (this.ready && this.serves)`, and message types read `AskMessage`.
- `onMac` becomes `private onAnswer(msg: AnswerMessage)`: the `hello` case is gone (handled by `onHello`); the `bye` case calls `this.reset('bye')` then emits `{ type: 'bye', … }` (it does not close: the caller decides); the `ws` case emits `{ type: 'hub', frame }`; the rest is verbatim.
- `onChunk` becomes `private onBlob(chunk: BlobChunk)`: when `this.blobs` has `chunk.id` the body is the old `onChunk`; otherwise `if (this.peerHello) this.opts.serve?.chunk(chunk); else this.dropped++;`.
- `dropTunnel(why)` becomes `private reset(why: 'lost' | 'bye')`: as before, plus `this.peerHello = null`, `this.opts.serve?.reset()`, and the `ready: false` event when it was ready.
- `armSilence`: `this.silenceTimer = setTimeout(() => this.emit({ type: 'silent' }), this.opts.silenceTimeoutMs ?? TUNNEL_SILENCE_TIMEOUT_MS)`, after clearing the previous one.
- `sendJson(msg: HelloMessage | AskMessage | AnswerMessage): boolean` encodes and applies the size guards that `PhoneSession.sendJson` had (an `http_res` over `MAX_INNER_BYTES` becomes `{ t: 'http_res', id, status: 413, body: { error: 'too_large' } }`; a `ws` with a `frame` over it becomes the `dropped` frame), then calls `sendInner`.
- `sendInner(inner: Inner): boolean` — `if (!this.cipher || this.closed) return false;` then `try { this.opts.send(this.cipher.seal(encodeInner(inner))); return true; } catch { return false; }`.
- `emit` and `clear`: verbatim.

- [ ] **Step 4: Run the test**

Run: `npm test -w shared -- channel`
Expected: PASS. If `concurrent blob both ways` fails, the chunk dispatch in `onBlob` is checking the wrong map.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck -w shared`
Expected: no errors (`client.ts` still has its own copies until Task 4; duplicate names across modules are fine).

```bash
git add shared/src/remote/channel.ts shared/test/channel.test.ts
git commit -m "Channel: one end-to-end channel that asks and serves in both directions"
```

---

### Task 4: The phone's `RemoteClient` runs its tunnel on a `Channel`

**Files:**
- Modify: `shared/src/remote/client.ts`
- Modify: `web/src/mobile/connect.ts`
- Test: `shared/test/client.test.ts`, `server/test/remoteClient.test.ts`

**Interfaces:**
- Consumes: `Channel`, `TunnelError` and the moved types (Task 3); `osName`, `capabilitiesOf` (Task 1).
- Produces: `RemoteClient`'s public API unchanged (`status`, `macOnline`, `dropped`, `id`, `ready`, `on`, `start`, `stop`, `recheck`, `request`, `getBlob`, `getFile`, `putBlob`, `getNotifications`, `setNotifications`, `seen`, `pushToken`, `subscribe`, `unsubscribe`, `redeem`, `waitForPairing`, and the `RemoteClientEvent` union). `client.ts` re-exports `TunnelError`, `HttpMethod`, `ByeReason`, `TunnelResponse`, `BlobResult`, `FileResult`, `GetFileOptions`, `PutBlobResult`, `TunnelFailure`, `HANDSHAKE_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `TUNNEL_SILENCE_TIMEOUT_MS` from `./channel.js`, so no importer changes. New option `RemoteClientOptions.os?: string`. `redeem` gains a fifth parameter `kind = 'phone'`.

- [ ] **Step 1: Write the failing tests**

In `shared/test/client.test.ts`, find the assertion on the phone's first message (`read(sock)` after the handshake, which expects `{ t: 'hello', protocol: PROTOCOL_VERSION, app: … }`) and change it to:

```ts
expect(mac.read(sock)).toEqual({
  t: 'hello', protocol: PROTOCOL_VERSION, app: 'orbital-mobile/test', kind: 'phone', os: 'android', capabilities: [],
});
```

(and pass `os: 'android'` in `setup()`'s `RemoteClient` options; keep the `app` value the file already uses). Add:

```ts
it('old Mac hello: a Mac that names no capabilities serves, and its watchdog runs', async () => {
  vi.useFakeTimers();
  const { client, sock, mac } = setup();
  client.start();
  // drive challenge → ok → handshake as the file's other tests do (reuse its `connectAndGreet` helper
  // if it has one; otherwise: sock.control challenge, sock.control ok with [mac.id], mac.answer(sock, phoneKey))
  mac.send(sock, { t: 'hello', protocol: PROTOCOL_VERSION, server: '0.30.0', macName: 'studio' } as never);
  expect(client.ready).toBe(true);
  const pending = client.request('GET', '/api/health');
  expect(mac.read(sock)).toMatchObject({ t: 'http', method: 'GET', path: '/api/health' });
  mac.send(sock, { t: 'http_res', id: 1, status: 200, body: {} });
  await expect(pending).resolves.toEqual({ status: 200, body: {} });
  vi.advanceTimersByTime(TUNNEL_SILENCE_TIMEOUT_MS + 1);
  expect(sock.closed).toBe(true);
});
```

Import `TUNNEL_SILENCE_TIMEOUT_MS` from `../src/remote/client.js` (it is re-exported). Follow the file's existing sequence for reaching a greeted tunnel; the helper names in the comment are the ones to look for.

In `server/test/remoteClient.test.ts` (the client against the real Mac), add after the existing greeting assertion:

```ts
expect(seenHello).toMatchObject({ kind: 'desktop', capabilities: expect.arrayContaining(['sessions']) });
```

where `seenHello` is captured with `client.on((e) => { if (e.type === 'hello') seenHello = e; })` before `start()`. This fails until Task 5 sends the new hello; it is listed here so Task 5 turns it green.

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -w shared -- client`
Expected: FAIL on the hello shape.

- [ ] **Step 3: Implement**

In `client.ts`:

1. Delete everything moved to `channel.ts` in Task 3 and add
   `export { TunnelError, HANDSHAKE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, TUNNEL_SILENCE_TIMEOUT_MS } from './channel.js';`
   `export type { HttpMethod, ByeReason, TunnelResponse, BlobResult, FileResult, GetFileOptions, PutBlobResult, TunnelFailure } from './channel.js';`
2. Add `os?: string` to `RemoteClientOptions` with the doc comment "The phone's OS as `hello` names it (`osName` of the Capacitor platform); absent in tests that do not care."
3. Replace the fields `handshake`, `cipher`, `greeted`, `nextId`, `requests`, `blobs`, `puts`, `notificationWaiters`, `silenceTimer`, `handshakeTimer` with `private channel: Channel | null = null;` and keep `topics` as the list the client re-applies to every new channel.
4. `ready` returns `this.channel?.ready === true`.
5. Every asking method delegates; with no channel it rejects `new TunnelError('offline')` (or returns, for `seen`):

```ts
  request(method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    return this.channel ? this.channel.request(method, path, body) : Promise.reject(new TunnelError('offline'));
  }
  // likewise getBlob, getFile, putBlob, getNotifications, setNotifications
  seen(sessionId: string): void {
    this.channel?.seen(sessionId);
  }
  subscribe(topic: string): void {
    this.topics.add(topic);
    this.channel?.subscribe(topic);
  }
  unsubscribe(topic: string): void {
    this.topics.delete(topic);
    this.channel?.unsubscribe(topic);
  }
```

6. `beginHandshake(macCameBack = false)` builds a channel when it should start one:

```ts
  private beginHandshake(macCameBack = false): void {
    if (!this.ws || this.status !== 'online') return;
    if (this.channel && (this.channel.ready || !macCameBack)) return;
    this.dropTunnel('lost');
    const channel = new Channel({
      identity: this.opts.identity, peerKey: this.macKey, role: 'initiator',
      hello: { app: this.opts.app, kind: 'phone', ...(this.opts.os ? { os: this.opts.os } : {}), capabilities: capabilitiesOf('phone') },
      send: (body) => this.sendFrame(body),
      handshakeTimeoutMs: this.opts.handshakeTimeoutMs,
      requestTimeoutMs: this.opts.requestTimeoutMs,
      silenceTimeoutMs: this.opts.silenceTimeoutMs,
    });
    for (const topic of this.topics) channel.subscribe(topic);
    channel.on((event) => this.onChannel(channel, event));
    this.channel = channel;
    channel.start();
  }

  private onChannel(channel: Channel, event: ChannelEvent): void {
    if (this.channel !== channel) return;
    switch (event.type) {
      case 'hello':
        this.emit({ type: 'hello', server: event.hello.server ?? '', macName: event.hello.macName ?? '' });
        return;
      case 'ready':
        this.emit({ type: 'ready', ready: event.ready });
        return;
      case 'hub':
        this.emit({ type: 'hub', frame: event.frame });
        return;
      case 'bye':
        this.emit({ type: 'bye', reason: event.reason, ...(event.needed !== undefined ? { needed: event.needed } : {}) });
        if (event.reason === 'revoked') this.stop();
        return;
      case 'silent':
        this.lose(this.ws);
        return;
      case 'closed':
        return;
    }
  }
```

   The guard keeps today's rule: one handshake at a time, and a tunnel still in place is replaced only when the Mac came back (`macCameBack`). A handshake in flight (channel exists, not ready) is left alone unless the Mac came back.
7. `dropTunnel(why)` becomes: `const channel = this.channel; this.channel = null; channel?.close();` — `close` fails every waiter with `lost`. Callers that dropped with `'bye'` no longer exist here (the channel handles a received `bye`).
8. `onBinary`: after the peer check and the empty-body wake branch, `this.channel ? this.channel.receive(frame.body) : this.dropped++;` — drop the old `completeHandshake`/cipher/`MacMessage` code. The silence re-arm at the top of `onBinary` is gone (the channel re-arms on `receive`).
9. `redeem(token, secret, name, platform, kind = 'phone')` seals `{ name, platform, kind }`.
10. `sendFrame` stays as is.

In `web/src/mobile/connect.ts`, pass the OS:

```ts
import { Capacitor } from '@capacitor/core'
import { osName } from '@orbital/shared/remote/device'
// in newClient:
  return new RemoteClient({
    relayUrl, mac, identity, WebSocketImpl: WebSocket, app: mobileApp(), expectPaired, relaySecret,
    os: osName(Capacitor.getPlatform()),
  })
```

Check that `@orbital/shared/remote/device` resolves in `web/` the way `@orbital/shared/remote/client` does (the `exports` map in `shared/package.json`); add the entry there if `remote/*` is listed file by file.

- [ ] **Step 4: Run the tests**

Run: `npm test -w shared && npm test -w web -- mobile && npm run typecheck -w shared && npm run typecheck -w web`
Expected: PASS, no type errors. `server/test/remoteClient.test.ts` stays red on the one new assertion until Task 5.

- [ ] **Step 5: Commit**

```bash
git add shared/src/remote/client.ts shared/test/client.test.ts web/src/mobile/connect.ts shared/package.json server/test/remoteClient.test.ts
git commit -m "Phone client runs its tunnel on a Channel and names its kind and OS"
```

---

### Task 5: The server serves through `ServingHalf` on a `Channel`

**Files:**
- Create: `server/src/remote/servingHalf.ts`, `server/src/remote/deviceChannel.ts`
- Delete: `server/src/remote/phoneSession.ts`
- Modify: `server/src/remote/service.ts`, `server/src/remote/identity.ts`
- Rename + modify test: `server/test/remotePhoneSession.test.ts` → `server/test/remoteDeviceChannel.test.ts`; `server/test/remoteFakePhone.ts`
- Test: `server/test/remoteEndToEnd.test.ts`, `server/test/remoteService.test.ts`, `server/test/remoteClient.test.ts`

**Interfaces:**
- Consumes: `Channel`, `ChannelServer`, `ChannelReply`, `HelloVerdict`, `MAX_INNER_BYTES`, `OwnHello` (Task 3); `capabilitiesOf`, `osName`, `DeviceKind` (Task 1).
- Produces:
  - `class ServingHalf implements ChannelServer` with `constructor(opts: ServingHalfOptions)`; `ServingHalfOptions = { deviceId: string; hub: Hub; inject: InjectFn; images: ImageStore; imagesDir: string; files: PhoneFileReader; notifications: { get(): NotificationSettings; set(s: NotificationSettings): void }; onSeen(sessionId: string): void; atMac?: () => boolean }`; `InjectFn` and `phoneMayWatch`, `PHONE_ALLOWED_TOPICS`, `PHONE_ALLOWED_TOPIC_PREFIXES`, `BLOB_PUT_MAX_BYTES`, `MAX_OPEN_UPLOADS` move here unchanged.
  - `judgeHello(hello: HelloMessage, minPhoneVersion?: string): { verdict: HelloVerdict; refusal: PhoneTooOld | null }` and `type PhoneTooOld = { version: string; needed: string }` in `deviceChannel.ts`.
  - `openDeviceChannel(opts: DeviceChannelOptions): Channel` with `DeviceChannelOptions = ServingHalfOptions & { identity: Identity; peerKey: Uint8Array; role: Role; hello: OwnHello; send(body: Uint8Array): void; onAppVersion?: (refusal: PhoneTooOld | null) => void; minPhoneVersion?: string }`.
  - `serverDeviceKind(env?: NodeJS.ProcessEnv): DeviceKind` and `serverHello(o: { serverVersion: string; name: string; kind: DeviceKind }): OwnHello` in `identity.ts`.

- [ ] **Step 1: Port the tests first**

`git mv server/test/remotePhoneSession.test.ts server/test/remoteDeviceChannel.test.ts`. In it:

- `build()` constructs `openDeviceChannel({ deviceId, identity: mac, peerKey: phone.me.publicKey, role: 'responder', hello: serverHello({ serverVersion: '0.15.0', name: 'studio', kind: 'desktop' }), hub, inject, images, imagesDir: dir, files, notifications, send: phone.onMacBody, onSeen, onAppVersion, minPhoneVersion, atMac })` and returns it as `session`; `onClose` is replaced by `session.on((e) => { if (e.type === 'closed') onClose(); })`.
- The first test's expectation becomes the new hello, still carrying what a shipped phone reads:

```ts
expect(phone.out).toEqual([{
  t: 'hello', protocol: PROTOCOL_VERSION, server: '0.15.0', macName: 'studio', app: 'orbital-desktop/0.15.0',
  version: '0.15.0', kind: 'desktop', os: osName(process.platform), name: 'studio',
  capabilities: capabilitiesOf('desktop'),
}]);
```

- Add the legacy pin:

```ts
it('legacy phone hello: a shipped phone greets, is served, and uploads from id 1', async () => {
  const { phone, images } = build();
  phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'orbital-mobile/0.4.0' });
  expect(phone.out[0]).toMatchObject({ t: 'hello', server: '0.15.0', macName: 'studio' });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);
  phone.send({ t: 'blob_put', id: 1, mediaType: 'image/png', bytes: png.length });
  for (const chunk of chunkBlob(1, png)) phone.sendBlob(chunk);
  expect(phone.out.at(-1)).toMatchObject({ t: 'blob_put_done', id: 1 });
  void images;
});
```

(use whatever valid PNG fixture the file's existing upload test already builds, if it has one, instead of the literal bytes).

- Every other test keeps its assertions; `session.receive`, `session.close`, `session.ready` exist on `Channel`.

In `server/test/remoteFakePhone.ts`, `send(msg: AskMessage | HelloMessage)` and the received-message type `AnswerMessage | HelloMessage`; parse incoming with `parseChannelMessage` and push `.msg`.

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -w server -- remoteDeviceChannel`
Expected: FAIL, cannot resolve `../src/remote/deviceChannel.js`.

- [ ] **Step 3: Implement `identity.ts` additions**

```ts
import type { DeviceKind } from '@orbital/shared/remote/device';
import { capabilitiesOf, osName } from '@orbital/shared/remote/device';
import type { OwnHello } from '@orbital/shared/remote/channel';

/** A server started with `ORBITAL_HEADLESS=1` is a headless member (spec 2026-10-16-device-group-design § 11). */
export function serverDeviceKind(env: NodeJS.ProcessEnv = process.env): DeviceKind {
  return env.ORBITAL_HEADLESS === '1' ? 'headless' : 'desktop';
}

/**
 * This server's hello. `server` and `macName` are what a shipped phone
 * requires of whatever serves it; the rest names this device to one that
 * knows groups.
 */
export function serverHello(o: { serverVersion: string; name: string; kind: DeviceKind }): OwnHello {
  return {
    app: `orbital-${o.kind}/${o.serverVersion}`, server: o.serverVersion, macName: o.name, version: o.serverVersion,
    kind: o.kind, os: osName(process.platform), name: o.name, capabilities: capabilitiesOf(o.kind),
  };
}
```

- [ ] **Step 4: Implement `servingHalf.ts`**

Move from `phoneSession.ts`, verbatim with their comments: the module comment (reworded: "What a paired device's asks reach on this server …"), `BLOB_PUT_MAX_BYTES`, `MAX_OPEN_UPLOADS`, `PHONE_ALLOWED_TOPICS`, `PHONE_ALLOWED_TOPIC_PREFIXES`, `phoneMayWatch`, `IMAGE_CONTENT_TYPES`, `InjectFn`, `VirtualSocket`, `Upload`, and the methods `onHttp`, `onBlobGet`, `onFileGet`, `onChunk`, `fail`. Then:

```ts
export class ServingHalf implements ChannelServer {
  private reply: ChannelReply | null = null;
  private socket: VirtualSocket | null = null;
  private readonly uploads = new Map<number, Upload>();

  constructor(private readonly opts: ServingHalfOptions) {}

  open(reply: ChannelReply): void {
    this.reset();
    this.reply = reply;
    const socket = this.makeSocket();
    this.socket = socket;
    this.opts.hub.handleSocket(socket);
  }

  reset(): void {
    this.socket?.emit('close');
    this.socket = null;
    this.reply = null;
    this.uploads.clear();
  }

  /** `ask` runs inside the relay client's frame loop: a throwing hook answers 500, never unwinds into it. */
  ask(msg: AskMessage): void {
    try {
      this.onAsk(msg);
    } catch (err) {
      this.fail(msg.t, err);
      if (msg.t === 'http') this.answer({ t: 'http_res', id: msg.id, status: 500, body: { error: 'internal' } });
      else if (msg.t === 'blob_get' || msg.t === 'file_get') this.answer({ t: 'blob_meta', id: msg.id, status: 500 });
      else if (msg.t === 'blob_put') this.answer({ t: 'blob_put_done', id: msg.id, error: 'internal' });
    }
  }

  chunk(chunk: BlobChunk): void {
    try {
      this.onChunk(chunk);
    } catch (err) {
      this.uploads.delete(chunk.id);
      this.fail('blob chunk', err);
      this.answer({ t: 'blob_put_done', id: chunk.id, error: 'internal' });
    }
  }

  private answer(msg: AnswerMessage): void {
    this.reply?.json(msg);
  }

  private makeSocket(): VirtualSocket {
    const socket: VirtualSocket = Object.assign(new EventEmitter(), {
      send: (data: string) => {
        if (this.socket !== socket) return;
        // Every hub frame goes through, heartbeats included and on purpose:
        // they are what the asker's watchdog tells a live channel by.
        let frame: unknown;
        try {
          frame = JSON.parse(data);
        } catch {
          return;
        }
        this.answer({ t: 'ws', frame });
      },
    });
    return socket;
  }

  private onAsk(msg: AskMessage): void {
    // the body of PhoneSession.onMessage's switch, minus `case 'hello'`, with
    // `this.socket` for the hub socket (return when it is null), `this.answer`
    // for `this.sendJson`, and `this.reply?.inner(chunk)` for
    // `this.sendInner(encodeInner(chunk))` in onBlobGet and onFileGet
  }
}
```

The comment inside `onAsk` is an instruction for this step, not code to keep: paste the switch from `PhoneSession.onMessage` and apply the three substitutions it names.

- [ ] **Step 5: Implement `deviceChannel.ts`**

```ts
/**
 * A paired device's channel on this server: the shared `Channel` with this
 * server's serving half and its check of a phone's version (spec
 * 2026-10-16-device-group-design § 5, § 9).
 */
import { Channel, type HelloVerdict, type OwnHello } from '@orbital/shared/remote/channel';
import type { Role } from '@orbital/shared/remote/handshake';
import type { Identity } from '@orbital/shared/remote/keys';
import type { HelloMessage } from '@orbital/shared/remote/messages';
import {
  MIN_PHONE_VERSION, PHONE_KNOWS_APP_TOO_OLD, compareVersions, phoneAppVersion,
} from '@orbital/shared/remote/version';
import { ServingHalf, type ServingHalfOptions } from './servingHalf.js';

/** A phone app below this server's minimum: the version its `hello` named, and the minimum. */
export type PhoneTooOld = { version: string; needed: string };

export type DeviceChannelOptions = ServingHalfOptions & {
  identity: Identity;
  peerKey: Uint8Array;
  role: Role;
  hello: OwnHello;
  send(body: Uint8Array): void;
  /** Every phone hello's verdict on its version: the refusal, or null for an app new enough. */
  onAppVersion?: (refusal: PhoneTooOld | null) => void;
  minPhoneVersion?: string;
};

/**
 * Only a phone is held to `MIN_PHONE_VERSION`; a hello naming another kind
 * is a member whose own version is checked by the group (spec § 8). A phone
 * from before `app_too_old` would drop that bye as unreadable, so it gets
 * `protocol`.
 */
export function judgeHello(
  hello: HelloMessage, minPhoneVersion: string = MIN_PHONE_VERSION,
): { verdict: HelloVerdict; refusal: PhoneTooOld | null } {
  if (hello.kind !== undefined && hello.kind !== 'phone') return { verdict: null, refusal: null };
  const version = phoneAppVersion(hello.app ?? '');
  if (version === null || compareVersions(version, minPhoneVersion) >= 0) return { verdict: null, refusal: null };
  const refusal = { version, needed: minPhoneVersion };
  const verdict: HelloVerdict = compareVersions(version, PHONE_KNOWS_APP_TOO_OLD) < 0
    ? { reason: 'protocol' }
    : { reason: 'app_too_old', needed: minPhoneVersion };
  return { verdict, refusal };
}

export function openDeviceChannel(opts: DeviceChannelOptions): Channel {
  return new Channel({
    identity: opts.identity, peerKey: opts.peerKey, role: opts.role, hello: opts.hello, send: opts.send,
    serve: new ServingHalf(opts),
    judge: (hello) => {
      const { verdict, refusal } = judgeHello(hello, opts.minPhoneVersion);
      opts.onAppVersion?.(refusal);
      return verdict;
    },
  });
}
```

- [ ] **Step 6: `RemoteService` on channels (responder side only in this task)**

In `service.ts`:

- `import { openDeviceChannel, type PhoneTooOld } from './deviceChannel.js';`, `import type { Channel } from '@orbital/shared/remote/channel';`, `import { serverDeviceKind, serverHello } from './identity.js';`; remove the `PhoneSession` import; `export type { PhoneTooOld }` stays reachable for `PhoneRefusal`.
- `private readonly sessions = new Map<string, PhoneSession>()` becomes `private readonly channels = new Map<string, Channel>()`; rename every use (`closeSessions` → `closeChannels`).
- `onData`: build the channel with

```ts
      const peerKey = new Uint8Array(frame.peer);
      const client = this.client;
      const channel = openDeviceChannel({
        deviceId: from, identity: this.identity, peerKey, role: 'responder',
        hello: serverHello({ serverVersion: this.opts.serverVersion, name: this.macName, kind: serverDeviceKind() }),
        hub: this.opts.hub, inject: this.opts.inject, images: this.opts.images, imagesDir: this.opts.imagesDir,
        files: this.files,
        notifications: {
          get: () => this.devices.get(from)?.notifications ?? device.notifications,
          set: (s) => this.devices.setNotifications(from, s),
        },
        send: (body) => client.sendData(encodeFrame({ peer: peerKey, flags: 0, wake: ZERO_WAKE, body })),
        onSeen: (sessionId) => this.watchers.get(from)?.seen(sessionId),
        atMac: () => this.opts.presence?.atMac ?? false,
        onAppVersion: (refusal) => this.markPhoneVersion(from, refusal),
      });
      channel.on((event) => {
        if (event.type === 'closed' && this.channels.get(from) === channel) this.channels.delete(from);
        // A peer that serves went quiet: drop the channel; its next handshake opens a new one.
        if (event.type === 'silent') channel.close();
      });
      this.channels.set(from, channel);
```

  and then `channel.receive(frame.body)`.
- `revoke` calls `this.channels.get(id)?.close('revoked')`.

- [ ] **Step 7: Run the server's remote suites**

Run: `npm test -w server -- remote && npm run typecheck -w server`
Expected: PASS, including `remoteClient.test.ts`'s new hello assertion from Task 4 and `remoteEndToEnd.test.ts` unchanged.

- [ ] **Step 8: Commit**

```bash
git rm server/src/remote/phoneSession.ts
git add server/src/remote server/test
git commit -m "Server serves every paired device through a Channel and a ServingHalf"
```

---

### Task 6: A device's kind is stored and shown

**Files:**
- Modify: `server/src/db/schema.ts`, `server/src/remote/devices.ts`, `server/src/remote/service.ts`
- Create: `server/drizzle/0028_device_kind.sql` (+ the snapshot and journal entry `drizzle-kit` writes)
- Test: `server/test/remoteDevices.test.ts`, `server/test/database.test.ts`, `server/test/remoteEndToEnd.test.ts`, `server/test/remoteService.test.ts`

**Interfaces:**
- Produces: `RemoteDevice.kind: string | null`; `RemoteStatus.devices[].kind`; `RemoteStatus.pendingPair.kind: string`; QRs this server makes carry `kind: serverDeviceKind()`.

- [ ] **Step 1: Write the failing tests**

In `server/test/remoteDevices.test.ts`:

```ts
it('stores a kind, and a device added without one reads as null', () => {
  const store = new DeviceStore(openTmpDb());
  store.add({ id: 'p', name: 'Pixel', platform: 'android', kind: 'phone', pairedAt: 1, notifications: DEFAULT_NOTIFICATION_SETTINGS });
  store.add({ id: 'm', name: 'old studio', platform: '', kind: null, pairedAt: 2, notifications: DEFAULT_NOTIFICATION_SETTINGS });
  expect(store.get('p')?.kind).toBe('phone');
  expect(store.get('m')?.kind).toBeNull();
});
```

In `server/test/database.test.ts` (`openDb` takes a migrations folder as its second argument; `cpSync`, `readFileSync`, `rmSync`, `writeFileSync` from `node:fs`):

```ts
it('0028 marks every phone paired before kinds as a phone', () => {
  const dir = makeTmpDir('db-0028');
  const dbPath = join(dir, 'index.db');
  // The migrations as they stood before 0028: copy the folder, drop 0028 and its journal entry.
  const before = join(dir, 'drizzle');
  cpSync(join(import.meta.dirname, '..', 'drizzle'), before, { recursive: true });
  for (const f of ['0028_device_kind.sql', 'meta/0028_snapshot.json']) rmSync(join(before, f));
  const journalPath = join(before, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag !== '0028_device_kind');
  writeFileSync(journalPath, JSON.stringify(journal));

  const old = openDb(dbPath, before);
  old.$client.prepare(
    `INSERT INTO remote_devices (id, name, platform, paired_at, notifications) VALUES ('p', 'Pixel', 'android', 1, '{}')`,
  ).run();
  old.$client.close();

  const now = openDb(dbPath);
  const row = now.$client.prepare(`SELECT kind FROM remote_devices WHERE id = 'p'`).get() as { kind: string | null };
  expect(row.kind).toBe('phone');
  now.$client.close();
});
```

In `server/test/remoteEndToEnd.test.ts`, the `pendingPair` expectation gains `kind: 'phone'` (the fake phone seals none, which reads as a phone):

```ts
expect(status.pendingPair).toEqual({ phone: phone.id, name: 'Pixel', platform: 'android', kind: 'phone', attemptsLeft: 3 });
```

and after the confirm: `expect(devices.find((d) => d.id === phone.id).kind).toBe('phone')`. And:

```ts
expect(JSON.parse(pair.json().qr)).toMatchObject({ kind: 'desktop' });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -w server -- remoteDevices database remoteEndToEnd`
Expected: FAIL.

- [ ] **Step 3: Schema and migration**

In `schema.ts`, `remoteDevices` gains `kind: text('kind'),` after `platform`. Run `npm run db:generate -w server`, rename the generated SQL file to `0028_device_kind.sql` (and its journal `tag`), and append to it:

```sql
--> statement-breakpoint
-- Every device paired before kinds is a phone: a Mac could not pair with
-- another until this release (spec 2026-10-16-device-group-design § 1).
UPDATE `remote_devices` SET `kind` = 'phone';
```

- [ ] **Step 4: Store and service**

`devices.ts`: `RemoteDevice` gains `kind: string | null;` (doc: "`desktop`, `headless` or `phone`; null for a Mac paired through a code that named none."); `add` writes `kind: d.kind` in `values` and `set`; `fromRow` returns `kind: row.kind`.

`service.ts`:
- `RemoteStatus.pendingPair` gains `kind: string`; in `onControl`'s `pair_request` branch, `kind: device?.kind ?? 'phone'`.
- `confirmPairing` passes `kind: pending.kind` to `devices.add`.
- `startPairing` adds `kind: serverDeviceKind()` to the `QrPayload`.
- `watch(id)` returns early unless `this.devices.get(id)?.kind === 'phone'`: only a phone takes wake pushes.
- `start()`'s loop `for (const device of this.devices.list()) this.watch(device.id)` stays; `watch` filters.

- [ ] **Step 5: Run the tests**

Run: `npm test -w server && npm run typecheck -w server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src server/drizzle server/test
git commit -m "Paired devices carry their kind; only a phone takes wake pushes"
```

---

### Task 7: A server joins another device and opens the channel when it should

**Files:**
- Modify: `server/src/remote/service.ts`, `server/src/api/remoteRoutes.ts`, `server/src/index.ts`
- Modify: `server/test/remoteHarness.ts`
- Create: `server/test/deviceChannelEndToEnd.test.ts`
- Test: `server/test/remoteAllowlist.test.ts`

**Interfaces:**
- Consumes: `initiates`, `osName` (Task 1); `parsePairingCode`, `sealPairingDevice`, `pairingProof` (Task 2); `openDeviceChannel` (Task 5); `RemoteDevice.kind` (Task 6).
- Produces: `RemoteService.join(code: string): Promise<JoinResult>` with `type JoinResult = { device: string; name: string; code: string } | { error: 'bad_code' | 'disabled' | 'offline' | 'already_paired' | 'other_relay' | 'peer_offline' | 'relay_error' | 'relay_too_old' }`; `RemoteService.channel(id: string): Channel | null`; `RemoteStatus.joining: { device: string; name: string } | null`; route `POST /api/remote/join` `{ code }` → 200 `{ device, name, code }`, 400 `bad_code`, 409 otherwise; `buildServer` override `exposeRemote?: (remote: RemoteService) => void`; harness `startMacAndRelay(closers, { relayUrl })` reuses a running relay and returns `remote`.

- [ ] **Step 1: Write the failing integration test**

Harness first: in `remoteHarness.ts`, `startMacAndRelay` takes `opts.relayUrl?: string` (when set, no relay is built and that URL is seeded) and `opts.name?: string` (seeded as `remote_mac_name`, default `'studio'`); it passes `exposeRemote: (r) => { remote = r; }` to `buildServer` and returns `remote` in `MacAndRelay`.

```ts
// server/test/deviceChannelEndToEnd.test.ts
import { describe, expect, it, afterEach } from 'vitest';
import { formatFingerprint, publicKeyOf } from '@orbital/shared/remote/keys';
import { pairingCode, startMacAndRelay, until } from './remoteHarness.js';

describe('two servers, one channel', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

  async function joined() {
    const a = await startMacAndRelay(closers, { name: 'studio' });
    const b = await startMacAndRelay(closers, { relayUrl: a.relayUrl, name: 'laptop' });
    const qr = (await a.api('POST', '/api/remote/pair')).json().qr;
    const join = await b.api('POST', '/api/remote/join', { code: qr });
    expect(join.statusCode).toBe(200);
    await until(async () => (await a.api('GET', '/api/remote')).json().pendingPair !== null);
    const statusA = (await a.api('GET', '/api/remote')).json();
    expect(statusA.pendingPair).toMatchObject({ name: 'laptop', kind: 'desktop' });
    const statusB = (await b.api('GET', '/api/remote')).json();
    expect(join.json().code).toBe(formatFingerprint(pairingCode(statusA.macId, publicKeyOf(statusB.macId)!)));
    const confirm = await a.api('POST', '/api/remote/pair/confirm', {
      accept: true, phone: statusB.macId, code: join.json().code,
    });
    expect(confirm.statusCode).toBe(200);
    await until(() => a.remote.channel(statusB.macId)?.ready === true && b.remote.channel(statusA.macId)?.ready === true);
    return { a, b, idA: statusA.macId as string, idB: statusB.macId as string };
  }

  it('pairs a Mac with a Mac and asks in both directions', async () => {
    const { a, b, idA, idB } = await joined();
    const aboutA = await b.remote.channel(idA)!.request('GET', '/api/health');
    const aboutB = await a.remote.channel(idB)!.request('GET', '/api/health');
    expect(aboutA.status).toBe(200);
    expect(aboutB.status).toBe(200);
    expect(a.remote.channel(idB)!.peer).toMatchObject({ kind: 'desktop', name: 'laptop' });
    const devicesB = (await b.api('GET', '/api/remote')).json().devices;
    expect(devicesB).toEqual([expect.objectContaining({ id: idA, name: 'studio', kind: 'desktop' })]);
  });

  it('B restarts: the channel comes back and asks work again', async () => {
    const { a, b, idA, idB } = await joined();
    await b.api('POST', '/api/remote/restart');
    await until(() => a.remote.channel(idB)?.ready === true && b.remote.channel(idA)?.ready === true, 10_000);
    expect((await b.remote.channel(idA)!.request('GET', '/api/health')).status).toBe(200);
    expect((await a.remote.channel(idB)!.request('GET', '/api/health')).status).toBe(200);
  });

  it('a phone still pairs with B after B joined A', async () => {
    const { b } = await joined();
    const pair = await b.api('POST', '/api/remote/pair');
    expect(pair.statusCode).toBe(200);
    // the rest follows remoteEndToEnd's phone pairing with FakePhone, against b
  });

  it('refuses a code from another relay and a code that is not one', async () => {
    const a = await startMacAndRelay(closers);
    const b = await startMacAndRelay(closers);
    const qr = (await a.api('POST', '/api/remote/pair')).json().qr;
    expect((await b.api('POST', '/api/remote/join', { code: qr })).json()).toEqual({ error: 'other_relay' });
    expect((await b.api('POST', '/api/remote/join', { code: 'nonsense' })).statusCode).toBe(400);
  });
});
```

The third test completes the phone pairing exactly as `remoteEndToEnd.test.ts` does (copy those lines with `b` for the server).

In `server/test/remoteAllowlist.test.ts`:

```ts
it('a phone cannot make the Mac join another device', () => {
  expect(isAllowed('POST', '/api/remote/join')).toBe(false);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npm test -w server -- deviceChannelEndToEnd remoteAllowlist`
Expected: FAIL (404 on `/api/remote/join`); the allowlist test passes already and stays as a pin.

- [ ] **Step 3: `RemoteService.join` and the `paired` control**

```ts
export type JoinResult =
  | { device: string; name: string; code: string }
  | { error: 'bad_code' | 'disabled' | 'offline' | 'already_paired' | 'other_relay' | 'peer_offline' | 'relay_error' | 'relay_too_old' };

  /** A device whose code this server redeemed, until it confirms or refuses (`paired`, `rejected`). */
  private joining: { device: string; name: string; kind: string | null; expiresAt: number } | null = null;

  /**
   * Redeems another device's pairing code, as a phone does (spec
   * 2026-10-16-device-group-design § 3): the answer is the code the user
   * types on that device. The pair exists once it confirms (`paired`).
   */
  async join(code: string): Promise<JoinResult> {
    const qr = parsePairingCode(code);
    if (!qr) return { error: 'bad_code' };
    if (this.relayRefusal) return { error: 'relay_too_old' };
    if (!this.enabled || !this.client || !this.identity) return { error: 'disabled' };
    if (this.client.status !== 'online') return { error: 'offline' };
    const self = deviceId(this.identity.publicKey);
    if (qr.mac === self) return { error: 'bad_code' };
    if (this.devices.get(qr.mac)) return { error: 'already_paired' };
    // One relay per group (§ 4), and this server's socket is on its own.
    if (qr.relay.replace(/\/+$/, '') !== this.relayUrl.replace(/\/+$/, '')) return { error: 'other_relay' };
    const secret = fromBase64Url(qr.secret);
    const payload = {
      token: qr.token,
      proof: pairingProof(secret, this.identity.publicKey),
      device: sealPairingDevice(secret, this.identity.publicKey, {
        name: this.macName, platform: osName(process.platform), kind: serverDeviceKind(),
      }),
    };
    this.joining = { device: qr.mac, name: qr.name, kind: qr.kind ?? null, expiresAt: this.now() + PAIRING_TOKEN_TTL_MS };
    this.publishStatus();
    const res = await this.client.post('/pair/redeem', 'pair.redeem', payload);
    if (res.status !== 200) {
      this.joining = null;
      this.publishStatus();
      if (res.relayTooOld) return { error: 'relay_too_old' };
      return { error: res.status === 409 ? 'peer_offline' : res.status === 404 ? 'bad_code' : 'relay_error' };
    }
    return {
      device: qr.mac, name: qr.name,
      code: formatFingerprint(fingerprint(publicKeyOf(qr.mac)!, this.identity.publicKey)),
    };
  }

  /** The channel to a paired device, while one is open. */
  channel(id: string): Channel | null {
    return this.channels.get(id) ?? null;
  }
```

Imports: `fromBase64Url`, `formatFingerprint` from keys; `parsePairingCode`, `pairingProof`, `sealPairingDevice`, `PAIRING_TOKEN_TTL_MS` from relayApi; `initiates`, `osName` from device. `RemoteStatus` gains `joining: { device: string; name: string } | null`, filled from `this.joining` while `expiresAt > now`. `teardown` clears `joining`.

In `onControl`:

```ts
    if (msg.type === 'paired' && this.joining && msg.mac === this.joining.device) {
      const joined = this.joining;
      this.joining = null;
      this.devices.add({
        id: joined.device, name: joined.name, platform: '', kind: joined.kind, pairedAt: this.now(),
        notifications: parseNotificationSettings(this.opts.allSettings()),
      });
      this.publishStatus();
      this.open(joined.device);
      return;
    }
    if (msg.type === 'rejected' && this.joining && msg.mac === this.joining.device) {
      this.joining = null;
      this.publishStatus();
      return;
    }
```

- [ ] **Step 4: Opening as the initiator**

```ts
  /** Opens the channel to `id` when this server is the side that opens it (§ 5) and the peer is online. */
  private open(id: string): void {
    const device = this.devices.get(id);
    if (!device || !this.identity || !this.client || this.client.status !== 'online') return;
    if (!this.client.peersOnline.has(id) || this.channels.has(id)) return;
    const self = { id: deviceId(this.identity.publicKey), kind: serverDeviceKind() };
    if (!initiates(self, { id, kind: device.kind })) return;
    const channel = this.makeChannel(device, 'initiator');
    channel.start();
  }
```

Extract the channel construction from `onData` (Task 5) into `private makeChannel(device: RemoteDevice, role: Role): Channel`, which also registers the `closed`/`silent` listener and `this.channels.set`. For an initiator, `silent` closes the channel and calls `this.open(device.id)` again. `onData` calls `this.makeChannel(device, 'responder')`.

Call `open`:
- in `onControl` on `ok`: `for (const device of this.devices.list()) this.open(device.id);`
- in `onControl` on `presence` with `online: true`, after closing the old channel: `this.open(msg.peer);`
- at the end of a successful `confirmPairing` (accept): `this.open(pending.phone);`

`RelayClient` already emits `control` for `ok`; check that `RemoteService.onControl` receives it (it does: every parsed message reaches listeners).

- [ ] **Step 5: Route and the build hook**

In `remoteRoutes.ts`:

```ts
  // This server joins another device by its code (spec 2026-10-16-device-group-design § 3).
  app.post('/api/remote/join', async (req, reply) => {
    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== 'string') return reply.code(400).send({ error: 'code must be a string' });
    const res = await remote.join(code);
    if ('error' in res) return reply.code(res.error === 'bad_code' ? 400 : 409).send(res);
    return res;
  });
```

In `index.ts`, `buildServer`'s overrides gain `exposeRemote?: (remote: RemoteService) => void` with the doc comment "Tests reach the remote service directly; nothing in the app uses it.", called right after `remote` is constructed.

- [ ] **Step 6: Run everything**

Run: `npm test -w server && npm test -w shared && npm run typecheck -w server && npm run typecheck -w shared && npm run typecheck -w web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src server/test
git commit -m "A server joins another device by its code and opens the channel when it is the opener"
```

---

### Task 8: Documents

**Files:**
- Modify: `docs/superpowers/specs/2026-10-16-device-group-design.md` (status stays `draft` until part 3; add an "As built, part 1" note under § 14)
- Create: `docs/domains/device-channel.md`

- [ ] **Step 1: Domain document**

Write `docs/domains/device-channel.md` (type `domain`, status `active`, related `2026-10-16-device-group-design`, `a-device-has-one-identity-and-one-channel-per-pair`): how a channel opens (who initiates, what a responder does with an unexpected handshake), the hello fields and which ones shipped apps require, the ask-id split, what a serving half receives, and where each piece lives (`shared/src/remote/channel.ts`, `server/src/remote/servingHalf.ts`, `server/src/remote/deviceChannel.ts`, `RemoteService.open`/`join`). Plain sentences, no restated constant values.

- [ ] **Step 2: Spec note**

Under § 14, after item 1, add: "As built (part 1): `POST /api/remote/join` joins another device without UI; the phone allowlist still governs what any member may call until part 3 (§ 6)."

- [ ] **Step 3: Validate and commit**

Run: `bunx @slothworks/atlas validate`
Expected: `all documents valid`.

```bash
git add docs
git commit -m "Device channel: how it works today"
```

---

## Self-review notes

- Spec § 5 (one socket, one channel, both directions, hello, initiator rule, ask ids): Tasks 1, 3, 4, 5, 7. § 9 compatibility: Review Focus 1–2, Tasks 4–5. § 1 kind sealed and stored: Tasks 2, 6. Roster, mutual pairing, removal, allowlist (§ 2–4, § 6) are parts 2–3, not here.
- The phone keeps one Mac in this part; its socket carrying several channels is part 3.
- No user-visible change ships, so no changelog line and no version bump in this part.
