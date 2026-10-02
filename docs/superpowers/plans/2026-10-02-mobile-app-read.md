---
id: 2026-10-02-mobile-app-read
title: Mobile app phase 2a (read) — implementation plan
status: done
type: plan
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - 2026-09-30-mobile-remote-design
  - the-phone-client-lives-in-shared-and-tests-against-the-real-mac
tags:
  - mobile
  - capacitor
  - relay
---
# Mobile app phase 2a (read) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Android app that pairs with one Mac through the relay and reads it: the session list, a session's transcript, the phone's own notification rules, and honest offline, unpaired and version-mismatch states.

**Architecture:** The protocol client (`RemoteClient`) lives in `shared/` with its WebSocket injected, and is tested in Node against the real relay and the real Orbital server. The phone UI is a second Vite entry in `web/` (`web/src/mobile/`) that reuses the store, `lib/` and the transcript panels; three seams in `web/` (`configureApi`, `configureSocket`, `configureImages`) let it route every API call, hub frame and image through the tunnel without the desktop entry noticing. `mobile/` is the Capacitor shell and nothing else, the way `desktop/` is the Electron shell.

**Tech Stack:** TypeScript, `@noble/*` + zod (already in `shared/`), React 19 + zustand + Tailwind 4 + Vite 7 (web), Vitest 3 (jsdom in web, node in shared/server), Capacitor 8 (`@capacitor/core` 8.5, `@capacitor/android` 8.5, `@capacitor/app` 8.1, `@capacitor/preferences` 8.0, `@capacitor/filesystem` 8.1, `@capacitor/device` 8.0, `@capacitor-mlkit/barcode-scanning` 8.2, `@aparajita/capacitor-secure-storage` 8.0), Gradle via Android Studio's bundled JBR.

**Spec:** `docs/superpowers/specs/2026-10-02-mobile-app-design.md` (§§ 1–5, 7, 8 are this plan; § 6 is 2b and is out of scope). Parent: `docs/superpowers/specs/2026-09-30-mobile-remote-design.md` §§ 4, 5, 7. ADR: `docs/decisions/the-phone-client-lives-in-shared-and-tests-against-the-real-mac.md`.

## Global Constraints

- Branch `feat/mobile-read`, worktree `/Users/tomin/Projects/slothworks/orbital/.claude/worktrees/mobile-read`. Every command below runs from that directory unless it says otherwise. Commits use conventional subjects (`feat(mobile): …`, `feat(shared): …`, `test(server): …`, `docs: …`). Stage only the files the task names: other sessions edit the same checkout.
- Orbital-first: terminal sessions are read-only, and in 2a every session is read-only on the phone — no composer, no decisions, no new session (spec § 8).
- Calm: nothing blinks or pulses beyond 9p's slow breathe and pulse (`orbital-breathe`, `orbital-pulse` in `web/src/theme.css`). Offline stops every animation: glyphs keep their colour, dimmed, with no motion (spec § 5, 9a offline). No spinners; Retry is one bounded presence check, not a loop.
- Comments name constants, never restate their values (`RETRY_WINDOW_MS`, not "5 seconds").
- Imports: relative imports in `shared/` and `server/` end in `.js`; `@orbital/shared/...` imports have no suffix; `web/` relative imports have no suffix.
- No `Buffer`, `process`, `require` or `__dirname` in `shared/src/` (eslint enforces it; `shared/` runs in the phone's WebView).
- `shared/` code that `web/` imports must pass `web/`'s compiler options, `erasableSyntaxOnly` included: no constructor parameter properties, no enums, no namespaces.
- Tests only for logic with branches (parsing, state transitions, protocol rules, routes, security boundaries). Nothing asserts rendering, class names, sizes, opacities or motion.
- Czech QWERTZ users: no ⌥+letter shortcuts. The phone has no shortcuts at all.
- Server tests run as `cd server && env ORBITAL_STATIC_DIR= ORBITAL_MIGRATIONS_DIR= npx vitest run <file>`; the whole suite as `env ORBITAL_STATIC_DIR= ORBITAL_MIGRATIONS_DIR= npm test -w server`. (A session started from Orbital carries those variables, and two server tests fail with them set.)
- Web typecheck is `npm run typecheck -w @orbital/web` (it runs `tsc -b --noEmit`); a bare `npx tsc --noEmit` in `web/` checks nothing.
- Root `npm run lint` must report no new errors after every task.
- Docs are English with atlas frontmatter (`docs/CLAUDE.md`); run `bunx @slothworks/atlas validate` (or `atlas validate`) before committing a doc.
- Copy is the spec's wherever the spec quotes it (§ 5). Where it does not (9h, 9i, the scanner's helper lines), this plan's strings are provisional and the main session's fidelity pass replaces them with the canvas's. Pixel values in this plan are starting points for the same pass; do not tune them against anything but the canvas.
- Android build environment on the owner's Mac: SDK at `~/Library/Android/sdk` (not exported as `ANDROID_HOME`), `adb` on `PATH` from Homebrew, one AVD named `Samsung_Galaxy_S24_Ultra`, system `java` is 1.8 and no JDK 17/21 is registered with `/usr/libexec/java_home`, so Gradle uses Android Studio's bundled JBR at `$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home`. `mobile/scripts/android-env.sh` (Task 5) exports both; every `gradlew` and `cap run` step goes through it. Installing anything with Homebrew or `sdkmanager` is never a required step.
- The desktop version bump is not part of this plan: the controller asks the owner after Task 15.

## Review Focus

1. **Coming back from the background.** Android kills a backgrounded socket without a close event. On every foreground the app must rebuild the relay link (`recheck`) rather than trust it, and the list must go live again or show the offline card — never a "live" list that silently stopped updating. Pinned by Task 1's `recheck` test.
2. **A relay that accepts the socket and then says nothing.** A captive portal, a proxy, a relay mid-deploy: the link must give up after `CONNECT_TIMEOUT_MS` and retry with backoff, so the header shows the dim connecting dot instead of hanging. Pinned by Task 1's connect-timeout test.
3. **A transcript page too large for one frame.** The Mac answers 413 instead of the page; the phone must surface it as an ordinary HTTP status (the store's `loadOlder` then returns `null` and stops), not as a network failure that retries forever. Pinned by Task 7's `tunnelFetch` 413 test.
4. **Messy QR text.** A pasted code with surrounding whitespace or line breaks, the desktop's pairing URL instead of the JSON, a code from a relay URL that is not http(s): the first must pair, the rest must say "That isn't an Orbital pairing code." before anything connects. Pinned by Task 9's `parseQrText` tests.
5. **A redeem that cannot succeed.** An expired or already used token (404), a Mac that went offline before the redeem (409), a relay that cannot be reached (status 0): each must land on "Code expired · scan again" or the relay error, never on a confirm screen that waits out `PAIRING_TOKEN_TTL_MS` for nothing. Pinned by Task 9's `redeemOutcome` tests.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `shared/src/remote/client.ts` | 1 | `RemoteClient`: relay link, handshake, tunnel, requests, blobs, hub, pairing |
| `shared/test/client.test.ts` | 1 | the client's protocol rules against a scripted socket |
| `server/test/remoteHarness.ts` | 2 | the real relay + real server harness, extracted |
| `server/test/remoteEndToEnd.test.ts` | 2 | uses the extracted harness |
| `server/test/remoteClient.test.ts` | 2 | the client end to end against the real Mac |
| `web/src/lib/api.ts` | 3 | `configureApi`, `apiFetch` |
| `web/src/lib/socket.ts` | 3 | `configureSocket` |
| `web/src/lib/images.ts` | 3 | `useImageUrl`, `configureImages` |
| `web/src/panels/ImageThumb.tsx`, `web/src/ui/Lightbox.tsx` | 3 | read image URLs through the hook |
| `web/src/panels/TranscriptView.tsx` | 4 | `data-run-breakdown` hook for mobile CSS |
| `web/index.mobile.html`, `web/vite.mobile.config.ts` | 4 | the mobile build |
| `web/src/mobile/main.tsx`, `MobileApp.tsx`, `mobile.css`, `env.d.ts` | 4 | the mobile entry |
| `web/src/mobile/bundleGuard.ts`, `web/src/test/mobilebundle.test.ts` | 4 | three.js stays out |
| `mobile/` (package.json, capacitor.config.ts, tsconfig.json, scripts/android-env.sh, android/) | 5 | the Capacitor shell |
| `docs/ops/build-the-android-app.md` | 5 | runbook |
| `web/src/mobile/platform/*` | 6 | identity, pairing, cache, image cache, device, parsers |
| `web/src/mobile/transport/*` | 7 | `ClientRef`, `tunnelFetch`, `TunnelSocket`, image resolver |
| `web/src/mobile/state.ts`, `version.ts`, `constants.ts`, `connect.ts`, `forget.ts`, `boot.ts` | 8 | app state and wiring |
| `web/src/store/store.ts` | 8, 11 | `seatSessions`, `loadSessions`, `configureTranscriptPages` |
| `relay/src/pairing.ts` | 9 | CORS for `/pair/redeem` |
| `web/src/mobile/pairingFlow.ts`, `pairingRun.ts`, `platform/scanner.ts`, `ui.tsx`, `screens/PairingScreen.tsx` | 9 | 9e |
| `web/src/mobile/sessionList.ts`, `format.ts`, `screens/SessionListScreen.tsx`, `screens/Glyph.tsx` | 10 | 9a |
| `web/src/mobile/screens/SessionScreen.tsx` | 11 | 9b |
| `web/src/mobile/screens/SettingsScreen.tsx` | 12 | 9f |
| `web/src/mobile/screens/UnpairedScreen.tsx`, `MismatchScreen.tsx` | 13 | 9h, 9i |
| `relay/src/ws.ts`, `relay/src/app.ts`, `shared/src/remote/relayApi.ts` (`paired=1`), `web/src/mobile/connect.ts` | 14 | a revoked-while-away phone is told `unpaired` on connect |

---

### Task 1: `RemoteClient` in `shared/`

**Files:**
- Create: `shared/src/remote/client.ts`
- Test: `shared/test/client.test.ts`

**Interfaces:**
- Consumes (existing, verbatim): `keys.ts` — `Identity`, `concat`, `deviceId`, `fromBase64Url`, `publicKeyOf`; `frame.ts` — `ZERO_WAKE`, `decodeFrame`, `encodeFrame`; `handshake.ts` — `HANDSHAKE_BYTES`, `startHandshake`, `Handshake`, `SessionCipher`; `messages.ts` — `MacMessage`, `PROTOCOL_VERSION`, `decodeInner`, `encodeInner`, `NotificationSettings`, `PhoneMessage`; `relayApi.ts` — `PAIRING_TOKEN_TTL_MS`, `RELAY_PING_INTERVAL_MS`, `RelayToDevice`, `DeviceToRelay`, `authSignature`, `pairingProof`, `relayWsUrl`, `signRequest`.
- Produces (import path `@orbital/shared/remote/client`):
  - constants `RECONNECT_DELAY_MS`, `RECONNECT_MAX_MS`, `CONNECT_TIMEOUT_MS`, `TUNNEL_SILENCE_TIMEOUT_MS`, `HANDSHAKE_TIMEOUT_MS`, `REQUEST_TIMEOUT_MS`, `PAIR_NAME_MAX_CHARS`, `PAIR_PLATFORM_MAX_CHARS`
  - `interface SocketLike { binaryType: string; onopen/onmessage/onclose/onerror: ((ev: any) => void) | null; send(data: string | ArrayBuffer): void; close(): void }`, `type SocketConstructor = new (url: string) => SocketLike`
  - `type LinkStatus = 'off' | 'connecting' | 'online'`, `type ByeReason = 'protocol' | 'revoked'`, `type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'`
  - `type RemoteClientEvent = { type: 'status'; status: LinkStatus } | { type: 'presence'; macOnline: boolean } | { type: 'hello'; server: string; macName: string } | { type: 'ready'; ready: boolean } | { type: 'bye'; reason: ByeReason } | { type: 'paired'; macName: string } | { type: 'rejected' } | { type: 'unpaired' } | { type: 'relay_error'; code: string } | { type: 'hub'; frame: unknown } | { type: 'wake'; flags: number }`
  - `type TunnelResponse = { status: number; body: unknown }`, `type BlobResult = { status: number; bytes: Uint8Array; mediaType: string | null }`, `type TunnelFailure = 'offline' | 'timeout' | 'lost' | 'bye'`, `class TunnelError extends Error { readonly reason: TunnelFailure }`
  - `type RemoteClientOptions = { relayUrl: string; mac: string; identity: Identity; WebSocketImpl: SocketConstructor; app: string; now?: () => number; fetchImpl?: (input: string, init: RequestInit) => Promise<Response>; reconnectDelayMs?: number; connectTimeoutMs?: number; silenceTimeoutMs?: number; handshakeTimeoutMs?: number; requestTimeoutMs?: number }`
  - `class RemoteClient` — `status: LinkStatus`, `macOnline: boolean`, `dropped: number`, `get id(): string`, `get ready(): boolean`, `on(listener: (event: RemoteClientEvent) => void): () => void`, `start(): void`, `stop(): void`, `recheck(windowMs: number): Promise<boolean>`, `request(method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse>`, `getBlob(ref: string): Promise<BlobResult>`, `getNotifications(): Promise<NotificationSettings>`, `setNotifications(settings: NotificationSettings): Promise<NotificationSettings>`, `seen(sessionId: string): void`, `pushToken(token: string): void`, `subscribe(topic: string): void`, `unsubscribe(topic: string): void`, `redeem(token: string, secret: string, name: string, platform: string): Promise<{ status: number; body: unknown }>`, `waitForPairing(timeoutMs?: number): Promise<'paired' | 'rejected' | 'timeout'>`

- [ ] **Step 1: Write the failing tests**

Create `shared/test/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceId, generateIdentity, type Identity } from '../src/remote/keys.js';
import { FLAG_STATE, FLAG_WAKE, ZERO_WAKE, decodeFrame, encodeFrame } from '../src/remote/frame.js';
import { HANDSHAKE_BYTES, startHandshake, type SessionCipher } from '../src/remote/handshake.js';
import {
  PROTOCOL_VERSION, chunkBlob, decodeInner, encodeInner, type Inner, type MacMessage, type PhoneMessage,
} from '../src/remote/messages.js';
import { verifyAuthSignature, type RelayToDevice } from '../src/remote/relayApi.js';
import {
  CONNECT_TIMEOUT_MS, RECONNECT_DELAY_MS, RECONNECT_MAX_MS, REQUEST_TIMEOUT_MS, RemoteClient, TunnelError,
  type RemoteClientEvent, type SocketLike,
} from '../src/remote/client.js';

/** A WebSocket the test plays the relay through: it records what the client sends and delivers what the test says. */
class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  binaryType = 'blob';
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  readonly url: string;
  readonly text: any[] = [];
  readonly frames: Uint8Array[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data === 'string') this.text.push(JSON.parse(data));
    else this.frames.push(new Uint8Array(data));
  }

  close(): void {
    this.closed = true;
  }

  control(msg: RelayToDevice): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  binary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.slice().buffer });
  }

  serverClose(): void {
    this.onclose?.({});
  }
}

/** The body of the next frame the phone sent; throws when there is none. */
function takeFrame(sock: FakeSocket): Uint8Array {
  const raw = sock.frames.shift();
  if (!raw) throw new Error('the phone sent no frame');
  return decodeFrame(raw)!.body;
}

/** The Mac's half of the tunnel, built from the same primitives `PhoneSession` uses. */
class FakeMac {
  readonly identity: Identity = generateIdentity();
  readonly id: string = deviceId(this.identity.publicKey);
  cipher: SessionCipher | null = null;

  answer(sock: FakeSocket, phoneKey: Uint8Array): void {
    const body = takeFrame(sock);
    expect(body.length).toBe(HANDSHAKE_BYTES);
    const handshake = startHandshake(this.identity, phoneKey, 'responder');
    this.cipher = handshake.complete(body);
    expect(this.cipher).not.toBeNull();
    sock.binary(this.frame(handshake.message!));
  }

  read(sock: FakeSocket): PhoneMessage {
    const plain = this.cipher!.open(takeFrame(sock));
    const inner = plain ? decodeInner(plain) : null;
    if (inner?.kind !== 'json') throw new Error('expected a JSON message');
    return inner.value as PhoneMessage;
  }

  send(sock: FakeSocket, msg: MacMessage): void {
    this.sendInner(sock, { kind: 'json', value: msg });
  }

  sendInner(sock: FakeSocket, inner: Inner): void {
    sock.binary(this.frame(this.cipher!.seal(encodeInner(inner))));
  }

  frame(body: Uint8Array, flags = 0): Uint8Array {
    return encodeFrame({ peer: this.identity.publicKey, flags, wake: ZERO_WAKE, body });
  }
}

function setup() {
  FakeSocket.all = [];
  const mac = new FakeMac();
  const phone = generateIdentity();
  const client = new RemoteClient({
    relayUrl: 'https://relay.test', mac: mac.id, identity: phone, WebSocketImpl: FakeSocket, app: 'orbital-mobile/test',
  });
  const events: RemoteClientEvent[] = [];
  client.on((e) => events.push(e));
  client.start();
  return { mac, phone, client, events, sock: FakeSocket.all[0] };
}

/** Up to a live tunnel: challenge, `ok` naming the Mac, both handshake halves, both hellos. */
function connect(s: ReturnType<typeof setup>): void {
  s.sock.control({ type: 'challenge', nonce: 'n1' });
  s.sock.control({ type: 'ok', peers: [s.mac.id] });
  s.mac.answer(s.sock, s.phone.publicKey);
  expect(s.mac.read(s.sock)).toMatchObject({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'orbital-mobile/test' });
  s.mac.send(s.sock, { t: 'hello', protocol: PROTOCOL_VERSION, server: '0.17.2', macName: 'studio' });
  expect(s.client.ready).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RemoteClient relay link', () => {
  it('connects anchored to the Mac and answers the challenge with a signature the relay accepts', () => {
    const s = setup();
    expect(s.sock.url).toBe(`wss://relay.test/ws?mac=${s.mac.id}`);
    expect(s.sock.binaryType).toBe('arraybuffer');
    s.sock.control({ type: 'challenge', nonce: 'n1' });
    const auth = s.sock.text[0];
    expect(auth).toMatchObject({ type: 'auth', pub: deviceId(s.phone.publicKey) });
    expect(verifyAuthSignature(s.phone.publicKey, 'n1', auth.sig)).toBe(true);
  });

  it('gives up on a socket that never reaches ok and retries with backoff', () => {
    vi.useFakeTimers();
    const s = setup();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    expect(s.sock.closed).toBe(true);
    expect(s.client.status).toBe('connecting');
    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('reconnects after the relay drops it, and not after stop', () => {
    vi.useFakeTimers();
    const s = setup();
    s.sock.control({ type: 'ok', peers: [] });
    s.sock.serverClose();
    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    expect(FakeSocket.all).toHaveLength(2);
    s.client.stop();
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    expect(FakeSocket.all).toHaveLength(2);
    expect(s.client.status).toBe('off');
  });

  it('recheck opens a fresh link at once and answers whether the Mac is there', async () => {
    const s = setup();
    s.sock.control({ type: 'ok', peers: [] });
    const answer = s.client.recheck(1_000);
    expect(s.sock.closed).toBe(true);
    const fresh = FakeSocket.all[1];
    fresh.control({ type: 'ok', peers: [s.mac.id] });
    await expect(answer).resolves.toBe(true);
  });
});

describe('RemoteClient handshake triggers', () => {
  it('handshakes on ok only when ok lists the Mac', () => {
    const s = setup();
    s.sock.control({ type: 'ok', peers: [] });
    expect(s.sock.frames).toHaveLength(0);
    expect(s.client.macOnline).toBe(false);
    s.sock.control({ type: 'presence', peer: s.mac.id, online: true });
    expect(s.sock.frames).toHaveLength(1);
    expect(decodeFrame(s.sock.frames[0])!.body.length).toBe(HANDSHAKE_BYTES);
  });

  it('handshakes on ok listing the Mac', () => {
    const s = setup();
    s.sock.control({ type: 'ok', peers: [s.mac.id] });
    expect(s.sock.frames).toHaveLength(1);
  });

  it('handshakes once on paired, even when presence follows it', () => {
    const s = setup();
    s.sock.control({ type: 'ok', peers: [] });
    s.sock.control({ type: 'paired', mac: s.mac.id, name: 'studio' });
    s.sock.control({ type: 'presence', peer: s.mac.id, online: true });
    expect(s.sock.frames).toHaveLength(1);
    expect(s.events).toContainEqual({ type: 'paired', macName: 'studio' });
  });

  it('ignores presence of a peer that is not its Mac', () => {
    const s = setup();
    s.sock.control({ type: 'ok', peers: [] });
    s.sock.control({ type: 'presence', peer: deviceId(generateIdentity().publicKey), online: true });
    expect(s.sock.frames).toHaveLength(0);
  });

  it('re-sends hello and every subscription after a re-handshake', () => {
    const s = setup();
    connect(s);
    s.client.subscribe('sessions');
    expect(s.mac.read(s.sock)).toEqual({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    s.sock.control({ type: 'presence', peer: s.mac.id, online: false });
    expect(s.events).toContainEqual({ type: 'ready', ready: false });
    s.sock.control({ type: 'presence', peer: s.mac.id, online: true });
    s.mac.answer(s.sock, s.phone.publicKey);
    expect(s.mac.read(s.sock)).toMatchObject({ t: 'hello' });
    s.mac.send(s.sock, { t: 'hello', protocol: PROTOCOL_VERSION, server: '0.17.2', macName: 'studio' });
    expect(s.mac.read(s.sock)).toEqual({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    expect(s.client.ready).toBe(true);
  });
});

describe('RemoteClient requests', () => {
  it('matches answers by id, whatever their order, and ignores ids it never sent', async () => {
    const s = setup();
    connect(s);
    const first = s.client.request('GET', '/api/sessions');
    const second = s.client.request('POST', '/api/sessions/s1/messages', { text: 'hi' });
    const a = s.mac.read(s.sock) as Extract<PhoneMessage, { t: 'http' }>;
    const b = s.mac.read(s.sock) as Extract<PhoneMessage, { t: 'http' }>;
    expect(a).toMatchObject({ method: 'GET', path: '/api/sessions' });
    expect(a).not.toHaveProperty('body');
    expect(b).toMatchObject({ method: 'POST', body: { text: 'hi' } });
    s.mac.send(s.sock, { t: 'http_res', id: b.id, status: 403, body: { error: 'not_allowed' } });
    s.mac.send(s.sock, { t: 'http_res', id: 9_999, status: 200, body: null });
    s.mac.send(s.sock, { t: 'http_res', id: a.id, status: 200, body: { sessions: [] } });
    await expect(first).resolves.toEqual({ status: 200, body: { sessions: [] } });
    await expect(second).resolves.toEqual({ status: 403, body: { error: 'not_allowed' } });
  });

  it('rejects at once while there is no tunnel', async () => {
    const s = setup();
    await expect(s.client.request('GET', '/api/sessions')).rejects.toMatchObject({ reason: 'offline' });
  });

  it('times out a request nobody answers', async () => {
    vi.useFakeTimers();
    const s = setup();
    connect(s);
    const caught = s.client.request('GET', '/api/sessions').catch((e: unknown) => e);
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    const err = await caught;
    expect(err).toBeInstanceOf(TunnelError);
    expect(err).toMatchObject({ reason: 'timeout' });
  });

  it('rejects requests in flight when the Mac goes away', async () => {
    const s = setup();
    connect(s);
    const pending = s.client.request('GET', '/api/sessions');
    s.sock.control({ type: 'presence', peer: s.mac.id, online: false });
    await expect(pending).rejects.toMatchObject({ reason: 'lost' });
  });
});

describe('RemoteClient blobs, hub and wake', () => {
  const REF = `${'a'.repeat(64)}.png`;

  it('reassembles a blob from chunks interleaved with JSON and hub frames', async () => {
    const s = setup();
    connect(s);
    const blob = s.client.getBlob(REF);
    const page = s.client.request('GET', '/api/sessions');
    const get = s.mac.read(s.sock) as Extract<PhoneMessage, { t: 'blob_get' }>;
    const http = s.mac.read(s.sock) as Extract<PhoneMessage, { t: 'http' }>;
    expect(get).toMatchObject({ t: 'blob_get', ref: REF });
    const bytes = new Uint8Array(150_000).map((_, i) => i % 251);
    const chunks = chunkBlob(get.id, bytes);
    expect(chunks.length).toBeGreaterThan(2);
    s.mac.send(s.sock, { t: 'blob_meta', id: get.id, status: 200, bytes: bytes.length, mediaType: 'image/png' });
    s.mac.sendInner(s.sock, chunks[0]);
    s.mac.send(s.sock, { t: 'http_res', id: http.id, status: 200, body: { sessions: [] } });
    s.mac.send(s.sock, { t: 'ws', frame: { topic: 'sessions', event: 'upsert' } });
    for (const chunk of chunks.slice(1)) s.mac.sendInner(s.sock, chunk);
    const result = await blob;
    expect(result.status).toBe(200);
    expect(result.mediaType).toBe('image/png');
    expect(Array.from(result.bytes)).toEqual(Array.from(bytes));
    await expect(page).resolves.toMatchObject({ status: 200 });
    expect(s.events).toContainEqual({ type: 'hub', frame: { topic: 'sessions', event: 'upsert' } });
  });

  it('answers a missing blob with its status and no bytes', async () => {
    const s = setup();
    connect(s);
    const blob = s.client.getBlob(REF);
    const get = s.mac.read(s.sock) as Extract<PhoneMessage, { t: 'blob_get' }>;
    s.mac.send(s.sock, { t: 'blob_meta', id: get.id, status: 404 });
    await expect(blob).resolves.toEqual({ status: 404, bytes: new Uint8Array(0), mediaType: null });
  });

  it('reports an empty-body frame as a wake with its flags and nothing else', () => {
    const s = setup();
    connect(s);
    s.sock.binary(s.mac.frame(new Uint8Array(0), FLAG_WAKE | FLAG_STATE));
    expect(s.events).toContainEqual({ type: 'wake', flags: FLAG_WAKE | FLAG_STATE });
  });

  it('counts an unreadable frame as dropped and carries on', () => {
    const s = setup();
    connect(s);
    s.sock.binary(new Uint8Array([9, 9, 9]));
    expect(s.client.dropped).toBe(1);
    expect(s.client.ready).toBe(true);
  });
});

describe('RemoteClient endings', () => {
  it('surfaces bye revoked and never reconnects after it', () => {
    vi.useFakeTimers();
    const s = setup();
    connect(s);
    s.mac.send(s.sock, { t: 'bye', reason: 'revoked' });
    expect(s.events).toContainEqual({ type: 'bye', reason: 'revoked' });
    expect(s.client.status).toBe('off');
    vi.advanceTimersByTime(RECONNECT_MAX_MS);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('keeps the link after bye protocol, with the tunnel down', () => {
    const s = setup();
    connect(s);
    s.mac.send(s.sock, { t: 'bye', reason: 'protocol' });
    expect(s.events).toContainEqual({ type: 'bye', reason: 'protocol' });
    expect(s.client.ready).toBe(false);
    expect(s.client.status).toBe('online');
  });

  it('a listener that throws does not break the client', () => {
    const s = setup();
    s.client.on(() => {
      throw new Error('boom');
    });
    connect(s);
    expect(s.client.ready).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared -- test/client.test.ts`
Expected: FAIL — `Failed to resolve import "../src/remote/client.js"`.

- [ ] **Step 3: Write the implementation**

Create `shared/src/remote/client.ts`:

```ts
/**
 * The phone's side of the mobile remote: one relay link, one end-to-end
 * tunnel to one Mac, and every rule the Mac's `PhoneSession` expects of the
 * other end (spec 2026-10-02-mobile-app-design § 2; the parent spec's § 7 is
 * the contract). No DOM and no Node: the WebSocket is injected — the
 * WebView's on the phone, `ws` in the server's end-to-end test (ADR
 * the-phone-client-lives-in-shared-and-tests-against-the-real-mac).
 *
 * Nothing here throws into a caller's event loop: a bad frame is dropped and
 * counted (`dropped`), a listener that throws is its own problem.
 */
import { concat, deviceId, fromBase64Url, publicKeyOf, type Identity } from './keys.js';
import { ZERO_WAKE, decodeFrame, encodeFrame } from './frame.js';
import { HANDSHAKE_BYTES, startHandshake, type Handshake, type SessionCipher } from './handshake.js';
import {
  MacMessage, PROTOCOL_VERSION, decodeInner, encodeInner, type NotificationSettings, type PhoneMessage,
} from './messages.js';
import {
  PAIRING_TOKEN_TTL_MS, RELAY_PING_INTERVAL_MS, RelayToDevice, authSignature, pairingProof, relayWsUrl,
  signRequest, type DeviceToRelay,
} from './relayApi.js';

/** First reconnect delay; it doubles per failed attempt up to `RECONNECT_MAX_MS` — the Mac's `RelayClient` shape. */
export const RECONNECT_DELAY_MS = 3_000;
export const RECONNECT_MAX_MS = 30_000;
/** A socket stuck between open and `ok` is worse than no socket. */
export const CONNECT_TIMEOUT_MS = 15_000;
/**
 * Silence on a live tunnel before the link is dropped and rebuilt. The Mac's
 * hub heartbeat rides the tunnel (the server's `WS_HEARTBEAT_INTERVAL_MS`);
 * the relay's own pings never reach page code — a browser answers them below
 * JavaScript — so this watchdog runs only while a tunnel is up.
 */
export const TUNNEL_SILENCE_TIMEOUT_MS = RELAY_PING_INTERVAL_MS * 3;
/** How long one handshake waits for the Mac's half before a fresh one goes out. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** How long a `request`, a `getBlob` (per chunk) or a notifications call waits for its answer. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** The relay's `RedeemPayload` caps (relay/src/pairing.ts). */
export const PAIR_NAME_MAX_CHARS = 80;
export const PAIR_PLATFORM_MAX_CHARS = 20;

/** What the client needs of a WebSocket: the browser's surface, which `ws` offers too. */
export interface SocketLike {
  binaryType: string;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onclose: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  send(data: string | ArrayBuffer): void;
  close(): void;
}
export type SocketConstructor = new (url: string) => SocketLike;

export type LinkStatus = 'off' | 'connecting' | 'online';
export type ByeReason = 'protocol' | 'revoked';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RemoteClientEvent =
  | { type: 'status'; status: LinkStatus }
  | { type: 'presence'; macOnline: boolean }
  | { type: 'hello'; server: string; macName: string }
  /** True once a cipher exists and the Mac said hello; false when that tunnel is gone. */
  | { type: 'ready'; ready: boolean }
  | { type: 'bye'; reason: ByeReason }
  | { type: 'paired'; macName: string }
  | { type: 'rejected' }
  | { type: 'unpaired' }
  | { type: 'relay_error'; code: string }
  /** A hub frame, verbatim — `dropped` ones included (parent § 7). */
  | { type: 'hub'; frame: unknown }
  /** A frame with an empty body: its header flags, and nothing else (parent § 7). */
  | { type: 'wake'; flags: number };

export type TunnelResponse = { status: number; body: unknown };
export type BlobResult = { status: number; bytes: Uint8Array; mediaType: string | null };
export type TunnelFailure = 'offline' | 'timeout' | 'lost' | 'bye';

export class TunnelError extends Error {
  readonly reason: TunnelFailure;

  constructor(reason: TunnelFailure) {
    super(`tunnel ${reason}`);
    this.name = 'TunnelError';
    this.reason = reason;
  }
}

export type RemoteClientOptions = {
  relayUrl: string;
  /** The Mac's id from the QR. */
  mac: string;
  identity: Identity;
  WebSocketImpl: SocketConstructor;
  /** What `hello` names this app as. */
  app: string;
  now?: () => number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  reconnectDelayMs?: number;
  connectTimeoutMs?: number;
  silenceTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
};

type Timer = ReturnType<typeof setTimeout>;
type Waiter<T> = { resolve: (value: T) => void; reject: (err: Error) => void; timer: Timer };
type BlobWaiter = Waiter<BlobResult> & { mediaType: string | null; parts: Uint8Array[] };

export class RemoteClient {
  status: LinkStatus = 'off';
  macOnline = false;
  /** Frames dropped as unreadable since construction. */
  dropped = 0;
  private ws: SocketLike | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: Timer | null = null;
  private connectTimer: Timer | null = null;
  private silenceTimer: Timer | null = null;
  private handshakeTimer: Timer | null = null;
  private handshake: Handshake | null = null;
  private cipher: SessionCipher | null = null;
  private greeted = false;
  private nextId = 1;
  private token: string | null = null;
  private readonly topics = new Set<string>();
  private readonly requests = new Map<number, Waiter<TunnelResponse>>();
  private readonly blobs = new Map<number, BlobWaiter>();
  private readonly notificationWaiters: Waiter<NotificationSettings>[] = [];
  private readonly listeners = new Set<(event: RemoteClientEvent) => void>();
  private readonly opts: RemoteClientOptions;
  private readonly macKey: Uint8Array;

  constructor(opts: RemoteClientOptions) {
    const macKey = publicKeyOf(opts.mac);
    if (!macKey) throw new Error('mac is not a device id');
    this.opts = opts;
    this.macKey = macKey;
  }

  get id(): string {
    return deviceId(this.opts.identity.publicKey);
  }

  /** A cipher, and the Mac's hello on it: requests and subscriptions go through. */
  get ready(): boolean {
    return this.cipher !== null && this.greeted;
  }

  on(listener: (event: RemoteClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.reconnectTimer = this.clear(this.reconnectTimer);
    this.lose(this.ws, false);
    this.setStatus('off');
  }

  /**
   * One bounded presence check (9a's Retry, 9i's Try again, every return to
   * the foreground): a fresh relay link now, answered with whether the Mac is
   * online once the relay said `ok`, or with what is known when `windowMs`
   * runs out first.
   */
  recheck(windowMs: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        off();
        resolve(this.macOnline);
      };
      const timer = setTimeout(finish, windowMs);
      const off = this.on((event) => {
        if (event.type === 'status' && event.status === 'online') finish();
      });
      this.reconnectTimer = this.clear(this.reconnectTimer);
      this.attempt = 0;
      this.lose(this.ws, false);
      this.connect();
    });
  }

  request(method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    if (!this.ready) return Promise.reject(new TunnelError('offline'));
    const id = this.nextId++;
    return new Promise<TunnelResponse>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(this.requests, id, new TunnelError('timeout')), this.requestTimeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      const msg: PhoneMessage =
        body === undefined ? { t: 'http', id, method, path } : { t: 'http', id, method, path, body };
      if (!this.sendJson(msg)) this.fail(this.requests, id, new TunnelError('lost'));
    });
  }

  getBlob(ref: string): Promise<BlobResult> {
    if (!this.ready) return Promise.reject(new TunnelError('offline'));
    const id = this.nextId++;
    return new Promise<BlobResult>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(this.blobs, id, new TunnelError('timeout')), this.requestTimeoutMs);
      this.blobs.set(id, { resolve, reject, timer, mediaType: null, parts: [] });
      if (!this.sendJson({ t: 'blob_get', id, ref })) this.fail(this.blobs, id, new TunnelError('lost'));
    });
  }

  getNotifications(): Promise<NotificationSettings> {
    return this.askNotifications({ t: 'notifications_get' });
  }

  setNotifications(settings: NotificationSettings): Promise<NotificationSettings> {
    return this.askNotifications({ t: 'notifications_set', settings });
  }

  seen(sessionId: string): void {
    if (this.ready) this.sendJson({ t: 'seen', sessionId });
  }

  /** Kept and sent on every `ok` and again after `paired`: the relay drops a token from a device it has no row for (parent § 7). */
  pushToken(token: string): void {
    this.token = token;
    this.sendPushToken();
  }

  subscribe(topic: string): void {
    if (this.topics.has(topic)) return;
    this.topics.add(topic);
    if (this.ready) this.sendJson({ t: 'ws', type: 'subscribe', topic });
  }

  unsubscribe(topic: string): void {
    if (!this.topics.delete(topic)) return;
    if (this.ready) this.sendJson({ t: 'ws', type: 'unsubscribe', topic });
  }

  /**
   * Posts `/pair/redeem` with the proof that this key scanned the QR. Never
   * rejects: an unreachable relay answers status 0, as the Mac's
   * `RelayClient.post` does. A 200 only means the relay passed it on; call
   * `waitForPairing` first and await it after.
   */
  async redeem(token: string, secret: string, name: string, platform: string): Promise<{ status: number; body: unknown }> {
    const payload = {
      token,
      name: name.slice(0, PAIR_NAME_MAX_CHARS),
      platform: platform.slice(0, PAIR_PLATFORM_MAX_CHARS),
      proof: pairingProof(fromBase64Url(secret), this.opts.identity.publicKey),
    };
    const fetchImpl = this.opts.fetchImpl ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
    const now = this.opts.now ?? Date.now;
    try {
      const res = await fetchImpl(new URL('/pair/redeem', this.opts.relayUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(signRequest(this.opts.identity, 'pair.redeem', payload, now())),
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = { error: text };
      }
      return { status: res.status, body };
    } catch {
      return { status: 0, body: { error: 'network' } };
    }
  }

  /** The Mac's answer to a redeem, bounded by `PAIRING_TOKEN_TTL_MS` (parent § 7: a 200 can still go nowhere). */
  waitForPairing(timeoutMs = PAIRING_TOKEN_TTL_MS): Promise<'paired' | 'rejected' | 'timeout'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve('timeout');
      }, timeoutMs);
      const off = this.on((event) => {
        if (event.type !== 'paired' && event.type !== 'rejected') return;
        clearTimeout(timer);
        off();
        resolve(event.type);
      });
    });
  }

  private get requestTimeoutMs(): number {
    return this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private connect(): void {
    this.setStatus('connecting');
    let ws: SocketLike;
    try {
      ws = new this.opts.WebSocketImpl(relayWsUrl(this.opts.relayUrl, this.opts.mac));
    } catch {
      // A relay URL no socket can open will not open on the next attempt either.
      this.stopped = true;
      this.setStatus('off');
      this.emit({ type: 'relay_error', code: 'bad_url' });
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.connectTimer = setTimeout(() => this.lose(ws), this.opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    ws.onmessage = (ev: { data: unknown }) => {
      if (this.ws !== ws) return;
      if (typeof ev.data === 'string') this.onControl(ws, ev.data);
      else this.onBinary(ev.data);
    };
    ws.onclose = () => this.lose(ws);
    ws.onerror = () => {
      /* `close` follows; that is where the link is rebuilt */
    };
  }

  /** Forgets one socket and everything tied to it; schedules the next attempt unless told not to or stopped. */
  private lose(ws: SocketLike | null, reconnect = true): void {
    if (!ws || this.ws !== ws) return;
    this.ws = null;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* a socket that never opened may refuse to close */
    }
    this.connectTimer = this.clear(this.connectTimer);
    this.dropTunnel('lost');
    this.setMacOnline(false);
    if (!reconnect || this.stopped) return;
    const base = this.opts.reconnectDelayMs ?? RECONNECT_DELAY_MS;
    const delay = Math.min(base * 2 ** this.attempt++, RECONNECT_MAX_MS);
    // Forced: a repeated failure stays `connecting`, and listeners still hear of the attempt.
    this.setStatus('connecting', true);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private onControl(ws: SocketLike, text: string): void {
    let msg: RelayToDevice;
    try {
      msg = RelayToDevice.parse(JSON.parse(text));
    } catch {
      this.dropped++;
      return;
    }
    switch (msg.type) {
      case 'challenge':
        this.sendControl(ws, { type: 'auth', pub: this.id, sig: authSignature(this.opts.identity, msg.nonce) });
        return;
      case 'ok':
        this.connectTimer = this.clear(this.connectTimer);
        this.attempt = 0;
        this.setMacOnline(msg.peers.includes(this.opts.mac));
        this.setStatus('online');
        this.sendPushToken();
        if (this.macOnline) this.beginHandshake();
        return;
      case 'presence':
        if (msg.peer !== this.opts.mac) return;
        this.setMacOnline(msg.online);
        if (msg.online) this.beginHandshake(true);
        else this.dropTunnel('lost');
        return;
      case 'paired':
        if (msg.mac !== this.opts.mac) return;
        this.emit({ type: 'paired', macName: msg.name });
        this.sendPushToken();
        this.setMacOnline(true);
        this.beginHandshake();
        return;
      case 'rejected':
        if (msg.mac === this.opts.mac) this.emit({ type: 'rejected' });
        return;
      case 'unpaired':
        if (msg.mac !== this.opts.mac) return;
        this.emit({ type: 'unpaired' });
        this.stop();
        return;
      case 'error':
        this.emit({ type: 'relay_error', code: msg.code });
        return;
      case 'pair_request':
        return; // the Mac's message; a phone never gets one
    }
  }

  /**
   * Sends the initiator's half (parent § 7: on `paired`, on `ok` listing the
   * Mac, on its `presence` online). One handshake at a time: `paired` is
   * followed by a `presence` for the same Mac, and a second half would use up
   * the first one's reply. A live tunnel when the Mac reappears is stale —
   * the Mac's phone sessions died with its relay link — and is replaced.
   */
  private beginHandshake(macCameBack = false): void {
    if (!this.ws || this.status !== 'online' || this.handshake) return;
    if (this.cipher && !macCameBack) return;
    this.dropTunnel('lost');
    const handshake = startHandshake(this.opts.identity, this.macKey, 'initiator');
    this.handshake = handshake;
    this.sendFrame(handshake.message!);
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      this.handshake = null;
      if (this.macOnline) this.beginHandshake();
    }, this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
  }

  private onBinary(data: unknown): void {
    const bytes = toBytes(data);
    if (!bytes) {
      this.dropped++;
      return;
    }
    if (this.silenceTimer) this.armSilence();
    const frame = decodeFrame(bytes);
    if (!frame || !sameBytes(frame.peer, this.macKey)) {
      this.dropped++;
      return;
    }
    if (frame.body.length === 0) {
      this.emit({ type: 'wake', flags: frame.flags });
      return;
    }
    if (!this.cipher) {
      this.completeHandshake(frame.body);
      return;
    }
    const plain = this.cipher.open(frame.body);
    const inner = plain ? decodeInner(plain) : null;
    if (!inner) {
      this.dropped++;
      return;
    }
    if (inner.kind === 'blob') {
      this.onChunk(inner);
      return;
    }
    const parsed = MacMessage.safeParse(inner.value);
    if (!parsed.success) {
      this.dropped++;
      return;
    }
    this.onMac(parsed.data);
  }

  private completeHandshake(body: Uint8Array): void {
    const handshake = this.handshake;
    if (!handshake || body.length !== HANDSHAKE_BYTES) {
      this.dropped++;
      return;
    }
    this.handshake = null;
    const cipher = handshake.complete(body);
    // A reply that does not verify used the handshake up; the timer that is
    // still armed sends a fresh one.
    if (!cipher) {
      this.dropped++;
      return;
    }
    this.handshakeTimer = this.clear(this.handshakeTimer);
    this.cipher = cipher;
    this.sendJson({ t: 'hello', protocol: PROTOCOL_VERSION, app: this.opts.app });
  }

  private onMac(msg: MacMessage): void {
    switch (msg.t) {
      case 'hello':
        if (this.greeted) return;
        this.greeted = true;
        this.armSilence();
        this.emit({ type: 'hello', server: msg.server, macName: msg.macName });
        // The Mac dropped the previous connection's subscriptions (parent § 7).
        for (const topic of this.topics) this.sendJson({ t: 'ws', type: 'subscribe', topic });
        this.emit({ type: 'ready', ready: true });
        return;
      case 'bye':
        this.dropTunnel('bye');
        this.emit({ type: 'bye', reason: msg.reason });
        if (msg.reason === 'revoked') this.stop();
        return;
      case 'ws':
        this.emit({ type: 'hub', frame: msg.frame });
        return;
      case 'http_res': {
        const waiter = this.requests.get(msg.id);
        if (!waiter) return;
        this.requests.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve({ status: msg.status, body: msg.body });
        return;
      }
      case 'blob_meta': {
        const waiter = this.blobs.get(msg.id);
        if (!waiter) return;
        if (msg.status === 200) {
          waiter.mediaType = msg.mediaType ?? null;
          this.rearmBlob(msg.id, waiter);
          return;
        }
        this.blobs.delete(msg.id);
        clearTimeout(waiter.timer);
        waiter.resolve({ status: msg.status, bytes: new Uint8Array(0), mediaType: null });
        return;
      }
      case 'notifications':
        for (const waiter of this.notificationWaiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.resolve(msg.settings);
        }
        return;
      case 'blob_put_done':
        return; // 2b's `putBlob` reads these
    }
  }

  private onChunk(chunk: { id: number; last: boolean; bytes: Uint8Array }): void {
    const waiter = this.blobs.get(chunk.id);
    if (!waiter) {
      this.dropped++;
      return;
    }
    waiter.parts.push(chunk.bytes);
    if (!chunk.last) {
      this.rearmBlob(chunk.id, waiter);
      return;
    }
    this.blobs.delete(chunk.id);
    clearTimeout(waiter.timer);
    waiter.resolve({ status: 200, bytes: concat(...waiter.parts), mediaType: waiter.mediaType });
  }

  /** A large image is many chunks: its timeout counts from the last one, not from the ask. */
  private rearmBlob(id: number, waiter: BlobWaiter): void {
    clearTimeout(waiter.timer);
    waiter.timer = setTimeout(() => this.fail(this.blobs, id, new TunnelError('timeout')), this.requestTimeoutMs);
  }

  private askNotifications(msg: PhoneMessage): Promise<NotificationSettings> {
    if (!this.ready) return Promise.reject(new TunnelError('offline'));
    return new Promise<NotificationSettings>((resolve, reject) => {
      const waiter: Waiter<NotificationSettings> = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const at = this.notificationWaiters.indexOf(waiter);
          if (at >= 0) this.notificationWaiters.splice(at, 1);
          reject(new TunnelError('timeout'));
        }, this.requestTimeoutMs),
      };
      this.notificationWaiters.push(waiter);
      if (this.sendJson(msg)) return;
      this.notificationWaiters.splice(this.notificationWaiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      reject(new TunnelError('lost'));
    });
  }

  private fail<T>(map: Map<number, Waiter<T>>, id: number, err: TunnelError): void {
    const waiter = map.get(id);
    if (!waiter) return;
    map.delete(id);
    clearTimeout(waiter.timer);
    waiter.reject(err);
  }

  /** Ends the current tunnel (not the relay link): everything waiting on it fails with `why`. */
  private dropTunnel(why: 'lost' | 'bye'): void {
    const wasReady = this.ready;
    this.cipher = null;
    this.greeted = false;
    this.handshake = null;
    this.handshakeTimer = this.clear(this.handshakeTimer);
    this.silenceTimer = this.clear(this.silenceTimer);
    const err = new TunnelError(why);
    for (const id of [...this.requests.keys()]) this.fail(this.requests, id, err);
    for (const id of [...this.blobs.keys()]) this.fail(this.blobs, id, err);
    for (const waiter of this.notificationWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    if (wasReady) this.emit({ type: 'ready', ready: false });
  }

  private armSilence(): void {
    this.silenceTimer = this.clear(this.silenceTimer);
    const ws = this.ws;
    this.silenceTimer = setTimeout(() => this.lose(ws), this.opts.silenceTimeoutMs ?? TUNNEL_SILENCE_TIMEOUT_MS);
  }

  private sendJson(msg: PhoneMessage): boolean {
    if (!this.cipher) return false;
    try {
      this.sendFrame(this.cipher.seal(encodeInner({ kind: 'json', value: msg })));
      return true;
    } catch {
      return false;
    }
  }

  private sendFrame(body: Uint8Array): void {
    // A copy typed as an `ArrayBuffer`, which both the browser and `ws` send as one binary frame.
    const frame = encodeFrame({ peer: this.macKey, flags: 0, wake: ZERO_WAKE, body }).slice().buffer;
    try {
      this.ws?.send(frame);
    } catch {
      /* a closing socket; its `close` rebuilds the link */
    }
  }

  private sendControl(ws: SocketLike, msg: DeviceToRelay): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* as in `sendFrame` */
    }
  }

  private sendPushToken(): void {
    if (this.token && this.ws && this.status === 'online') this.sendControl(this.ws, { type: 'push_token', token: this.token });
  }

  private emit(event: RemoteClientEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a listener's bug is its own; the protocol carries on */
      }
    }
  }

  private setStatus(status: LinkStatus, force = false): void {
    if (this.status === status && !force) return;
    this.status = status;
    this.emit({ type: 'status', status });
  }

  private setMacOnline(online: boolean): void {
    if (this.macOnline === online) return;
    this.macOnline = online;
    this.emit({ type: 'presence', macOnline: online });
  }

  private clear(timer: Timer | null): null {
    if (timer) clearTimeout(timer);
    return null;
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') return new Uint8Array(data as ArrayBuffer);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w shared -- test/client.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Typecheck, lint, and the whole shared suite**

Run: `npm run typecheck -w shared && npm test -w shared && npx eslint shared/`
Expected: no type errors, every shared test passes, no lint errors.

- [ ] **Step 6: Commit**

```bash
git add shared/src/remote/client.ts shared/test/client.test.ts
git commit -m "feat(shared): RemoteClient, the phone's side of the remote protocol"
```

---

### Task 2: The client end to end against the real relay and the real Mac

**Files:**
- Create: `server/test/remoteHarness.ts`
- Modify: `server/test/remoteEndToEnd.test.ts` (setup lines 1–51 move into the harness)
- Create: `server/test/remoteClient.test.ts`
- Fix, if the test finds a bug: `shared/src/remote/client.ts`, with the case added to `shared/test/client.test.ts` first

**Interfaces:**
- Consumes: Task 1's `RemoteClient`, `RemoteClientEvent`; existing `buildRelay` (`@orbital/relay/app`), `openRelayStore` (`@orbital/relay/store`), `buildServer` (`server/src/index.ts`), `openDb`, `settings` table, `createImageStore` (`server/src/images/store.ts`), `RETENTION_KEY`, `RETENTION_NEVER` (`server/src/retention.ts`), fixture `server/test/fixtures/transcript-basic.jsonl`.
- Produces (`server/test/remoteHarness.ts`): `listen(app: FastifyInstance): Promise<string>`, `until(cond: () => Promise<boolean> | boolean, ms?: number): Promise<void>`, `type InjectMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'`, `type MacAndRelay = { relayUrl: string; app: FastifyInstance; dir: string; api: (method: InjectMethod, url: string, payload?: unknown) => Promise<{ statusCode: number; json(): any }> }`, `startMacAndRelay(closers: (() => unknown)[], opts?: { settings?: [string, string][]; beforeBoot?: (dir: string) => void }): Promise<MacAndRelay>`.

- [ ] **Step 1: Extract the harness**

Create `server/test/remoteHarness.ts`:

```ts
/**
 * A real relay and a real Orbital server with the remote switched on and
 * pointed at it — the harness every end-to-end remote test shares. The phone
 * side is the caller's: `FakePhone` where a test needs a phone that
 * misbehaves, `RemoteClient` for everything a real phone does.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildRelay } from '@orbital/relay/app';
import { openRelayStore } from '@orbital/relay/store';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { settings as settingsTable } from '../src/db/schema.js';

export async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

export async function until(cond: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

export type InjectMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type MacAndRelay = {
  relayUrl: string;
  app: FastifyInstance;
  /** The server's data dir: `index.db`, the identity, `images/`, and `claude/` as its `~/.claude`. */
  dir: string;
  api: (method: InjectMethod, url: string, payload?: unknown) => Promise<{ statusCode: number; json(): any }>;
};

/**
 * Online before it resolves. `settings` and `beforeBoot` run before
 * `buildServer`, which is when the remote reads its settings and the indexer
 * first scans `claude/projects`.
 */
export async function startMacAndRelay(
  closers: (() => unknown)[],
  opts: { settings?: [string, string][]; beforeBoot?: (dir: string) => void } = {},
): Promise<MacAndRelay> {
  const relay = await buildRelay({ store: await openRelayStore(':memory:') });
  const relayUrl = await listen(relay);
  closers.push(() => relay.close());

  const dir = mkdtempSync(join(tmpdir(), 'orbital-e2e-'));
  const dbPath = join(dir, 'index.db');
  const db = openDb(dbPath);
  const seeded: [string, string][] = [
    ['remote_enabled', 'true'], ['remote_relay_url', relayUrl], ['remote_mac_name', 'studio'], ...(opts.settings ?? []),
  ];
  for (const [key, value] of seeded) {
    db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value } }).run();
  }
  // Seeded before boot so the remote starts enabled; the server opens its own handle.
  db.$client.close();
  opts.beforeBoot?.(dir);
  const app = await buildServer({ dbPath, claudeDir: join(dir, 'claude'), dataDir: dir });
  closers.push(() => app.close());
  const api: MacAndRelay['api'] = (method, url, payload) => app.inject({ method, url, payload: payload as any });

  await until(async () => (await api('GET', '/api/remote')).json().relay === 'online');
  return { relayUrl, app, dir, api };
}
```

In `server/test/remoteEndToEnd.test.ts`, replace the imports and the setup with the harness. The file's head becomes:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { fingerprint, publicKeyOf } from '@orbital/shared/remote/keys';
import { chunkBlob } from '@orbital/shared/remote/messages';
import { FakePhone } from './remoteFakePhone.js';
import { startMacAndRelay, until } from './remoteHarness.js';

describe('mobile remote, end to end', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

  it('pairs, tunnels the api and hub, moves an image both ways, and revokes', async () => {
    const { relayUrl, app, api } = await startMacAndRelay(closers);

    // Pair: QR on the Mac, redeem from the phone, fingerprint matches, confirm on the Mac.
```

Everything from `const pair = await api('POST', '/api/remote/pair');` to the end of the file stays as it is. Delete the old `listen` and `until` functions, the relay/db/`buildServer` setup block, the local `api` arrow, and the first `await until(... relay === 'online')` (the harness does it).

- [ ] **Step 2: Run the existing end-to-end test to verify the extraction**

Run: `cd server && env ORBITAL_STATIC_DIR= ORBITAL_MIGRATIONS_DIR= npx vitest run test/remoteEndToEnd.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 3: Write the client's end-to-end test**

Create `server/test/remoteClient.test.ts`:

```ts
/**
 * `RemoteClient` — the code the phone ships — against the real relay and the
 * real Mac (ADR the-phone-client-lives-in-shared-and-tests-against-the-real-mac).
 * A change in `server/src/remote/` that breaks a phone breaks this test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { generateIdentity } from '@orbital/shared/remote/keys';
import { QrPayload } from '@orbital/shared/remote/relayApi';
import { RemoteClient, type RemoteClientEvent } from '@orbital/shared/remote/client';
import { createImageStore } from '../src/images/store.js';
import { RETENTION_KEY, RETENTION_NEVER } from '../src/retention.js';
import { startMacAndRelay, until } from './remoteHarness.js';

const SESSION_ID = 's-e2e';

function nextEvent<T extends RemoteClientEvent['type']>(
  client: RemoteClient, type: T, ms = 5000,
): Promise<Extract<RemoteClientEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no ${type} event`));
    }, ms);
    const off = client.on((event) => {
      if (event.type !== type) return;
      clearTimeout(timer);
      off();
      resolve(event as Extract<RemoteClientEvent, { type: T }>);
    });
  });
}

function nextHub(client: RemoteClient, match: (frame: any) => boolean, ms = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('no matching hub frame'));
    }, ms);
    const off = client.on((event) => {
      if (event.type !== 'hub' || !match(event.frame)) return;
      clearTimeout(timer);
      off();
      resolve(event.frame);
    });
  });
}

describe('the phone client against a real relay and a real Mac', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

  it('pairs, reads, survives the Mac leaving the relay, and stops when revoked', async () => {
    const { dir, api } = await startMacAndRelay(closers, {
      // The fixture's timestamps are old; a retention sweep must not take the session.
      settings: [[RETENTION_KEY, RETENTION_NEVER]],
      beforeBoot: (d) => {
        mkdirSync(join(d, 'claude', 'projects', 'p'), { recursive: true });
        copyFileSync(
          join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'),
          join(d, 'claude', 'projects', 'p', `${SESSION_ID}.jsonl`),
        );
      },
    });
    await until(async () => (await api('GET', '/api/sessions')).json().sessions.some((s: any) => s.id === SESSION_ID));

    // Pair: the QR the Mac shows, a relay link, a redeem, the Mac's confirm.
    const qr = QrPayload.parse(JSON.parse((await api('POST', '/api/remote/pair')).json().qr));
    const client = new RemoteClient({
      relayUrl: qr.relay, mac: qr.mac, identity: generateIdentity(), WebSocketImpl: WebSocket, app: 'orbital-mobile/test',
    });
    closers.push(() => client.stop());
    client.start();
    await until(() => client.status === 'online');
    const outcome = client.waitForPairing();
    const redeemed = await client.redeem(qr.token, qr.secret, 'Pixel 8', 'android');
    expect(redeemed).toMatchObject({ status: 200, body: { name: 'studio' } });
    await until(async () => (await api('GET', '/api/remote')).json().pendingPair !== null);
    const hello = nextEvent(client, 'hello');
    // The relay says `paired` before it answers the Mac's confirm, so the confirm is not awaited first.
    const confirm = api('POST', '/api/remote/pair/confirm', { accept: true, phone: client.id });
    expect(await outcome).toBe('paired');
    expect(await hello).toMatchObject({ macName: 'studio' });
    expect((await confirm).statusCode).toBe(200);
    expect(client.ready).toBe(true);

    // Hub and REST: subscribed, a page read, then a change on the Mac reaches the phone.
    client.subscribe('sessions');
    client.subscribe('errors');
    const query = new URLSearchParams({ limit: '30' });
    // Handled in order on the Mac: this answer also means both subscriptions are in.
    const page = await client.request('GET', `/api/sessions/${SESSION_ID}/messages?${query.toString()}`);
    expect(page.status).toBe(200);
    expect((page.body as { messages: unknown[] }).messages.length).toBeGreaterThan(0);
    const upsert = nextHub(client, (f) => f?.topic === 'sessions' && f?.session?.id === SESSION_ID);
    expect((await client.request('PUT', `/api/sessions/${SESSION_ID}/pinned`, { pinned: true })).status).toBe(200);
    expect(await upsert).toMatchObject({ topic: 'sessions', event: 'upsert' });

    // A route the allowlist does not name.
    expect((await client.request('GET', '/api/settings')).status).toBe(403);

    // An image the Mac's store holds, fetched as a blob.
    const png = new Uint8Array(70_000).fill(7);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const entry = createImageStore(join(dir, 'images')).putBytes('image/png', Buffer.from(png));
    expect(entry).not.toBeNull();
    const blob = await client.getBlob(entry!.ref);
    expect(blob).toMatchObject({ status: 200, mediaType: 'image/png' });
    expect(Buffer.from(blob.bytes).equals(Buffer.from(png))).toBe(true);

    // The phone's own notification rules, stored on the Mac.
    const rules = await client.getNotifications();
    const changed = await client.setNotifications({ ...rules, sessionEnded: false });
    expect(changed.sessionEnded).toBe(false);
    const device = (await api('GET', '/api/remote')).json().devices.find((d: any) => d.id === client.id);
    expect(device.notifications.sessionEnded).toBe(false);

    // The Mac leaves the relay and comes back: a fresh handshake, a fresh hello, the subscriptions again.
    const gone = nextEvent(client, 'ready');
    const back = nextEvent(client, 'hello', 15_000);
    expect((await api('POST', '/api/remote/restart')).statusCode).toBe(200);
    expect(await gone).toEqual({ type: 'ready', ready: false });
    await back;
    const again = nextHub(client, (f) => f?.topic === 'sessions' && f?.session?.id === SESSION_ID);
    expect((await client.request('PUT', `/api/sessions/${SESSION_ID}/pinned`, { pinned: false })).status).toBe(200);
    expect(await again).toMatchObject({ event: 'upsert' });

    // Revoked on the Mac: `bye revoked`, and the client stops for good.
    const bye = nextEvent(client, 'bye');
    expect((await api('DELETE', `/api/remote/devices/${client.id}`)).statusCode).toBe(200);
    expect(await bye).toEqual({ type: 'bye', reason: 'revoked' });
    expect(client.status).toBe('off');
  }, 40_000);
});
```

- [ ] **Step 4: Run it**

Run: `cd server && env ORBITAL_STATIC_DIR= ORBITAL_MIGRATIONS_DIR= npx vitest run test/remoteClient.test.ts`
Expected: PASS. Task 1 already passes on the same protocol rules, so the test may pass the first time; it was written before any server-facing fix, which is the order that matters.

If it fails, read which assertion. A failure inside `client.ts` (a handshake that never completes, a subscription the Mac never sees, a blob that never ends) is a client bug: add the exact sequence to `shared/test/client.test.ts` as a failing test, watch it fail with `npm test -w shared -- test/client.test.ts`, fix `shared/src/remote/client.ts`, and re-run both files. A failure in the harness (the session never indexed, the remote never online) is a test bug: fix the test. Do not change `server/src/` or `relay/src/` in this task.

- [ ] **Step 5: Run the whole server suite and typecheck**

Run: `env ORBITAL_STATIC_DIR= ORBITAL_MIGRATIONS_DIR= npm test -w server && npm run typecheck -w server && npx eslint server/test/remoteHarness.ts server/test/remoteClient.test.ts server/test/remoteEndToEnd.test.ts`
Expected: all pass, no type or lint errors.

- [ ] **Step 6: Commit**

```bash
git add server/test/remoteHarness.ts server/test/remoteEndToEnd.test.ts server/test/remoteClient.test.ts
git commit -m "test(server): RemoteClient end to end against the real relay and Mac"
```

If Step 4 led to a client fix, add `shared/src/remote/client.ts shared/test/client.test.ts` to the same commit and use the subject `fix(shared): <what the end-to-end test found>`, followed by a second commit for the test files.

---

### Task 3: Three seams in `web/` — API transport, socket, images

**Files:**
- Modify: `web/src/lib/api.ts` (lines ~84–90 `request()`, and the `fetch(` calls at ~254, ~539, ~583, ~602, ~944)
- Modify: `web/src/lib/socket.ts`
- Create: `web/src/lib/images.ts`
- Modify: `web/src/panels/ImageThumb.tsx`, `web/src/ui/Lightbox.tsx`
- Test: `web/src/test/seams.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `web/src/lib/api.ts`: `type FetchLike = (input: string, init?: RequestInit) => Promise<Response>`, `const defaultApiFetch: FetchLike`, `configureApi(opts: { fetch: FetchLike }): void`
  - `web/src/lib/socket.ts`: `type SocketImpl = NonNullable<OrbitalSocketOptions['WebSocketImpl']>`, `configureSocket(opts: { WebSocketImpl: SocketImpl }): void` (throws once a socket exists)
  - `web/src/lib/images.ts`: `type ImageResolver = (ref: string) => string | Promise<string>`, `apiImagePath(ref: string): string`, `configureImages(opts: { resolve: ImageResolver }): void`, `resolveImage(ref: string): string | Promise<string>`, `interface ImageUrl { url: string | null; failed: boolean; async: boolean; retry: () => void }`, `useImageUrl(ref: string): ImageUrl`

- [ ] **Step 1: Write the failing tests**

Create `web/src/test/seams.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { api, configureApi, defaultApiFetch } from '../lib/api'
import { apiImagePath, configureImages, resolveImage, useImageUrl } from '../lib/images'

afterEach(() => {
  configureApi({ fetch: defaultApiFetch })
  configureImages({ resolve: apiImagePath })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('configureApi', () => {
  it('routes request() through the configured fetch', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json({ session: { id: 's1' } }))
    configureApi({ fetch })
    await expect(api.getSession('s1')).resolves.toEqual({ session: { id: 's1' } })
    expect(fetch).toHaveBeenCalledWith('/api/sessions/s1', expect.objectContaining({ method: 'GET' }))
  })

  it('routes the calls that bypass request() too', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => json({ content: 'x', size: 1, mtimeMs: 0, lines: 1 }))
    configureApi({ fetch })
    await api.filePreview('s1', '/a b')
    expect(fetch.mock.calls[0][0]).toBe('/api/files?session=s1&path=%2Fa+b')
  })
})

describe('images', () => {
  it('resolves a ref to the API path by default, synchronously', () => {
    expect(resolveImage('abc.png')).toBe('/api/images/abc.png')
    const { result } = renderHook(() => useImageUrl('abc.png'))
    expect(result.current).toMatchObject({ url: '/api/images/abc.png', failed: false, async: false })
  })

  it('waits for an async resolver, fails without throwing, and retries', async () => {
    const resolve = vi
      .fn<(ref: string) => string | Promise<string>>()
      .mockImplementationOnce(() => Promise.reject(new Error('gone')))
      .mockImplementationOnce(() => Promise.resolve('blob:x'))
    configureImages({ resolve })
    const { result } = renderHook(() => useImageUrl('abc.png'))
    expect(result.current.url).toBeNull()
    await waitFor(() => expect(result.current.failed).toBe(true))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.url).toBe('blob:x'))
    expect(result.current.async).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:run -w @orbital/web -- src/test/seams.test.ts`
Expected: FAIL — `configureApi` is not exported from `../lib/api`, and `../lib/images` does not exist.

- [ ] **Step 3: Implement the API seam**

In `web/src/lib/api.ts`, directly above `async function request<T>(`, add:

```ts
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The browser's own `fetch`, read at call time so a test's stubbed global still applies. */
export const defaultApiFetch: FetchLike = (input, init) => fetch(input, init)

let fetchImpl: FetchLike = defaultApiFetch

/**
 * Replaces the transport every call in this file goes through. The phone
 * passes `tunnelFetch`, which carries `/api/...` over the relay (spec
 * 2026-10-02-mobile-app-design § 3); the desktop never calls this. Call it
 * before the first request.
 */
export function configureApi(opts: { fetch: FetchLike }): void {
  fetchImpl = opts.fetch
}

function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetchImpl(input, init)
}
```

Then replace each of the six `fetch(` calls in the file with `apiFetch(`, arguments unchanged:

- in `request()`: `const response = await apiFetch(url, options)`
- in `uploadAttachment`: `const response = await apiFetch(url, { method: 'POST', body, signal: opts?.signal })`
- in `filePreview`: `const response = await apiFetch(requestUrl, { method: 'GET' })`
- in `ideOpenFile`: `const response = await apiFetch(` followed by the same template-literal URL and options object as before
- in `ideDiagnostics`: `const response = await apiFetch(url.pathname + url.search)`
- in `remoteCall`: `const response = await apiFetch(url, init)`

Verify none is left: `grep -n "await fetch(" web/src/lib/api.ts` prints nothing.

- [ ] **Step 4: Implement the socket seam**

Replace the whole of `web/src/lib/socket.ts` with:

```ts
import { OrbitalSocket, resolveWsUrl, type OrbitalSocketOptions } from './ws'

export type SocketImpl = NonNullable<OrbitalSocketOptions['WebSocketImpl']>

let instance: OrbitalSocket | null = null
let socketImpl: SocketImpl | null = null

/**
 * The WebSocket the app's one connection is built on. The phone passes a
 * factory for `TunnelSocket`, which speaks the hub over the relay (spec
 * 2026-10-02-mobile-app-design § 3); the desktop never calls this. It has
 * to run before the first `getSocket()`: a connection already open would
 * keep the old transport for the page's lifetime.
 */
export function configureSocket(opts: { WebSocketImpl: SocketImpl }): void {
  if (instance) throw new Error('configureSocket must run before the first getSocket()')
  socketImpl = opts.WebSocketImpl
}

/**
 * The app's single WebSocket connection.
 *
 * It lives here rather than in `App.tsx` because the store needs it too:
 * launching a session has to subscribe to `session:<id>` *before* it sends
 * `POST /api/sessions`, and that subscribe cannot wait for an effect to run
 * (see `docs/fixes/first-turn-can-outrun-the-ws-subscription.md`). Two
 * modules needing one connection means the connection belongs to neither.
 *
 * Constructed on first use, not at import. Every test file that touches the
 * store imports it transitively, and a socket built at import time would have
 * each of them open a real WebSocket against jsdom. `App.tsx` calls this at
 * module scope, which keeps the one property that matters there: created once
 * per page load, so React 18 `StrictMode`'s dev-only mount→cleanup→mount
 * cannot open a second connection.
 */
export function getSocket(): OrbitalSocket {
  if (!instance) {
    instance = new OrbitalSocket(
      resolveWsUrl('/ws', window.location),
      socketImpl ? { WebSocketImpl: socketImpl } : undefined,
    )
  }
  return instance
}
```

- [ ] **Step 5: Implement the image seam**

Create `web/src/lib/images.ts`:

```ts
import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Where a transcript image's bytes come from (spec 2026-10-02-mobile-app-design
 * § 3). The web answers with the API path, synchronously; the phone answers
 * with a blob URL from its file cache, fetched over the tunnel when missing,
 * and memoizes per ref so asking twice never fetches twice.
 */
export type ImageResolver = (ref: string) => string | Promise<string>

export const apiImagePath = (ref: string): string => `/api/images/${ref}`

let resolver: ImageResolver = apiImagePath

export function configureImages(opts: { resolve: ImageResolver }): void {
  resolver = opts.resolve
}

export function resolveImage(ref: string): string | Promise<string> {
  return resolver(ref)
}

export interface ImageUrl {
  /** Null while an async resolver is still out, and after it failed. */
  url: string | null
  failed: boolean
  /** The URL came through a promise — worth fading in, where a synchronous one is already there. */
  async: boolean
  retry: () => void
}

type Settled = { key: string; url: string | null; failed: boolean }

export function useImageUrl(ref: string): ImageUrl {
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<Settled>({ key: '', url: null, failed: false })
  const key = `${ref}#${attempt}`
  // Read during render so a synchronous answer (the web's path, a phone's
  // cached blob URL) is on the first paint and nothing flickers.
  const answer = useMemo(() => {
    const result = resolveImage(ref)
    if (typeof result === 'string') return { url: result, pending: null }
    // Handled here at once; the effect below reads the same promise.
    void result.catch(() => undefined)
    return { url: null, pending: result }
    // `attempt` is the retry: a new attempt asks the resolver again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, attempt])

  useEffect(() => {
    if (!answer.pending) return
    let live = true
    void answer.pending.then(
      (url) => {
        if (live) setSettled({ key, url, failed: false })
      },
      () => {
        if (live) setSettled({ key, url: null, failed: true })
      },
    )
    return () => {
      live = false
    }
  }, [answer, key])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  if (answer.url !== null) return { url: answer.url, failed: false, async: false, retry }
  const mine = settled.key === key
  return { url: mine ? settled.url : null, failed: mine && settled.failed, async: true, retry }
}
```

- [ ] **Step 6: Read image URLs through the hook**

In `web/src/panels/ImageThumb.tsx`:

1. Add the import `import { useImageUrl } from '../lib/images'`.
2. In `ImageThumb`, after `const [open, setOpen] = useState(false)`, add:

```tsx
  const { url, failed, async: fadeIn, retry } = useImageUrl(image.ref)
  const [loaded, setLoaded] = useState(false)
```

3. After the `if (missing) { … }` block, add:

```tsx
  // The bytes did not arrive over the tunnel (9p): the box stays, and a tap asks again.
  if (failed) {
    return (
      <button
        type="button"
        onClick={retry}
        style={box}
        className="flex flex-col items-center justify-center gap-1.5 rounded-[6px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.6)]"
      >
        <span aria-hidden className="h-3.5 w-3.5 rounded-[3px] border border-[rgba(160,190,225,.35)]" />
        <span className="font-mono text-[9px] tracking-[0.1em] text-[rgba(160,190,225,.5)]">
          COULDN&apos;T LOAD · RETRY
        </span>
      </button>
    )
  }
```

4. Replace the `<img … />` element inside the button with:

```tsx
        {url && (
          <img
            src={url}
            alt=""
            loading="lazy"
            onError={() => setMissing(true)}
            onLoad={() => setLoaded(true)}
            // The reserved box already carries the aspect ratio; unknown dims
            // fall back to the height cap and let the image size itself.
            className="block h-full w-full"
            style={{
              ...(image.w && image.h ? {} : { width: 'auto', maxHeight: '100%' }),
              // Only bytes that arrived later fade in; a URL known at first paint just shows.
              ...(fadeIn ? { opacity: loaded ? 1 : 0, transition: 'opacity 160ms ease-out' } : {}),
            }}
          />
        )}
```

In `web/src/ui/Lightbox.tsx`:

1. Add `import { useImageUrl } from '../lib/images'`.
2. In `Lightbox`, as its first line (before `useEscapeLayer`), add `const { url } = useImageUrl(image.ref)`.
3. On the `<img` element, replace the `src` attribute (today the template literal over `/api/images/` and `image.ref`) with `src={url ?? undefined}`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:run -w @orbital/web -- src/test/seams.test.ts src/test/transcript.test.tsx src/test/api.test.ts src/test/ws.test.ts`
Expected: PASS (the transcript test still finds `/api/images/<ref>` on the thumbnail).

- [ ] **Step 8: Typecheck, the whole web suite, lint**

Run: `npm run typecheck -w @orbital/web && npm run test:run -w @orbital/web && npx eslint web/src/lib web/src/panels/ImageThumb.tsx web/src/ui/Lightbox.tsx web/src/test/seams.test.ts`
Expected: no errors, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/socket.ts web/src/lib/images.ts web/src/panels/ImageThumb.tsx web/src/ui/Lightbox.tsx web/src/test/seams.test.ts
git commit -m "feat(web): configurable API, socket and image transports for the phone"
```

---

### Task 4: The mobile build in `web/`

**Files:**
- Create: `web/index.mobile.html`, `web/vite.mobile.config.ts`
- Create: `web/src/mobile/main.tsx`, `web/src/mobile/MobileApp.tsx`, `web/src/mobile/mobile.css`, `web/src/mobile/env.d.ts`
- Create: `web/src/mobile/bundleGuard.ts`, `web/src/test/mobilebundle.test.ts`
- Modify: `web/package.json` (scripts), `web/tsconfig.node.json` (include), `web/.gitignore`, `eslint.config.js` (ignores + node globals), `web/src/panels/TranscriptView.tsx` (one data attribute)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `web/src/mobile/bundleGuard.ts` — `type ViteManifest = Record<string, { file: string; imports?: string[]; dynamicImports?: string[]; isEntry?: boolean }>`, `type ChunkModules = Record<string, string[]>`, `const FORBIDDEN_MODULE: RegExp`, `forbiddenModules(manifest: ViteManifest, chunkModules: ChunkModules): string[]`; the global `__MOBILE_DEV__: boolean` (declared in `env.d.ts`, defined by `vite.mobile.config.ts` from `ORBITAL_MOBILE_DEV=1`); scripts `build:mobile`, `dev:mobile`, `test:bundle` in `@orbital/web`; the build output `web/dist-mobile/` with `index.html`, `.vite/manifest.json` and `.vite/chunk-modules.json`.

**Decision recorded here:** the guard cannot read three.js out of `manifest.json` alone — a Vite manifest lists chunks, not the modules inside them, and a vendor chunk can be named anything. So the mobile config also writes `.vite/chunk-modules.json` (every chunk's `moduleIds`), and the guard walks every JS file the manifest names and fails on any module under `node_modules/three/` or `node_modules/@react-three/`. The test reads an existing build: in the ordinary suite it is skipped when `dist-mobile/` is absent (CI and `npm test` do not build the phone), and `npm run test:bundle` — which `mobile`'s `build` script runs right after every mobile build — runs it in `--mode bundle`, where a missing build fails instead of skipping. Every APK therefore passes the guard.

- [ ] **Step 1: Write the failing guard test**

Create `web/src/test/mobilebundle.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { forbiddenModules, type ChunkModules, type ViteManifest } from '../mobile/bundleGuard'

describe('forbiddenModules', () => {
  const manifest: ViteManifest = {
    'index.mobile.html': { file: 'assets/index-a.js', isEntry: true, imports: ['_vendor-b.js'] },
    '_vendor-b.js': { file: 'assets/vendor-b.js' },
    'src/assets/logo.svg': { file: 'assets/logo-c.svg' },
  }

  it('passes a bundle with no three.js in any chunk', () => {
    const modules: ChunkModules = {
      'assets/index-a.js': ['/w/web/src/mobile/main.tsx'],
      'assets/vendor-b.js': ['/w/node_modules/react/index.js'],
    }
    expect(forbiddenModules(manifest, modules)).toEqual([])
  })

  it('names every chunk that carries three or @react-three', () => {
    const modules: ChunkModules = {
      'assets/index-a.js': ['/w/node_modules/@react-three/fiber/dist/index.js'],
      'assets/vendor-b.js': ['/w/node_modules/three/build/three.module.js'],
    }
    expect(forbiddenModules(manifest, modules)).toEqual([
      'assets/index-a.js: /w/node_modules/@react-three/fiber/dist/index.js',
      'assets/vendor-b.js: /w/node_modules/three/build/three.module.js',
    ])
  })

  it('fails a JS chunk it cannot see into', () => {
    expect(forbiddenModules(manifest, { 'assets/index-a.js': [] })).toEqual(['assets/vendor-b.js: not in chunk-modules.json'])
  })
})

type Fs = { existsSync(path: URL): boolean; readFileSync(path: URL, encoding: 'utf8'): string }
// Through `process` rather than an import: web/'s tsconfig carries no Node types.
const fs = (globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } }).process.getBuiltinModule('node:fs')
const built = new URL('../../dist-mobile/.vite/', import.meta.url)
const hasBuild = fs.existsSync(new URL('manifest.json', built))
// `npm run test:bundle` runs in this mode, right after a mobile build: there, no build is a failure.
const required = import.meta.env.MODE === 'bundle'

describe('the built mobile bundle', () => {
  it.skipIf(!hasBuild && !required)('carries no three.js in any chunk', () => {
    expect(hasBuild, 'run `npm run build:mobile -w @orbital/web` first').toBe(true)
    const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', built), 'utf8')) as ViteManifest
    const modules = JSON.parse(fs.readFileSync(new URL('chunk-modules.json', built), 'utf8')) as ChunkModules
    expect(forbiddenModules(manifest, modules)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:run -w @orbital/web -- src/test/mobilebundle.test.ts`
Expected: FAIL — `../mobile/bundleGuard` does not exist.

- [ ] **Step 3: Write the guard**

Create `web/src/mobile/bundleGuard.ts`:

```ts
/**
 * three.js must stay out of the phone's bundle (spec 2026-10-02-mobile-app-design
 * § 1): the map is the desktop's, and a three import reachable from the
 * store or `lib/` would ship it anyway. A Vite manifest names chunks, not
 * their modules, so the mobile build also writes `chunk-modules.json`
 * (`vite.mobile.config.ts`) and this reads both.
 */
export type ViteManifest = Record<
  string,
  { file: string; imports?: string[]; dynamicImports?: string[]; isEntry?: boolean }
>
export type ChunkModules = Record<string, string[]>

export const FORBIDDEN_MODULE = /[\\/]node_modules[\\/](three|@react-three)[\\/]/

/** Every offending `<chunk>: <module>`; a JS chunk missing from `chunkModules` counts, since it went unchecked. */
export function forbiddenModules(manifest: ViteManifest, chunkModules: ChunkModules): string[] {
  const hits: string[] = []
  const files = [...new Set(Object.values(manifest).map((entry) => entry.file))]
    .filter((file) => file.endsWith('.js'))
    .sort()
  for (const file of files) {
    const modules = chunkModules[file]
    if (!modules) {
      hits.push(`${file}: not in chunk-modules.json`)
      continue
    }
    for (const id of modules) if (FORBIDDEN_MODULE.test(id)) hits.push(`${file}: ${id}`)
  }
  return hits
}
```

- [ ] **Step 4: Run the guard's unit tests**

Run: `npm run test:run -w @orbital/web -- src/test/mobilebundle.test.ts`
Expected: PASS for `forbiddenModules` (3 tests); `the built mobile bundle` is skipped (no build yet).

- [ ] **Step 5: Add the mobile entry**

Create `web/index.mobile.html`:

```html
<!doctype html>
<html lang="en" data-platform="mobile">
  <head>
    <meta charset="UTF-8" />
    <meta name="theme-color" content="#05070d" />
    <meta name="color-scheme" content="dark" />
    <!--
      viewport-fit=cover lets the app draw under the status and navigation
      bars; mobile.css pads by the safe-area insets instead. Zoom stays off as
      on the desktop entry (web/CLAUDE.md), revisited before distribution.
    -->
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1.0, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    />
    <title>Orbital</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/mobile/main.tsx"></script>
  </body>
</html>
```

Create `web/src/mobile/env.d.ts`:

```ts
/** True in a build made with `ORBITAL_MOBILE_DEV=1` (vite.mobile.config.ts): the paste field shows beside the scanner. */
declare const __MOBILE_DEV__: boolean
```

Create `web/src/mobile/mobile.css`:

```css
/*
 * The phone's layout rules (spec 2026-10-02-mobile-app-design § 1): the
 * desktop panels are reused as they are, and 9b's touch metrics reach them
 * through `data-platform="mobile"` on the root, never through props threaded
 * into `panels/`. The values are 9b's; the fidelity pass owns them.
 */
:root[data-platform='mobile'] body {
  background: var(--color-space);
  overscroll-behavior: none;
  -webkit-tap-highlight-color: transparent;
}

:root[data-platform='mobile'] #root {
  /* Each screen scrolls inside itself (`MobileScreen`), so the root is exactly the viewport. */
  box-sizing: border-box;
  height: 100dvh;
  overflow: hidden;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
}

/* 9b: a tool row is a touch target. */
:root[data-platform='mobile'] [data-tool-header] > button {
  min-height: 44px;
}

/* 9b: a folded run reads on two lines — the count, then the breakdown. */
:root[data-platform='mobile'] [data-tool-run] > button {
  flex-wrap: wrap;
  min-height: 44px;
  row-gap: 2px;
}
:root[data-platform='mobile'] [data-run-breakdown] {
  flex-basis: 100%;
  order: 10;
  padding-left: 1.5rem;
}
```

Create `web/src/mobile/MobileApp.tsx`:

```tsx
/** The phone's shell. Task 8 replaces this with the screen router. */
export function MobileApp() {
  return (
    <main className="flex h-full items-center justify-center bg-space font-sans text-text-bright">
      <span className="font-mono text-[11px] tracking-[0.2em] text-text-muted">ORBITAL</span>
    </main>
  )
}
```

Create `web/src/mobile/main.tsx`:

```tsx
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '../theme.css'
import './mobile.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { MobileApp } from './MobileApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Orbital">
      <MobileApp />
    </ErrorBoundary>
  </StrictMode>,
)
```

In `web/src/panels/TranscriptView.tsx`, give the folded run's breakdown span a hook for `mobile.css` — change

```tsx
        <span className="min-w-0 flex-1 truncate text-[rgba(160,190,225,.6)]">{summary.breakdown}</span>
```

to

```tsx
        <span data-run-breakdown className="min-w-0 flex-1 truncate text-[rgba(160,190,225,.6)]">{summary.breakdown}</span>
```

- [ ] **Step 6: Add the build config and scripts**

Create `web/vite.mobile.config.ts`:

```ts
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * The phone's build (spec 2026-10-02-mobile-app-design § 1): its own HTML
 * entry, written out as the `index.html` Capacitor loads; no dev proxy,
 * since the phone never talks to a local server; and every chunk's module
 * list beside the manifest, for the bundle guard (`src/mobile/bundleGuard.ts`).
 */
const ENTRY = 'index.mobile.html'

function mobileEntry(): Plugin {
  return {
    name: 'orbital-mobile-entry',
    enforce: 'post',
    // `npm run dev:mobile` serves the phone's page at `/`, not the desktop's.
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url === '/index.html') req.url = `/${ENTRY}`
        next()
      })
    },
    generateBundle(_options, bundle) {
      const html = bundle[ENTRY]
      if (html?.type !== 'asset') return
      delete bundle[ENTRY]
      this.emitFile({ type: 'asset', fileName: 'index.html', source: html.source })
    },
  }
}

function chunkModules(): Plugin {
  return {
    name: 'orbital-chunk-modules',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const modules: Record<string, string[]> = {}
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') modules[item.fileName] = item.moduleIds
      }
      this.emitFile({ type: 'asset', fileName: '.vite/chunk-modules.json', source: JSON.stringify(modules, null, 2) })
    },
  }
}

export default defineConfig({
  plugins: [tailwindcss(), react(), mobileEntry(), chunkModules()],
  define: {
    __MOBILE_DEV__: JSON.stringify(process.env.ORBITAL_MOBILE_DEV === '1'),
  },
  build: {
    outDir: 'dist-mobile',
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: fileURLToPath(new URL(`./${ENTRY}`, import.meta.url)) },
  },
  // Beside the desktop's dev port; the relay's local port is the one below.
  server: { port: 4841, strictPort: true },
})
```

In `web/package.json` `scripts`, add after `"preview"`:

```json
    "build:mobile": "vite build --config vite.mobile.config.ts",
    "dev:mobile": "vite --config vite.mobile.config.ts",
    "test:bundle": "vitest run --mode bundle src/test/mobilebundle.test.ts",
```

In `web/tsconfig.node.json`, change `"include": ["vite.config.ts"]` to `"include": ["vite.config.ts", "vite.mobile.config.ts"]`.

In `web/.gitignore`, add a line `dist-mobile` under `dist`.

In `eslint.config.js`:
- add `'web/dist-mobile/',` and `'mobile/android/',` to the top-level `ignores` array (after `'**/coverage/',`);
- change the block `files: ['web/vite.config.ts', 'web/vitest.config.ts', 'server/*.config.ts']` to `files: ['web/vite.config.ts', 'web/vite.mobile.config.ts', 'web/vitest.config.ts', 'server/*.config.ts']`.

- [ ] **Step 7: Build and run the guard against the real bundle**

Run: `npm run build:mobile -w @orbital/web && ls web/dist-mobile web/dist-mobile/.vite && npm run test:bundle -w @orbital/web`
Expected: the build succeeds; `web/dist-mobile` holds `index.html` and `assets/`; `.vite` holds `manifest.json` and `chunk-modules.json`; the guard PASSES (4 tests, none skipped).

- [ ] **Step 8: Look at it in a browser**

Run (in the background): `npm run dev:mobile -w @orbital/web`, then open `http://localhost:4841` in a narrow window. Expected: a dark page with ORBITAL centred. Stop the dev server.

- [ ] **Step 9: Typecheck, web suite, lint**

Run: `npm run typecheck -w @orbital/web && npm run test:run -w @orbital/web && npm run lint`
Expected: no errors; the built-bundle test runs (the build exists) and passes.

- [ ] **Step 10: Commit**

```bash
git add web/index.mobile.html web/vite.mobile.config.ts web/src/mobile web/src/test/mobilebundle.test.ts web/package.json web/tsconfig.node.json web/.gitignore eslint.config.js web/src/panels/TranscriptView.tsx
git commit -m "feat(web): the phone's Vite entry and a bundle guard against three.js"
```

---

### Task 5: The `mobile/` Capacitor workspace and the Android project

**Files:**
- Create: `mobile/package.json`, `mobile/capacitor.config.ts`, `mobile/tsconfig.json`, `mobile/scripts/android-env.sh`, `mobile/.gitignore`
- Create (generated, then edited): `mobile/android/` — edit `mobile/android/app/src/main/AndroidManifest.xml`, create `mobile/android/app/src/main/res/xml/network_security_config.xml`
- Modify: `package.json` (root: workspaces, typecheck), `web/vite.mobile.config.ts` (version define), `web/src/mobile/env.d.ts`, `eslint.config.js` (node globals for `mobile/*.ts`), `README.md`
- Create: `docs/ops/build-the-android-app.md`

**Interfaces:**
- Consumes: Task 4's `npm run build:mobile -w @orbital/web`, `npm run test:bundle -w @orbital/web`, `web/dist-mobile/`.
- Produces: workspace `@orbital/mobile` (version `0.1.0`) with scripts `build` (web mobile build → bundle guard → `cap sync android`), `apk` (`gradlew assembleDebug`), `run` (`cap run android`), `typecheck`; the global `__MOBILE_VERSION__: string` (from `mobile/package.json`) for `web/src/mobile/`; `mobile/scripts/android-env.sh` exporting `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `JAVA_HOME`, `PATH`; the APK at `mobile/android/app/build/outputs/apk/debug/app-debug.apk`; app id `io.slothworks.orbital.mobile`.

- [ ] **Step 1: Check the build environment**

Run: `/usr/libexec/java_home -V 2>&1; ls "$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java" "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java" 2>&1; ls ~/Library/Android/sdk; which adb; ~/Library/Android/sdk/emulator/emulator -list-avds`
Expected: no JDK 21 registered (Java 8 only); the JBR's `java` exists under `$HOME/Applications/…`; the SDK lists `platform-tools platforms build-tools emulator cmdline-tools ndk`; `adb` is `/opt/homebrew/bin/adb`; the AVD list contains `Samsung_Galaxy_S24_Ultra`. If the JBR is missing in both places, stop and tell the controller: installing a JDK is the owner's call.

- [ ] **Step 2: Create the workspace files**

Create `mobile/package.json`:

```json
{
  "name": "@orbital/mobile",
  "version": "0.1.0",
  "private": true,
  "description": "Orbital on the phone: the Capacitor shell around web/'s mobile entry.",
  "author": "SlothWorks s.r.o.",
  "scripts": {
    "build": "npm run build:mobile -w @orbital/web && npm run test:bundle -w @orbital/web && cap sync android",
    "apk": ". ./scripts/android-env.sh && cd android && ./gradlew assembleDebug",
    "run": ". ./scripts/android-env.sh && cap run android",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@aparajita/capacitor-secure-storage": "^8.0.1",
    "@capacitor-mlkit/barcode-scanning": "^8.2.1",
    "@capacitor/android": "^8.5.2",
    "@capacitor/app": "^8.1.1",
    "@capacitor/core": "^8.5.2",
    "@capacitor/device": "^8.0.3",
    "@capacitor/filesystem": "^8.1.3",
    "@capacitor/preferences": "^8.0.1"
  },
  "devDependencies": {
    "@capacitor/cli": "^8.5.2",
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3"
  }
}
```

Create `mobile/capacitor.config.ts`:

```ts
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The phone's shell (spec 2026-10-02-mobile-app-design § 1). The web code is
 * `web/`'s mobile build; nothing here decides anything at runtime.
 *
 * `ORBITAL_MOBILE_DEV=1` at `cap sync` time lets the WebView (served from
 * https://localhost) reach a plain-http relay on the Mac through
 * `adb reverse` — a laptop relay, never a deployed one. Cleartext itself is
 * allowed only for loopback addresses, by
 * `android/app/src/main/res/xml/network_security_config.xml`.
 */
const dev = process.env.ORBITAL_MOBILE_DEV === '1';

const config: CapacitorConfig = {
  appId: 'io.slothworks.orbital.mobile',
  appName: 'Orbital',
  webDir: '../web/dist-mobile',
  android: { allowMixedContent: dev },
};

export default config;
```

Create `mobile/tsconfig.json`:

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
  "include": ["capacitor.config.ts"]
}
```

Create `mobile/scripts/android-env.sh`:

```sh
#!/bin/sh
# Sourced by mobile/'s npm scripts before Gradle or `cap run` (runbook
# build-the-android-app). A value already set in the environment wins.

# Where Android Studio installs the SDK unless told otherwise.
: "${ANDROID_HOME:=$HOME/Library/Android/sdk}"

# Gradle for Capacitor needs JDK 21; the system `java` may be older. A
# registered JDK 21 first, then Android Studio's bundled JBR, user install
# before system install.
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="$(/usr/libexec/java_home -F -v 21 2>/dev/null || true)"
fi
if [ -z "$JAVA_HOME" ]; then
  for jbr in "$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
             "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    if [ -d "$jbr" ]; then
      JAVA_HOME="$jbr"
      break
    fi
  done
fi

export ANDROID_HOME JAVA_HOME
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
```

Run: `chmod +x mobile/scripts/android-env.sh`

Create `mobile/.gitignore`:

```
node_modules
```

- [ ] **Step 3: Register the workspace and install**

In the root `package.json`:
- `"workspaces"`: add `"mobile"` after `"relay"`;
- `"typecheck"`: append ` && npm run typecheck -w mobile`.

In `eslint.config.js`, change `files: ['server/**/*.ts', 'desktop/**/*.ts', 'scripts/**/*.ts']` to `files: ['server/**/*.ts', 'desktop/**/*.ts', 'scripts/**/*.ts', 'mobile/*.ts']`.

Run: `npm install`
Expected: installs the Capacitor packages; `package-lock.json` changes.

Run: `npm run typecheck -w mobile`
Expected: no errors.

- [ ] **Step 4: Give the web build the app's version**

In `web/vite.mobile.config.ts`, add `import { readFileSync } from 'node:fs'` at the top, and above `const ENTRY` add:

```ts
/** `orbital mobile <version>` in 9f's footer and the `hello` app string: the shell's version. */
const mobileVersion = (
  JSON.parse(readFileSync(new URL('../mobile/package.json', import.meta.url), 'utf8')) as { version: string }
).version
```

and add to `define`:

```ts
    __MOBILE_VERSION__: JSON.stringify(mobileVersion),
```

Append to `web/src/mobile/env.d.ts`:

```ts
/** `version` from mobile/package.json, set by vite.mobile.config.ts. */
declare const __MOBILE_VERSION__: string
```

- [ ] **Step 5: Generate the Android project**

Run: `npm run build:mobile -w @orbital/web && cd mobile && npx cap add android && cd ..`
Expected: `mobile/android/` exists with `app/`, `gradlew`, `capacitor.settings.gradle`, `variables.gradle`; Capacitor reports the six plugins it found.

- [ ] **Step 6: Edit the generated manifest**

In `mobile/android/app/src/main/AndroidManifest.xml`:

1. On the `<application` element, add the attribute `android:networkSecurityConfig="@xml/network_security_config"`.
2. Inside `<application>`, before `</application>`, add the ML Kit scanner module declaration the plugin's README requires:

```xml
        <meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode_ui" />
```

Create `mobile/android/app/src/main/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!--
  Cleartext only to loopback: a relay running on the Mac, reached from a
  device through `adb reverse` or from the emulator's 10.0.2.2. A deployed
  relay is https and needs nothing here (runbook build-the-android-app).
-->
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
        <domain includeSubdomains="false">localhost</domain>
        <domain includeSubdomains="false">10.0.2.2</domain>
    </domain-config>
</network-security-config>
```

Run: `cat mobile/android/.gitignore`
Expected: the generated file excludes `build/`, `.gradle/`, `local.properties`, `app/src/main/assets/public` and the Cordova plugins' build output. If `app/src/main/assets/public` is not listed, add it — it is the copied web build.

- [ ] **Step 7: Sync and build the APK**

Run: `npm run build -w @orbital/mobile && npm run apk -w @orbital/mobile`
Expected: the web build, the bundle guard (PASS), `cap sync android` (copies `web/dist-mobile` into `android/app/src/main/assets/public` and updates the six plugins), then `BUILD SUCCESSFUL` from Gradle and `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

If Gradle reports an unsupported Java version, run `. mobile/scripts/android-env.sh && echo "$JAVA_HOME" && "$JAVA_HOME/bin/java" -version` and check it reads 21; the runbook's troubleshooting section covers the cases.

- [ ] **Step 8: Run it on the emulator and take a screenshot**

Run (in the background — it keeps running): `. mobile/scripts/android-env.sh && emulator -avd Samsung_Galaxy_S24_Ultra -no-snapshot-save`
Then: `adb wait-for-device && adb shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done' && adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk && adb shell am start -n io.slothworks.orbital.mobile/.MainActivity && sleep 3 && adb exec-out screencap -p > /tmp/orbital-mobile-task5.png`
Expected: the app launches; `/tmp/orbital-mobile-task5.png` shows the dark screen with ORBITAL centred. Read the PNG to confirm.

- [ ] **Step 9: Write the runbook and the README section**

Create `docs/ops/build-the-android-app.md`:

````markdown
---
id: build-the-android-app
title: Build and run the Android app
type: runbook
status: active
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - run-the-relay
tags:
  - mobile
  - android
  - capacitor
---
# Build and run the Android app

`mobile/` is the Capacitor shell; the app itself is `web/`'s mobile entry
(`web/src/mobile/`), built into `web/dist-mobile/` and copied into the
Android project by `cap sync`.

## Prerequisites

- **Android SDK** with platform-tools, a platform, build-tools and the
  emulator. Android Studio installs it under `~/Library/Android/sdk`, which is
  where `mobile/scripts/android-env.sh` looks when `ANDROID_HOME` is not set.
- **JDK 21 for Gradle.** The system `java` on this Mac is 1.8, which Gradle
  cannot use. The env script takes, in order: `JAVA_HOME` if set; a JDK 21
  registered with macOS (`/usr/libexec/java_home -F -v 21`); Android Studio's
  bundled JBR at `$HOME/Applications/Android Studio.app/Contents/jbr/Contents/Home`
  or `/Applications/Android Studio.app/Contents/jbr/Contents/Home`. Check what
  it picked:

  ```bash
  . mobile/scripts/android-env.sh && echo "$JAVA_HOME" && "$JAVA_HOME/bin/java" -version
  ```

  Installing a separate JDK is optional (`brew install --cask temurin@21`
  registers one with `java_home`); the JBR is enough.
- **An emulator or a device.** `emulator -list-avds` lists the AVDs; this
  Mac has `Samsung_Galaxy_S24_Ultra`. `adb` is on `PATH` from Homebrew; the
  env script also puts the SDK's `platform-tools` and `emulator` on `PATH`.

Every `mobile` script that runs Gradle or `cap run` sources the env script,
so they work from a plain shell. For a command of your own:

```bash
. mobile/scripts/android-env.sh
```

## Build

```bash
npm install                              # once, from the repo root
npm run build -w @orbital/mobile         # web mobile build → bundle guard → cap sync android
npm run apk -w @orbital/mobile           # gradlew assembleDebug
```

The APK is `mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
`build` fails if three.js reached the phone's bundle
(`web/src/test/mobilebundle.test.ts`).

A **dev build** (`ORBITAL_MOBILE_DEV=1 npm run build -w @orbital/mobile`)
shows the paste field beside the scanner and lets the WebView reach a
plain-http relay on loopback; use one whenever you pair against a relay on
this Mac.

## Run on the emulator

```bash
. mobile/scripts/android-env.sh
emulator -avd Samsung_Galaxy_S24_Ultra -no-snapshot-save &
adb wait-for-device
adb shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done'
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.slothworks.orbital.mobile/.MainActivity
```

Or build, install and launch in one go:
`npm run run -w @orbital/mobile -- --target Samsung_Galaxy_S24_Ultra`
(`npx cap run android --list` from `mobile/` lists targets).

## Screenshot

```bash
adb exec-out screencap -p > /tmp/orbital-mobile.png
```

## Pair with a relay on this Mac

Task 9 of the 2a plan adds this section, with the script that types a pairing code into the emulator.

## Troubleshooting

- **`Unsupported class file major version` / `requires Java 21`**: Gradle
  ran on the wrong JDK. Source the env script and check `java -version`.
- **`SDK location not found`**: `ANDROID_HOME` is unset and the SDK is not
  at the default path. Export it, or write `sdk.dir=/path/to/sdk` into
  `mobile/android/local.properties` (ignored by git).
- **The scanner is "preparing"**: the Google Barcode Scanner module is
  still downloading through Play services; scan again in a minute. An
  emulator without Play services never gets it — use a dev build's paste field.
- **"Can't reach the relay in this code" with a local relay**: `adb reverse`
  was not run in this emulator session, or the build was not a dev build.
````

In `README.md`, replace the paragraph under `## Mobile remote` (the one that ends "…so nothing can pair until one exists. Off is the default.") with:

```markdown
`relay/` is a small Fastify + `ws` service that lets a phone pair with
this Mac and drive Orbital's API over an end-to-end encrypted tunnel, for
deployment on Dokploy. The backend (relay, wire protocol in `shared/`,
and the Mac side in `server/src/remote/`) and the desktop's Settings →
Mobile (the switch, the pairing QR, the fingerprint confirmation, the
paired phones) are built. The phone app is `mobile/` (the Capacitor shell)
around `web/src/mobile/`; see
[`docs/ops/build-the-android-app.md`](docs/ops/build-the-android-app.md).
Off is the default.
```

and in the code block under it, after `npm run dev -w relay     # relay on :4840, SQLite under relay/data/`, add the lines:

```
npm run dev:mobile -w @orbital/web   # the phone's UI in a browser, :4841
npm run build -w @orbital/mobile     # web mobile build + cap sync android
npm run apk -w @orbital/mobile       # debug APK
```

- [ ] **Step 10: Validate, typecheck, lint**

Run: `bunx @slothworks/atlas validate && npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 11: Commit**

Run first: `git status --short mobile/android | grep -E 'build/|assets/public|\.gradle/'` — expect no output; none of those may be staged.

```bash
git add mobile/package.json mobile/capacitor.config.ts mobile/tsconfig.json mobile/scripts/android-env.sh mobile/.gitignore mobile/android package.json package-lock.json eslint.config.js web/vite.mobile.config.ts web/src/mobile/env.d.ts docs/ops/build-the-android-app.md README.md
git commit -m "feat(mobile): Capacitor shell with the generated Android project"
```

---

### Task 6: Platform layer — identity, pairing, cache, image cache, device

**Files:**
- Modify: `web/package.json` (dependencies), `shared/src/remote/handshake.ts` (`SessionCipher` constructor)
- Create: `web/src/mobile/platform/parse.ts`, `base64.ts`, `identity.ts`, `pairing.ts`, `cache.ts`, `imageCache.ts`, `device.ts`
- Test: `web/src/test/mobileplatform.test.ts`

**Interfaces:**
- Consumes: `@orbital/shared/remote/keys` (`generateIdentity`, `identityFromSecret`, `fromBase64Url`, `toBase64Url`, `publicKeyOf`, `SECRET_KEY_BYTES`, `Identity`), `@orbital/shared/remote/messages` (`NotificationSettingsSchema`, `NotificationSettings`), `web/src/lib/types` (`ApiSession`, `ChatMessage`, `Tag`).
- Produces:
  - `platform/parse.ts` (pure, no Capacitor): `interface Pairing { relay: string; mac: string; macName: string; fingerprint: string; pairedAt: number }`, `interface Cached<T> { asOf: number; value: T }`, `interface SessionsSnapshot { sessions: ApiSession[]; tags: Tag[] }`, `type IdentityBackend = 'secure' | 'local'`, `identityBackend(native: boolean): IdentityBackend`, `serializeIdentity(identity: Identity): string`, `parseIdentity(raw: string | null): Identity | null`, `isHttpUrl(text: string): boolean`, `parsePairing(raw: string | null): Pairing | null`, `parseCached<T>(raw: string | null, accept: (value: unknown) => T | null): Cached<T> | null`, `acceptSessions(value: unknown): SessionsSnapshot | null`, `acceptMessages(value: unknown): ChatMessage[] | null`, `acceptNotifications(value: unknown): NotificationSettings | null`, `FALLBACK_DEVICE_NAME`, `deviceName(info: { model?: string | null } | null): string`
  - `platform/base64.ts`: `bytesToBase64(bytes: Uint8Array): string`, `base64ToBytes(text: string): Uint8Array`
  - `platform/identity.ts`: `IDENTITY_KEY`, `loadOrCreateIdentity(): Promise<Identity>`, `forgetIdentity(): Promise<void>`, `identityIsDevOnly(): boolean`
  - `platform/pairing.ts`: `PAIRING_KEY`, `UNPAIRED_KEY`, `loadPairing(): Promise<Pairing | null>`, `savePairing(pairing: Pairing): Promise<void>`, `clearPairing(): Promise<void>`, `loadUnpaired(): Promise<{ macName: string } | null>`, `setUnpaired(macName: string): Promise<void>`, `clearUnpaired(): Promise<void>`
  - `platform/cache.ts`: `CACHE_PREFIX`, `readSessionsCache(): Promise<Cached<SessionsSnapshot> | null>`, `writeSessionsCache(value: SessionsSnapshot, asOf: number): Promise<void>`, `readTranscriptCache(id: string): Promise<Cached<ChatMessage[]> | null>`, `writeTranscriptCache(id: string, messages: ChatMessage[], asOf: number): Promise<void>`, `readNotificationsCache(): Promise<Cached<NotificationSettings> | null>`, `writeNotificationsCache(settings: NotificationSettings, asOf: number): Promise<void>`, `clearCaches(): Promise<void>`
  - `platform/imageCache.ts`: `readCachedImage(ref: string): Promise<Uint8Array | null>`, `writeCachedImage(ref: string, bytes: Uint8Array): Promise<void>`, `clearImageCache(): Promise<void>`
  - `platform/device.ts`: `thisDevice(): Promise<{ name: string; platform: string }>`

- [ ] **Step 1: Add the dependencies**

In `web/package.json` `dependencies`, add (keep alphabetical order):

```json
    "@aparajita/capacitor-secure-storage": "^8.0.1",
    "@capacitor-mlkit/barcode-scanning": "^8.2.1",
    "@capacitor/app": "^8.1.1",
    "@capacitor/core": "^8.5.2",
    "@capacitor/device": "^8.0.3",
    "@capacitor/filesystem": "^8.1.3",
    "@capacitor/preferences": "^8.0.1",
    "@orbital/shared": "*",
```

Run: `npm install`
Expected: no new downloads beyond the lockfile (Task 5 installed them for `mobile/`); `package-lock.json` records `web`'s new dependencies.

- [ ] **Step 2: Make `shared/`'s cipher compile under `web/`'s options**

`web/`'s `tsconfig.app.json` has `erasableSyntaxOnly`, which rejects constructor parameter properties, and `web/` now compiles `shared/src/remote/*.ts` through the client. In `shared/src/remote/handshake.ts`, replace

```ts
export class SessionCipher {
  private sendCounter = 0n;
  private lastReceived = -1n;

  constructor(private readonly sendKey: Uint8Array, private readonly recvKey: Uint8Array) {}
```

with

```ts
export class SessionCipher {
  private sendCounter = 0n;
  private lastReceived = -1n;
  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;

  // Plain fields, not parameter properties: web/ compiles this file with
  // `erasableSyntaxOnly` since the phone's client imports it.
  constructor(sendKey: Uint8Array, recvKey: Uint8Array) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
  }
```

Run: `npm test -w shared -- test/handshake.test.ts test/client.test.ts`
Expected: PASS (behaviour unchanged).

- [ ] **Step 3: Write the failing tests**

Create `web/src/test/mobileplatform.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { deviceId, generateIdentity, toBase64Url } from '@orbital/shared/remote/keys'
import { base64ToBytes, bytesToBase64 } from '../mobile/platform/base64'
import {
  FALLBACK_DEVICE_NAME, acceptMessages, acceptNotifications, acceptSessions, deviceName, identityBackend,
  parseCached, parseIdentity, parsePairing, serializeIdentity,
} from '../mobile/platform/parse'

describe('identity', () => {
  it('round-trips through its stored form', () => {
    const identity = generateIdentity()
    const back = parseIdentity(serializeIdentity(identity))
    expect(back && Array.from(back.publicKey)).toEqual(Array.from(identity.publicKey))
  })

  it('reads nothing from nothing, garbage, a wrong length or a non-canonical spelling', () => {
    expect(parseIdentity(null)).toBeNull()
    expect(parseIdentity('not a key')).toBeNull()
    expect(parseIdentity(toBase64Url(new Uint8Array(16)))).toBeNull()
    expect(parseIdentity(`${serializeIdentity(generateIdentity())}=`)).toBeNull()
  })

  it('keeps the key in secure storage on a device and in localStorage in a browser', () => {
    expect(identityBackend(true)).toBe('secure')
    expect(identityBackend(false)).toBe('local')
  })
})

describe('parsePairing', () => {
  const mac = deviceId(generateIdentity().publicKey)
  const good = { relay: 'https://relay.example.org', mac, macName: 'studio', fingerprint: 'ABC123', pairedAt: 1 }

  it('reads a stored pairing', () => {
    expect(parsePairing(JSON.stringify(good))).toEqual(good)
  })

  it('reads nothing from bad JSON, a missing field, a bad Mac id or a relay that is not http(s)', () => {
    expect(parsePairing(null)).toBeNull()
    expect(parsePairing('{')).toBeNull()
    expect(parsePairing(JSON.stringify({ ...good, macName: undefined }))).toBeNull()
    expect(parsePairing(JSON.stringify({ ...good, mac: 'nope' }))).toBeNull()
    expect(parsePairing(JSON.stringify({ ...good, relay: 'ftp://relay.example.org' }))).toBeNull()
  })
})

describe('parseCached', () => {
  it('reads a cached value with its asOf', () => {
    const raw = JSON.stringify({ asOf: 5, value: { sessions: [], tags: [] } })
    expect(parseCached(raw, acceptSessions)).toEqual({ asOf: 5, value: { sessions: [], tags: [] } })
  })

  it('reads nothing from bad JSON, a missing asOf or a value of the wrong shape', () => {
    expect(parseCached('{nope', acceptSessions)).toBeNull()
    expect(parseCached(JSON.stringify({ value: { sessions: [], tags: [] } }), acceptSessions)).toBeNull()
    expect(parseCached(JSON.stringify({ asOf: 5, value: { sessions: 'x', tags: [] } }), acceptSessions)).toBeNull()
    expect(parseCached(JSON.stringify({ asOf: 5, value: {} }), acceptMessages)).toBeNull()
  })

  it('accepts notification rules only in their full shape', () => {
    const rules = { needsInput: true, sessionEnded: false, sessionFailed: true, onlyWhenBackground: true, sound: false }
    expect(acceptNotifications(rules)).toEqual(rules)
    expect(acceptNotifications({ ...rules, sound: undefined })).toBeNull()
  })
})

describe('base64', () => {
  it('round-trips every byte value, past one chunk', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256)
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
    expect(bytesToBase64(new Uint8Array(0))).toBe('')
  })
})

describe('deviceName', () => {
  it('names the phone by its model, else by the fallback', () => {
    expect(deviceName({ model: 'Pixel 8' })).toBe('Pixel 8')
    expect(deviceName({ model: '  ' })).toBe(FALLBACK_DEVICE_NAME)
    expect(deviceName(null)).toBe(FALLBACK_DEVICE_NAME)
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npm run test:run -w @orbital/web -- src/test/mobileplatform.test.ts`
Expected: FAIL — `../mobile/platform/base64` does not exist.

- [ ] **Step 5: Write the pure parsers**

Create `web/src/mobile/platform/parse.ts`:

```ts
import {
  SECRET_KEY_BYTES, fromBase64Url, identityFromSecret, publicKeyOf, toBase64Url, type Identity,
} from '@orbital/shared/remote/keys'
import { NotificationSettingsSchema, type NotificationSettings } from '@orbital/shared/remote/messages'
import type { ApiSession, ChatMessage, Tag } from '../../lib/types'

/**
 * What the phone keeps between launches (spec 2026-10-02-mobile-app-design
 * § 4), read back defensively: anything unreadable is treated as absent,
 * never thrown — a bad cache costs a refetch, a bad pairing a new scan.
 * Nothing here touches Capacitor, so all of it is testable in jsdom.
 */

/** The one Mac this phone is paired with. */
export interface Pairing {
  relay: string
  mac: string
  macName: string
  fingerprint: string
  pairedAt: number
}

export interface Cached<T> {
  asOf: number
  value: T
}

export interface SessionsSnapshot {
  sessions: ApiSession[]
  tags: Tag[]
}

export type IdentityBackend = 'secure' | 'local'

/** The Keystore through secure storage on a device; `localStorage` in a desktop browser, dev only (spec § 1). */
export function identityBackend(native: boolean): IdentityBackend {
  return native ? 'secure' : 'local'
}

export function serializeIdentity(identity: Identity): string {
  return toBase64Url(identity.secretKey)
}

export function parseIdentity(raw: string | null): Identity | null {
  if (!raw) return null
  const text = raw.trim()
  const secret = fromBase64Url(text)
  // The one canonical spelling of exactly one secret key, nothing looser.
  if (secret.length !== SECRET_KEY_BYTES || toBase64Url(secret) !== text) return null
  try {
    return identityFromSecret(secret)
  } catch {
    return null
  }
}

export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function parseJson(raw: string | null): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export function parsePairing(raw: string | null): Pairing | null {
  const data = parseJson(raw)
  if (!data || typeof data !== 'object') return null
  const p = data as Record<string, unknown>
  if (typeof p.relay !== 'string' || !isHttpUrl(p.relay)) return null
  if (typeof p.mac !== 'string' || publicKeyOf(p.mac) === null) return null
  if (typeof p.macName !== 'string' || typeof p.fingerprint !== 'string') return null
  if (typeof p.pairedAt !== 'number' || !Number.isFinite(p.pairedAt)) return null
  return { relay: p.relay, mac: p.mac, macName: p.macName, fingerprint: p.fingerprint, pairedAt: p.pairedAt }
}

export function parseCached<T>(raw: string | null, accept: (value: unknown) => T | null): Cached<T> | null {
  const data = parseJson(raw)
  if (!data || typeof data !== 'object') return null
  const { asOf, value } = data as { asOf?: unknown; value?: unknown }
  if (typeof asOf !== 'number' || !Number.isFinite(asOf)) return null
  const accepted = accept(value)
  return accepted === null ? null : { asOf, value: accepted }
}

export function acceptSessions(value: unknown): SessionsSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const { sessions, tags } = value as { sessions?: unknown; tags?: unknown }
  return Array.isArray(sessions) && Array.isArray(tags)
    ? { sessions: sessions as ApiSession[], tags: tags as Tag[] }
    : null
}

export function acceptMessages(value: unknown): ChatMessage[] | null {
  return Array.isArray(value) ? (value as ChatMessage[]) : null
}

export function acceptNotifications(value: unknown): NotificationSettings | null {
  const parsed = NotificationSettingsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** What the Mac's confirm and its device list call a phone whose model is unknown (spec § 5, 9e). */
export const FALLBACK_DEVICE_NAME = 'Android phone'

export function deviceName(info: { model?: string | null } | null): string {
  const model = info?.model?.trim()
  return model ? model : FALLBACK_DEVICE_NAME
}
```

Create `web/src/mobile/platform/base64.ts`:

```ts
/** Bytes per `String.fromCharCode` call: below every engine's argument-count limit. */
const CHUNK_BYTES = 0x8000

/** Standard base64, which Capacitor's Filesystem reads and writes. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_BYTES))
  }
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:run -w @orbital/web -- src/test/mobileplatform.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Write the storage modules**

Create `web/src/mobile/platform/identity.ts`:

```ts
import { Capacitor } from '@capacitor/core'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { generateIdentity, type Identity } from '@orbital/shared/remote/keys'
import { identityBackend, parseIdentity, serializeIdentity } from './parse'

/**
 * This phone's Ed25519 identity (spec § 4): lost only by an uninstall or by
 * "Pair a different Mac". In the Android Keystore through secure storage;
 * in a desktop browser, in `localStorage` — unprotected, for development only,
 * and the pairing screen says so (`identityIsDevOnly`).
 */
export const IDENTITY_KEY = 'orbital.identity'

interface SecretStore {
  get(): Promise<string | null>
  set(value: string): Promise<void>
  remove(): Promise<void>
}

function store(): SecretStore {
  if (identityBackend(Capacitor.isNativePlatform()) === 'secure') {
    return {
      get: () => SecureStorage.getItem(IDENTITY_KEY),
      set: (value) => SecureStorage.setItem(IDENTITY_KEY, value),
      remove: () => SecureStorage.removeItem(IDENTITY_KEY),
    }
  }
  return {
    get: () => Promise.resolve(localStorage.getItem(IDENTITY_KEY)),
    set: (value) => {
      localStorage.setItem(IDENTITY_KEY, value)
      return Promise.resolve()
    },
    remove: () => {
      localStorage.removeItem(IDENTITY_KEY)
      return Promise.resolve()
    },
  }
}

// One read at a time: two first-launch callers must not each mint a key.
let loading: Promise<Identity> | null = null

export function loadOrCreateIdentity(): Promise<Identity> {
  loading ??= (async () => {
    const secrets = store()
    const existing = parseIdentity(await secrets.get())
    if (existing) return existing
    const fresh = generateIdentity()
    await secrets.set(serializeIdentity(fresh))
    return fresh
  })()
  return loading
}

export async function forgetIdentity(): Promise<void> {
  loading = null
  await store().remove()
}

export function identityIsDevOnly(): boolean {
  return identityBackend(Capacitor.isNativePlatform()) === 'local'
}
```

Create `web/src/mobile/platform/pairing.ts`:

```ts
import { Preferences } from '@capacitor/preferences'
import { parsePairing, type Pairing } from './parse'

export const PAIRING_KEY = 'orbital.pairing'
/** Set when the Mac revoked this phone: 9h shows on every launch until a new pairing (spec § 4). Holds the Mac's name for 9h's copy. */
export const UNPAIRED_KEY = 'orbital.unpaired'

export async function loadPairing(): Promise<Pairing | null> {
  const { value } = await Preferences.get({ key: PAIRING_KEY })
  return parsePairing(value)
}

export function savePairing(pairing: Pairing): Promise<void> {
  return Preferences.set({ key: PAIRING_KEY, value: JSON.stringify(pairing) })
}

export function clearPairing(): Promise<void> {
  return Preferences.remove({ key: PAIRING_KEY })
}

export async function loadUnpaired(): Promise<{ macName: string } | null> {
  const { value } = await Preferences.get({ key: UNPAIRED_KEY })
  return value === null ? null : { macName: value }
}

export function setUnpaired(macName: string): Promise<void> {
  return Preferences.set({ key: UNPAIRED_KEY, value: macName })
}

export function clearUnpaired(): Promise<void> {
  return Preferences.remove({ key: UNPAIRED_KEY })
}
```

Create `web/src/mobile/platform/cache.ts`:

```ts
import { Preferences } from '@capacitor/preferences'
import type { NotificationSettings } from '@orbital/shared/remote/messages'
import type { ChatMessage } from '../../lib/types'
import {
  acceptMessages, acceptNotifications, acceptSessions, parseCached, type Cached, type SessionsSnapshot,
} from './parse'

/**
 * What the phone shows while its Mac is away, each with when it was fresh
 * (spec § 4): the last session list, the last page of each opened
 * transcript, the notification rules as last read. Cleared with the pairing.
 */
export const CACHE_PREFIX = 'orbital.cache.'
const SESSIONS_KEY = `${CACHE_PREFIX}sessions`
const NOTIFICATIONS_KEY = `${CACHE_PREFIX}notifications`
const transcriptKey = (id: string): string => `${CACHE_PREFIX}transcript:${id}`

async function read<T>(key: string, accept: (value: unknown) => T | null): Promise<Cached<T> | null> {
  const { value } = await Preferences.get({ key })
  return parseCached(value, accept)
}

function write(key: string, value: unknown, asOf: number): Promise<void> {
  return Preferences.set({ key, value: JSON.stringify({ asOf, value }) })
}

export function readSessionsCache(): Promise<Cached<SessionsSnapshot> | null> {
  return read(SESSIONS_KEY, acceptSessions)
}

export function writeSessionsCache(value: SessionsSnapshot, asOf: number): Promise<void> {
  return write(SESSIONS_KEY, value, asOf)
}

export function readTranscriptCache(id: string): Promise<Cached<ChatMessage[]> | null> {
  return read(transcriptKey(id), acceptMessages)
}

export function writeTranscriptCache(id: string, messages: ChatMessage[], asOf: number): Promise<void> {
  return write(transcriptKey(id), messages, asOf)
}

export function readNotificationsCache(): Promise<Cached<NotificationSettings> | null> {
  return read(NOTIFICATIONS_KEY, acceptNotifications)
}

export function writeNotificationsCache(settings: NotificationSettings, asOf: number): Promise<void> {
  return write(NOTIFICATIONS_KEY, settings, asOf)
}

export async function clearCaches(): Promise<void> {
  const { keys } = await Preferences.keys()
  await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => Preferences.remove({ key })))
}
```

Create `web/src/mobile/platform/imageCache.ts`:

```ts
import { Directory, Filesystem } from '@capacitor/filesystem'
import { base64ToBytes, bytesToBase64 } from './base64'

/**
 * Transcript images by ref (spec § 3). Refs are content hashes, so an entry
 * never goes stale and nothing here expires; "Pair a different Mac" and an
 * unpairing clear it, and the OS may evict the Cache directory on its own.
 */
const IMAGES_DIR = 'images'

export async function readCachedImage(ref: string): Promise<Uint8Array | null> {
  try {
    const { data } = await Filesystem.readFile({ path: `${IMAGES_DIR}/${ref}`, directory: Directory.Cache })
    return typeof data === 'string' ? base64ToBytes(data) : new Uint8Array(await data.arrayBuffer())
  } catch {
    return null
  }
}

export async function writeCachedImage(ref: string, bytes: Uint8Array): Promise<void> {
  await Filesystem.writeFile({
    path: `${IMAGES_DIR}/${ref}`,
    data: bytesToBase64(bytes),
    directory: Directory.Cache,
    recursive: true,
  })
}

export async function clearImageCache(): Promise<void> {
  try {
    await Filesystem.rmdir({ path: IMAGES_DIR, directory: Directory.Cache, recursive: true })
  } catch {
    // Nothing cached yet.
  }
}
```

Create `web/src/mobile/platform/device.ts`:

```ts
import { Capacitor } from '@capacitor/core'
import { Device } from '@capacitor/device'
import { deviceName } from './parse'

/** What the Mac's confirm dialog and its device list call this phone (9e, 9o). */
export async function thisDevice(): Promise<{ name: string; platform: string }> {
  let info: { model?: string } | null = null
  try {
    info = await Device.getInfo()
  } catch {
    info = null
  }
  return { name: deviceName(info), platform: Capacitor.getPlatform() }
}
```

- [ ] **Step 8: Typecheck, test, lint**

Run: `npm run typecheck -w @orbital/web && npm run test:run -w @orbital/web -- src/test/mobileplatform.test.ts && npx eslint web/src/mobile shared/src/remote/handshake.ts`
Expected: no errors; PASS.

- [ ] **Step 9: Commit**

```bash
git add web/package.json package-lock.json shared/src/remote/handshake.ts web/src/mobile/platform web/src/test/mobileplatform.test.ts
git commit -m "feat(mobile): identity, pairing and cache storage for the phone"
```

---

### Task 7: Tunnel adapters — `ClientRef`, `tunnelFetch`, `TunnelSocket`, image resolver

**Files:**
- Create: `web/src/mobile/transport/clientRef.ts`, `tunnelFetch.ts`, `tunnelSocket.ts`, `imageResolver.ts`
- Create: `web/src/test/fakeRemoteClient.ts`
- Test: `web/src/test/mobiletransport.test.ts`

**Interfaces:**
- Consumes: Task 1 (`RemoteClient`, `RemoteClientEvent`, `TunnelError`, `HttpMethod`, `TunnelResponse`, `BlobResult` from `@orbital/shared/remote/client`; `NotificationSettings` from `@orbital/shared/remote/messages`); Task 3 (`FetchLike` shape; `OrbitalSocket` from `web/src/lib/ws.ts` drives `TunnelSocket`).
- Produces:
  - `transport/clientRef.ts`: `type SwappableClient = Pick<RemoteClient, 'ready' | 'on' | 'stop' | 'request' | 'getBlob' | 'subscribe' | 'unsubscribe' | 'getNotifications' | 'setNotifications' | 'seen' | 'recheck'>`, `type TunnelClient = Pick<SwappableClient, 'ready' | 'on' | 'request' | 'getBlob' | 'subscribe' | 'unsubscribe'>`, `class ClientRef implements SwappableClient` with `get client(): SwappableClient | null`, `set(client: SwappableClient | null): void`, and every `SwappableClient` method (`stop()` stops the current client); `const clientRef: ClientRef`
  - `transport/tunnelFetch.ts`: `tunnelPath(input: string, origin: string): string | null`, `toResponse(status: number, body: unknown): Response`, `makeTunnelFetch(client: Pick<TunnelClient, 'request'>, origin?: string): (input: string, init?: RequestInit) => Promise<Response>`
  - `transport/tunnelSocket.ts`: `class TunnelSocket` (constructor `(client: Pick<TunnelClient, 'ready' | 'on' | 'subscribe' | 'unsubscribe'>)`; statics `CONNECTING = 0`, `OPEN = 1`, `CLOSED = 3`; `readyState`, `onopen`, `onmessage`, `onclose`, `onerror`, `send(data: string)`, `close()`)
  - `transport/imageResolver.ts`: `interface ImageStoreIO { read(ref: string): Promise<Uint8Array | null>; write(ref: string, bytes: Uint8Array): Promise<void> }`, `mediaTypeOf(ref: string): string`, `makeImageResolver(client: Pick<TunnelClient, 'getBlob'>, io: ImageStoreIO, toUrl?: (bytes: Uint8Array, mediaType: string) => string): (ref: string) => string | Promise<string>`
  - `web/src/test/fakeRemoteClient.ts`: `class FakeClient implements SwappableClient` with `vi.fn` methods and `emit(event: RemoteClientEvent): void`

- [ ] **Step 1: Write the test double**

Create `web/src/test/fakeRemoteClient.ts`:

```ts
import { vi } from 'vitest'
import type { BlobResult, RemoteClientEvent, TunnelResponse } from '@orbital/shared/remote/client'
import type { NotificationSettings } from '@orbital/shared/remote/messages'
import type { SwappableClient } from '../mobile/transport/clientRef'

const RULES: NotificationSettings = {
  needsInput: true, sessionEnded: true, sessionFailed: true, onlyWhenBackground: true, sound: true,
}

/**
 * The client's surface with nothing behind it: tests drive it with `emit`
 * and stub its calls. The real client is covered against the real Mac
 * (server/test/remoteClient.test.ts); this layer only has to be wired right.
 */
export class FakeClient implements SwappableClient {
  ready = false
  private readonly listeners = new Set<(event: RemoteClientEvent) => void>()
  readonly stop = vi.fn(() => {})
  readonly request = vi.fn(
    async (_method: string, _path: string, _body?: unknown): Promise<TunnelResponse> => ({ status: 200, body: {} }),
  )
  readonly getBlob = vi.fn(
    async (_ref: string): Promise<BlobResult> => ({ status: 404, bytes: new Uint8Array(0), mediaType: null }),
  )
  readonly subscribe = vi.fn((_topic: string) => {})
  readonly unsubscribe = vi.fn((_topic: string) => {})
  readonly getNotifications = vi.fn(async (): Promise<NotificationSettings> => RULES)
  readonly setNotifications = vi.fn(async (settings: NotificationSettings): Promise<NotificationSettings> => settings)
  readonly seen = vi.fn((_sessionId: string) => {})
  readonly recheck = vi.fn(async (_windowMs: number): Promise<boolean> => true)

  on(listener: (event: RemoteClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: RemoteClientEvent): void {
    if (event.type === 'ready') this.ready = event.ready
    for (const listener of [...this.listeners]) listener(event)
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `web/src/test/mobiletransport.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { TunnelError, type RemoteClientEvent } from '@orbital/shared/remote/client'
import { OrbitalSocket } from '../lib/ws'
import { ClientRef } from '../mobile/transport/clientRef'
import { makeImageResolver, mediaTypeOf } from '../mobile/transport/imageResolver'
import { makeTunnelFetch } from '../mobile/transport/tunnelFetch'
import { TunnelSocket } from '../mobile/transport/tunnelSocket'
import { FakeClient } from './fakeRemoteClient'

const ORIGIN = 'https://localhost'

describe('tunnelFetch', () => {
  it('sends a relative /api path and its query as the Mac routes them', async () => {
    const client = new FakeClient()
    client.request.mockResolvedValueOnce({ status: 200, body: { sessions: [] } })
    const res = await makeTunnelFetch(client, ORIGIN)('/api/sessions?limit=30')
    expect(client.request).toHaveBeenCalledWith('GET', '/api/sessions?limit=30', undefined)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ sessions: [] })
  })

  it("strips this page's origin, upper-cases the method and parses a JSON body", async () => {
    const client = new FakeClient()
    await makeTunnelFetch(client, ORIGIN)(`${ORIGIN}/api/sessions/s1/pinned`, {
      method: 'put', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true }),
    })
    expect(client.request).toHaveBeenCalledWith('PUT', '/api/sessions/s1/pinned', { pinned: true })
  })

  it('hands a 413 and a 403 back as ordinary statuses with their bodies', async () => {
    const client = new FakeClient()
    client.request.mockResolvedValueOnce({ status: 413, body: { error: 'too_large' } })
    client.request.mockResolvedValueOnce({ status: 403, body: { error: 'not_allowed' } })
    const f = makeTunnelFetch(client, ORIGIN)
    const big = await f('/api/sessions/s1/messages?limit=30')
    expect(big.ok).toBe(false)
    expect(big.status).toBe(413)
    await expect(big.text()).resolves.toBe('{"error":"too_large"}')
    expect((await f('/api/settings')).status).toBe(403)
  })

  it('answers a 204 with no body', async () => {
    const client = new FakeClient()
    client.request.mockResolvedValueOnce({ status: 204, body: '' })
    const res = await makeTunnelFetch(client, ORIGIN)('/api/sessions/s1/tasks/t1/stop', { method: 'POST' })
    expect(res.status).toBe(204)
    await expect(res.text()).resolves.toBe('')
  })

  it('fails as fetch does on a network error when the tunnel is down', async () => {
    const client = new FakeClient()
    client.request.mockRejectedValueOnce(new TunnelError('offline'))
    await expect(makeTunnelFetch(client, ORIGIN)('/api/sessions')).rejects.toBeInstanceOf(TypeError)
  })

  it('refuses what it cannot carry: another origin, a path outside /api, a multipart body', async () => {
    const client = new FakeClient()
    const f = makeTunnelFetch(client, ORIGIN)
    await expect(f('https://elsewhere.test/api/sessions')).rejects.toBeInstanceOf(TypeError)
    await expect(f('/health')).rejects.toBeInstanceOf(TypeError)
    await expect(f('/api/attachments', { method: 'POST', body: new FormData() })).rejects.toBeInstanceOf(TypeError)
    expect(client.request).not.toHaveBeenCalled()
  })
})

describe('TunnelSocket', () => {
  it('opens only once the tunnel is ready, and closes when it goes', async () => {
    const client = new FakeClient()
    const socket = new TunnelSocket(client)
    const onopen = vi.fn()
    const onclose = vi.fn()
    socket.onopen = onopen
    socket.onclose = onclose
    await Promise.resolve()
    expect(socket.readyState).toBe(TunnelSocket.CONNECTING)
    client.emit({ type: 'ready', ready: true })
    expect(socket.readyState).toBe(TunnelSocket.OPEN)
    expect(onopen).toHaveBeenCalledOnce()
    client.emit({ type: 'ready', ready: false })
    expect(socket.readyState).toBe(TunnelSocket.CLOSED)
    expect(onclose).toHaveBeenCalledOnce()
    client.emit({ type: 'ready', ready: true })
    expect(onopen).toHaveBeenCalledOnce()
  })

  it('opens on the next microtask when the tunnel is already up', async () => {
    const client = new FakeClient()
    client.ready = true
    const socket = new TunnelSocket(client)
    const onopen = vi.fn()
    socket.onopen = onopen
    await Promise.resolve()
    expect(onopen).toHaveBeenCalledOnce()
  })

  it('turns subscribe frames into client calls and hub events into messages', () => {
    const client = new FakeClient()
    const socket = new TunnelSocket(client)
    const onmessage = vi.fn()
    socket.onmessage = onmessage
    client.emit({ type: 'ready', ready: true })
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'session:s1' }))
    socket.send(JSON.stringify({ type: 'unsubscribe', topic: 'session:s1' }))
    expect(client.subscribe).toHaveBeenCalledWith('session:s1')
    expect(client.unsubscribe).toHaveBeenCalledWith('session:s1')
    client.emit({ type: 'hub', frame: { topic: 'sessions', event: 'upsert' } })
    expect(JSON.parse((onmessage.mock.calls[0][0] as MessageEvent).data as string)).toEqual({ topic: 'sessions', event: 'upsert' })
  })

  it("carries OrbitalSocket's subscriptions and frames", async () => {
    const client = new FakeClient()
    client.ready = true
    const socket = new OrbitalSocket('/ws', { WebSocketImpl: () => new TunnelSocket(client) as unknown as WebSocket })
    const handler = vi.fn()
    socket.subscribe('sessions', handler)
    await vi.waitFor(() => expect(socket.status).toBe('open'))
    expect(client.subscribe).toHaveBeenCalledWith('sessions')
    client.emit({ type: 'hub', frame: { topic: 'sessions', event: 'upsert' } })
    expect(handler).toHaveBeenCalledWith({ topic: 'sessions', event: 'upsert' })
    socket.close()
  })
})

describe('makeImageResolver', () => {
  const REF = `${'c'.repeat(64)}.png`
  const toUrl = (bytes: Uint8Array, type: string) => `blob:${type}:${bytes.length}`

  it('serves a cached image without asking the Mac, then synchronously', async () => {
    const client = new FakeClient()
    const io = { read: vi.fn(async () => new Uint8Array([1])), write: vi.fn(async () => {}) }
    const resolve = makeImageResolver(client, io, toUrl)
    await expect(resolve(REF)).resolves.toBe('blob:image/png:1')
    expect(client.getBlob).not.toHaveBeenCalled()
    expect(resolve(REF)).toBe('blob:image/png:1')
  })

  it('fetches a missing image once over the tunnel, however often it is asked, and caches it', async () => {
    const client = new FakeClient()
    client.getBlob.mockResolvedValue({ status: 200, bytes: new Uint8Array([1, 2]), mediaType: 'image/png' })
    const io = { read: vi.fn(async () => null), write: vi.fn(async () => {}) }
    const resolve = makeImageResolver(client, io, toUrl)
    const [a, b] = await Promise.all([resolve(REF), resolve(REF)])
    expect(a).toBe('blob:image/png:2')
    expect(b).toBe(a)
    expect(client.getBlob).toHaveBeenCalledTimes(1)
    expect(io.write).toHaveBeenCalledWith(REF, new Uint8Array([1, 2]))
  })

  it('rejects when the Mac has no such image, and asks again next time', async () => {
    const client = new FakeClient()
    const io = { read: vi.fn(async () => null), write: vi.fn(async () => {}) }
    const resolve = makeImageResolver(client, io, toUrl)
    await expect(resolve(REF)).rejects.toThrow('404')
    await expect(resolve(REF)).rejects.toThrow('404')
    expect(client.getBlob).toHaveBeenCalledTimes(2)
  })

  it('names the media type from the ref', () => {
    expect(mediaTypeOf(`${'d'.repeat(64)}.jpg`)).toBe('image/jpeg')
    expect(mediaTypeOf('x.bin')).toBe('application/octet-stream')
  })
})

describe('ClientRef', () => {
  it("forwards the current client's events, and a ready client replaced reads as the tunnel going", () => {
    const ref = new ClientRef()
    const events: RemoteClientEvent[] = []
    ref.on((e) => events.push(e))
    const first = new FakeClient()
    first.ready = true
    ref.set(first)
    expect(ref.ready).toBe(true)
    first.emit({ type: 'hub', frame: 1 })
    expect(events).toContainEqual({ type: 'hub', frame: 1 })
    ref.set(new FakeClient())
    expect(first.stop).toHaveBeenCalledOnce()
    expect(events).toContainEqual({ type: 'ready', ready: false })
    first.emit({ type: 'hub', frame: 2 })
    expect(events).not.toContainEqual({ type: 'hub', frame: 2 })
  })

  it('answers offline with no client behind it', async () => {
    const ref = new ClientRef()
    await expect(ref.request('GET', '/api/sessions')).rejects.toMatchObject({ reason: 'offline' })
    await expect(ref.recheck(10)).resolves.toBe(false)
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm run test:run -w @orbital/web -- src/test/mobiletransport.test.ts`
Expected: FAIL — `../mobile/transport/clientRef` does not exist.

- [ ] **Step 4: Write `ClientRef`**

Create `web/src/mobile/transport/clientRef.ts`:

```ts
import {
  TunnelError, type BlobResult, type HttpMethod, type RemoteClient, type RemoteClientEvent, type TunnelResponse,
} from '@orbital/shared/remote/client'
import type { NotificationSettings } from '@orbital/shared/remote/messages'

/** What the app calls on a client once it exists; `start`, `redeem` and `waitForPairing` stay with whoever made it. */
export type SwappableClient = Pick<
  RemoteClient,
  'ready' | 'on' | 'stop' | 'request' | 'getBlob' | 'subscribe' | 'unsubscribe' | 'getNotifications' | 'setNotifications' | 'seen' | 'recheck'
>

/** The part the three seams use. */
export type TunnelClient = Pick<SwappableClient, 'ready' | 'on' | 'request' | 'getBlob' | 'subscribe' | 'unsubscribe'>

/**
 * The one client the app talks to, swappable: pairing a different Mac
 * replaces the `RemoteClient` underneath, and the seams configured once at
 * boot (`tunnelFetch`, `TunnelSocket`, the image resolver) keep working
 * because they hold this, not the client.
 */
export class ClientRef implements SwappableClient {
  private current: SwappableClient | null = null
  private detach: (() => void) | null = null
  private readonly listeners = new Set<(event: RemoteClientEvent) => void>()

  get client(): SwappableClient | null {
    return this.current
  }

  get ready(): boolean {
    return this.current?.ready ?? false
  }

  /** Stops the previous client; a tunnel that was up reads as gone to every listener. */
  set(client: SwappableClient | null): void {
    const previous = this.current
    if (previous === client) return
    const wasReady = previous?.ready ?? false
    this.detach?.()
    this.detach = null
    this.current = client
    previous?.stop()
    if (wasReady) this.emit({ type: 'ready', ready: false })
    if (client) this.detach = client.on((event) => this.emit(event))
  }

  on(listener: (event: RemoteClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  stop(): void {
    this.current?.stop()
  }

  request(method: HttpMethod, path: string, body?: unknown): Promise<TunnelResponse> {
    return this.current ? this.current.request(method, path, body) : Promise.reject(new TunnelError('offline'))
  }

  getBlob(ref: string): Promise<BlobResult> {
    return this.current ? this.current.getBlob(ref) : Promise.reject(new TunnelError('offline'))
  }

  subscribe(topic: string): void {
    this.current?.subscribe(topic)
  }

  unsubscribe(topic: string): void {
    this.current?.unsubscribe(topic)
  }

  getNotifications(): Promise<NotificationSettings> {
    return this.current ? this.current.getNotifications() : Promise.reject(new TunnelError('offline'))
  }

  setNotifications(settings: NotificationSettings): Promise<NotificationSettings> {
    return this.current ? this.current.setNotifications(settings) : Promise.reject(new TunnelError('offline'))
  }

  seen(sessionId: string): void {
    this.current?.seen(sessionId)
  }

  recheck(windowMs: number): Promise<boolean> {
    return this.current ? this.current.recheck(windowMs) : Promise.resolve(false)
  }

  private emit(event: RemoteClientEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (err) {
        console.warn('orbital: a client listener failed', err)
      }
    }
  }
}

export const clientRef = new ClientRef()
```

- [ ] **Step 5: Write `tunnelFetch`**

Create `web/src/mobile/transport/tunnelFetch.ts`:

```ts
import { TunnelError, type HttpMethod } from '@orbital/shared/remote/client'
import type { TunnelClient } from './clientRef'

const METHODS: ReadonlySet<string> = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * `/api/...` as the Mac's router sees it — path and query, nothing else —
 * or null for anything that is not this page's API. `api.ts` builds some
 * URLs on `window.location.origin` and passes others relative; both land here.
 */
export function tunnelPath(input: string, origin: string): string | null {
  let url: URL
  try {
    url = new URL(input, origin)
  } catch {
    return null
  }
  if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/api/')) return null
  return url.pathname + url.search
}

/**
 * The Mac's `http_res` as a `Response`: a 413 or 403 is an ordinary status
 * (spec § 3), JSON bodies travel as JSON, a non-JSON answer as the text the
 * Mac sent. A status `Response` cannot carry reads as a bad gateway.
 */
export function toResponse(status: number, body: unknown): Response {
  if (status === 204 || status === 205 || status === 304) return new Response(null, { status })
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null)
  const contentType = typeof body === 'string' ? 'text/plain' : 'application/json'
  return new Response(text, {
    status: status >= 200 && status <= 599 ? status : 502,
    headers: { 'content-type': contentType },
  })
}

/**
 * `api.ts`'s transport on the phone (`configureApi`). A failure to deliver
 * rejects with a `TypeError`, exactly as `fetch` does on a network error,
 * so every caller's existing handling applies unchanged. Multipart bodies
 * are refused: 2b sends photos as blobs (spec § 3).
 */
export function makeTunnelFetch(
  client: Pick<TunnelClient, 'request'>,
  origin: string = window.location.origin,
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const path = tunnelPath(input, origin)
    if (path === null) throw new TypeError(`not tunnelled: ${input}`)
    const method = (init.method ?? 'GET').toUpperCase()
    if (!METHODS.has(method)) throw new TypeError(`method not tunnelled: ${method}`)
    let body: unknown
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== 'string') throw new TypeError('only JSON bodies are tunnelled')
      try {
        body = JSON.parse(init.body)
      } catch {
        throw new TypeError('only JSON bodies are tunnelled')
      }
    }
    let answer
    try {
      answer = await client.request(method as HttpMethod, path, body)
    } catch (err) {
      throw new TypeError(err instanceof TunnelError ? `tunnel ${err.reason}` : 'tunnel failed')
    }
    return toResponse(answer.status, answer.body)
  }
}
```

- [ ] **Step 6: Write `TunnelSocket`**

Create `web/src/mobile/transport/tunnelSocket.ts`:

```ts
import type { RemoteClientEvent } from '@orbital/shared/remote/client'
import type { TunnelClient } from './clientRef'

/**
 * The WebSocket surface `OrbitalSocket` drives (`lib/ws.ts`), over the
 * tunnel (spec § 3): open exactly while the client has a cipher and the
 * Mac's hello; a subscribe or unsubscribe it is sent becomes the client's
 * own; every hub frame comes back as a message. `OrbitalSocket`'s reconnect
 * and heartbeat watchdog stay as they are — the tunnel's liveness reaches
 * them as open and close.
 */
export class TunnelSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readyState: number = TunnelSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((event: Event) => void) | null = null
  private detach: (() => void) | null
  private readonly client: Pick<TunnelClient, 'ready' | 'on' | 'subscribe' | 'unsubscribe'>

  constructor(client: Pick<TunnelClient, 'ready' | 'on' | 'subscribe' | 'unsubscribe'>) {
    this.client = client
    this.detach = client.on((event) => this.onEvent(event))
    // Never inside the constructor: `OrbitalSocket` assigns its handlers after constructing.
    if (client.ready) queueMicrotask(() => this.open())
  }

  send(data: string): void {
    if (this.readyState !== TunnelSocket.OPEN) return
    let msg: { type?: unknown; topic?: unknown }
    try {
      msg = JSON.parse(data) as { type?: unknown; topic?: unknown }
    } catch {
      return
    }
    if (typeof msg.topic !== 'string') return
    if (msg.type === 'subscribe') this.client.subscribe(msg.topic)
    else if (msg.type === 'unsubscribe') this.client.unsubscribe(msg.topic)
  }

  /** As a real socket does, `onclose` follows asynchronously. */
  close(): void {
    if (this.readyState === TunnelSocket.CLOSED) return
    this.readyState = TunnelSocket.CLOSED
    this.detach?.()
    this.detach = null
    queueMicrotask(() => this.onclose?.())
  }

  private onEvent(event: RemoteClientEvent): void {
    if (event.type === 'ready') {
      if (event.ready) this.open()
      else this.shut()
      return
    }
    if (event.type === 'hub' && this.readyState === TunnelSocket.OPEN) {
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event.frame) }))
    }
  }

  private open(): void {
    if (this.readyState !== TunnelSocket.CONNECTING || !this.client.ready) return
    this.readyState = TunnelSocket.OPEN
    this.onopen?.()
  }

  private shut(): void {
    if (this.readyState === TunnelSocket.CLOSED) return
    this.readyState = TunnelSocket.CLOSED
    this.detach?.()
    this.detach = null
    this.onclose?.()
  }
}
```

- [ ] **Step 7: Write the image resolver**

Create `web/src/mobile/transport/imageResolver.ts`:

```ts
import type { TunnelClient } from './clientRef'

export interface ImageStoreIO {
  read(ref: string): Promise<Uint8Array | null>
  write(ref: string, bytes: Uint8Array): Promise<void>
}

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
}

/** The ref's extension is what names its type, as on the Mac (`server/src/images/store.ts`). */
export function mediaTypeOf(ref: string): string {
  return MEDIA_TYPES[ref.slice(ref.lastIndexOf('.') + 1)] ?? 'application/octet-stream'
}

function blobUrl(bytes: Uint8Array, mediaType: string): string {
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mediaType }))
}

/**
 * The phone's `configureImages` resolver (spec § 3): the file cache first,
 * the tunnel when it misses. A ref resolved once answers synchronously from
 * then on, and one in flight is shared, so a thumbnail and its lightbox
 * never fetch twice. A failure is not remembered: the next ask (9p's retry)
 * tries again.
 */
export function makeImageResolver(
  client: Pick<TunnelClient, 'getBlob'>,
  io: ImageStoreIO,
  toUrl: (bytes: Uint8Array, mediaType: string) => string = blobUrl,
): (ref: string) => string | Promise<string> {
  const urls = new Map<string, string>()
  const inflight = new Map<string, Promise<string>>()
  return (ref) => {
    const known = urls.get(ref)
    if (known) return known
    const running = inflight.get(ref)
    if (running) return running
    const loading = (async () => {
      let bytes = await io.read(ref)
      if (!bytes) {
        const answer = await client.getBlob(ref)
        if (answer.status !== 200) throw new Error(`image ${answer.status}`)
        bytes = answer.bytes
        // A cache write that fails costs a refetch next time, nothing more.
        await io.write(ref, bytes).catch(() => undefined)
      }
      const url = toUrl(bytes, mediaTypeOf(ref))
      urls.set(ref, url)
      return url
    })()
    inflight.set(ref, loading)
    void loading.then(
      () => inflight.delete(ref),
      () => inflight.delete(ref),
    )
    return loading
  }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run test:run -w @orbital/web -- src/test/mobiletransport.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 9: Typecheck and lint**

Run: `npm run typecheck -w @orbital/web && npx eslint web/src/mobile/transport web/src/test/mobiletransport.test.ts web/src/test/fakeRemoteClient.ts`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add web/src/mobile/transport web/src/test/mobiletransport.test.ts web/src/test/fakeRemoteClient.ts
git commit -m "feat(mobile): tunnel adapters for the API, the hub and images"
```

---

### Task 8: App state, version gate and boot

**Files:**
- Create: `web/src/mobile/constants.ts`, `version.ts`, `state.ts`, `connect.ts`, `forget.ts`, `boot.ts`, `screens/ScreenPending.tsx`
- Modify: `web/src/mobile/MobileApp.tsx` (the router), `web/src/mobile/main.tsx` (boot before render), `web/src/store/store.ts` (`seatSessions`, `loadSessions`)
- Test: `web/src/test/mobilestate.test.ts`, `web/src/test/mobilestore.test.ts`

**Interfaces:**
- Consumes: Task 1 (`RemoteClient`, `RemoteClientEvent`, `LinkStatus`), Task 3 (`configureApi`, `configureSocket`, `configureImages`, `getSocket`), Task 5 (`__MOBILE_VERSION__`), Task 6 (`loadPairing`, `loadUnpaired`, `setUnpaired`, `clearPairing`, `forgetIdentity`, `loadOrCreateIdentity`, `readSessionsCache`, `writeSessionsCache`, `writeTranscriptCache`, `clearCaches`, `readCachedImage`, `writeCachedImage`, `clearImageCache`, `Pairing`), Task 7 (`clientRef`, `makeTunnelFetch`, `TunnelSocket`, `makeImageResolver`); store actions `queueSessionsEvent`, `applyErrorsEvent`, `reloadTranscript`, `select`, and types `SessionsEvent`, `ErrorsEvent`.
- Produces:
  - `constants.ts`: `RETRY_WINDOW_MS`, `TRANSCRIPT_PAGE_SIZE`, `CACHE_WRITE_DEBOUNCE_MS`, `PAIRED_HELLO_WAIT_MS`, `CLOCK_TICK_MS`
  - `version.ts`: `MIN_SERVER_VERSION`, `compareVersions(a: string, b: string): number`, `isSupportedServer(version: string): boolean`
  - `state.ts`: `type Screen = 'pairing' | 'list' | 'session' | 'settings' | 'unpaired' | 'mismatch'`, `UNPAIRED_RELAY_ERRORS: ReadonlySet<string>`, `interface MobileState { screen; previous: Screen | null; sessionId: string | null; link: LinkStatus; macOnline: boolean; ready: boolean; asOf: number | null; checkedAt: number | null; mismatch: { macVersion: string | null; needed: string } | null; unpaired: boolean; pairing: Pairing | null; macName: string | null }`, `initialMobileState`, `isPairGone(event: RemoteClientEvent): boolean`, `reduce(state: MobileState, event: RemoteClientEvent, now: number): Partial<MobileState>`, `back(state: MobileState): Partial<MobileState> | 'exit'`, `useMobile` (zustand, with `apply(event)`, `go(screen)`, `openSession(id)`, `goBack(): 'exit' | 'stayed'`)
  - `connect.ts`: `mobileApp(): string`, `newClient(relayUrl: string, mac: string, identity: Identity): RemoteClient`, `connect(pairing: Pairing): Promise<RemoteClient>`
  - `forget.ts`: `forgetEverything(opts: { unpaired: boolean }): Promise<void>`
  - `boot.ts`: `boot(): Promise<void>`, `resync(): Promise<void>`
  - store: `seatSessions(sessions: ApiSession[], tags: Tag[]): void`, `loadSessions(): Promise<void>`

- [ ] **Step 1: Write the failing state tests**

Create `web/src/test/mobilestate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MIN_SERVER_VERSION, compareVersions, isSupportedServer } from '../mobile/version'
import { back, initialMobileState, isPairGone, reduce, type MobileState } from '../mobile/state'

const NOW = 1_000
const state = (patch: Partial<MobileState> = {}): MobileState => ({ ...initialMobileState, ...patch })

describe('compareVersions', () => {
  it('compares dotted numbers numerically, a missing part as zero', () => {
    expect(compareVersions('0.17.10', '0.17.9')).toBe(1)
    expect(compareVersions('0.17', '0.17.0')).toBe(0)
    expect(compareVersions('0.16.9', '0.17.0')).toBe(-1)
  })

  it('ignores a pre-release suffix and counts dev as the newest', () => {
    expect(compareVersions('0.18.0-beta.1', '0.18.0')).toBe(0)
    expect(compareVersions('dev', '99.0.0')).toBe(1)
    expect(compareVersions('dev', 'dev')).toBe(0)
    expect(compareVersions('1.0.0', 'dev')).toBe(-1)
  })

  it('supports a Mac from MIN_SERVER_VERSION on', () => {
    expect(isSupportedServer(MIN_SERVER_VERSION)).toBe(true)
    expect(isSupportedServer('dev')).toBe(true)
    expect(isSupportedServer('0.0.1')).toBe(false)
    expect(isSupportedServer('')).toBe(false)
  })
})

describe('reduce', () => {
  it("tracks the relay link and the Mac's presence", () => {
    expect(reduce(state(), { type: 'status', status: 'connecting' }, NOW)).toEqual({ link: 'connecting' })
    expect(reduce(state(), { type: 'presence', macOnline: true }, NOW)).toEqual({ macOnline: true })
  })

  it('stamps asOf when the tunnel comes up and on every hub frame, not when it goes', () => {
    expect(reduce(state(), { type: 'ready', ready: true }, NOW)).toEqual({ ready: true, asOf: NOW })
    expect(reduce(state(), { type: 'hub', frame: {} }, NOW)).toEqual({ asOf: NOW })
    expect(reduce(state({ asOf: 5 }), { type: 'ready', ready: false }, NOW)).toEqual({ ready: false })
  })

  it('blocks the app behind 9i on a Mac older than MIN_SERVER_VERSION, naming both versions', () => {
    const next = reduce(state({ screen: 'list' }), { type: 'hello', server: '0.16.0', macName: 'studio' }, NOW)
    expect(next).toMatchObject({ screen: 'mismatch', mismatch: { macVersion: '0.16.0', needed: MIN_SERVER_VERSION } })
  })

  it('leaves 9i for the list once a hello is new enough', () => {
    const blocked = state({ screen: 'mismatch', mismatch: { macVersion: '0.16.0', needed: MIN_SERVER_VERSION } })
    expect(reduce(blocked, { type: 'hello', server: MIN_SERVER_VERSION, macName: 'studio' }, NOW)).toMatchObject({
      screen: 'list', mismatch: null, macName: 'studio',
    })
    expect(reduce(state({ screen: 'session' }), { type: 'hello', server: 'dev', macName: 'studio' }, NOW)).not.toHaveProperty('screen')
  })

  it('blocks the app on bye protocol, keeping a Mac version it already knew', () => {
    const known = state({ mismatch: { macVersion: '0.16.0', needed: MIN_SERVER_VERSION } })
    expect(reduce(known, { type: 'bye', reason: 'protocol' }, NOW)).toMatchObject({
      screen: 'mismatch', mismatch: { macVersion: '0.16.0' },
    })
    expect(reduce(state(), { type: 'bye', reason: 'protocol' }, NOW)).toMatchObject({ mismatch: { macVersion: null } })
  })

  it('goes to 9h on bye revoked, on the relay saying unpaired, and on a relay error that says the pair is gone', () => {
    for (const event of [
      { type: 'bye', reason: 'revoked' } as const,
      { type: 'unpaired' } as const,
      { type: 'relay_error', code: 'not_paired' } as const,
    ]) {
      expect(isPairGone(event)).toBe(true)
      expect(reduce(state({ screen: 'session', sessionId: 's1' }), event, NOW)).toMatchObject({
        screen: 'unpaired', unpaired: true, sessionId: null, pairing: null,
      })
    }
  })

  it('ignores a relay error that says nothing about the pair', () => {
    expect(isPairGone({ type: 'relay_error', code: 'bad_url' })).toBe(false)
    expect(reduce(state(), { type: 'relay_error', code: 'bad_url' }, NOW)).toEqual({})
  })
})

describe('back', () => {
  it('walks session and settings back to the list, and leaves the app from the list', () => {
    expect(back(state({ screen: 'session', sessionId: 's1' }))).toEqual({ screen: 'list', sessionId: null })
    expect(back(state({ screen: 'settings' }))).toEqual({ screen: 'list' })
    expect(back(state({ screen: 'list' }))).toBe('exit')
    expect(back(state({ screen: 'mismatch' }))).toBe('exit')
  })

  it('returns from pairing to where it came from, and stays when there is nowhere to go', () => {
    expect(back(state({ screen: 'pairing', previous: 'unpaired' }))).toEqual({ screen: 'unpaired', previous: null })
    expect(back(state({ screen: 'pairing', previous: null }))).toBe('exit')
  })
})
```

- [ ] **Step 2: Write the failing store tests**

Create `web/src/test/mobilestore.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import type { ApiSession, PendingDecision, Tag } from '../lib/types'
import { useOrbital } from '../store/store'

function session(id: string, lastAt: number, patch: Partial<ApiSession> = {}): ApiSession {
  return {
    id, cwd: `/w/${id}`, title: id, firstAt: lastAt, lastAt, messageCount: 1, source: 'web', permissionMode: null,
    model: null, resolvedModel: null, tagIds: [], status: 'idle', subagents: [], ...patch,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('seatSessions', () => {
  it('replaces the session list, newest first, with the decisions it carries', () => {
    const decision: PendingDecision = { id: 'd1', kind: 'permission', input: {}, createdAt: 1 }
    useOrbital.getState().seatSessions(
      [session('old', 1), session('new', 2, { status: 'needs_input', pendingDecision: decision })],
      [],
    )
    expect(useOrbital.getState().order).toEqual(['new', 'old'])
    expect(useOrbital.getState().pendingDecisions).toEqual({ new: decision })
    useOrbital.getState().seatSessions([session('only', 3)], [])
    expect(Object.keys(useOrbital.getState().sessions)).toEqual(['only'])
    expect(useOrbital.getState().pendingDecisions).toEqual({})
  })
})

describe('loadSessions', () => {
  it('reads only routes the tunnel allows', async () => {
    const tags: Tag[] = [{ id: 1, name: 'orbital', hue: 200, is_default: 1 }]
    vi.mocked(api.listSessions).mockResolvedValue([session('a', 1)])
    vi.mocked(api.listTags).mockResolvedValue(tags)
    vi.mocked(api.listModels).mockResolvedValue({ models: [], contextWindows: {} })
    await useOrbital.getState().loadSessions()
    expect(Object.keys(useOrbital.getState().sessions)).toEqual(['a'])
    expect(useOrbital.getState().tags).toEqual(tags)
    expect(api.getSettings).not.toHaveBeenCalled()
    expect(api.listTagRules).not.toHaveBeenCalled()
    expect(api.listErrors).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm run test:run -w @orbital/web -- src/test/mobilestate.test.ts src/test/mobilestore.test.ts`
Expected: FAIL — `../mobile/version` does not exist; `seatSessions` is not a function.

- [ ] **Step 4: Write the constants, the version gate and the state**

Create `web/src/mobile/constants.ts`:

```ts
/** 9a's Retry and 9i's Try again: one bounded presence check (spec 2026-10-02-mobile-app-design § 5). */
export const RETRY_WINDOW_MS = 5_000
/** Messages per transcript page on the phone (spec § 5, parent § 4): one page must fit one relay frame. */
export const TRANSCRIPT_PAGE_SIZE = 30
/** How long the cache waits for the store to settle before writing it out. */
export const CACHE_WRITE_DEBOUNCE_MS = 2_000
/** After `paired`, how long 9e waits for the Mac's hello before showing "Paired with" anyway. */
export const PAIRED_HELLO_WAIT_MS = 10_000
/** How often relative times on screen ("3m", "as of") are re-read. */
export const CLOCK_TICK_MS = 30_000
```

Create `web/src/mobile/version.ts`:

```ts
/**
 * The oldest Orbital on the Mac this phone works with (spec § 5, 9i): the
 * release that shipped Settings → Mobile, without which nothing pairs.
 */
export const MIN_SERVER_VERSION = '0.17.1'

/**
 * Dotted numbers, compared part by part; a missing part is zero and a
 * pre-release suffix (`-beta.1`) is ignored. `dev` — a server run from
 * source, which reports no version — is newer than any release.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] | null =>
    v.trim() === 'dev'
      ? null
      : v.trim().split('-')[0].split('.').map((part) => {
          const n = Number.parseInt(part, 10)
          return Number.isFinite(n) ? n : 0
        })
  const pa = parse(a)
  const pb = parse(b)
  if (pa === null || pb === null) return pa === pb ? 0 : pa === null ? 1 : -1
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

export function isSupportedServer(version: string): boolean {
  return compareVersions(version, MIN_SERVER_VERSION) >= 0
}
```

Create `web/src/mobile/state.ts`:

```ts
import { create } from 'zustand'
import type { LinkStatus, RemoteClientEvent } from '@orbital/shared/remote/client'
import type { Pairing } from './platform/parse'
import { MIN_SERVER_VERSION, isSupportedServer } from './version'

/** Navigation is in-memory state, not URLs (spec § 5). */
export type Screen = 'pairing' | 'list' | 'session' | 'settings' | 'unpaired' | 'mismatch'

/**
 * Relay `error` codes that mean this phone's pair no longer exists (spec
 * § 4). The relay sends none of them today; this is where one goes when it
 * does, and anything else is not about the pair.
 */
export const UNPAIRED_RELAY_ERRORS: ReadonlySet<string> = new Set(['not_paired', 'unknown_device'])

export interface MobileState {
  screen: Screen
  /** Where 9e's Cancel and the back button return to from pairing. */
  previous: Screen | null
  sessionId: string | null
  /** The relay link (9a header: `connecting` is the dim dot). */
  link: LinkStatus
  macOnline: boolean
  /** A live tunnel: cipher and the Mac's hello. */
  ready: boolean
  /** When live data last arrived; what the offline card's "as of" reads. */
  asOf: number | null
  /** When the last Retry or foreground check finished ("checked just now"). */
  checkedAt: number | null
  mismatch: { macVersion: string | null; needed: string } | null
  unpaired: boolean
  pairing: Pairing | null
  macName: string | null
}

export const initialMobileState: MobileState = {
  screen: 'pairing', previous: null, sessionId: null, link: 'off', macOnline: false, ready: false,
  asOf: null, checkedAt: null, mismatch: null, unpaired: false, pairing: null, macName: null,
}

/** The pair is over, by the Mac's hand or the relay's word (spec § 4). */
export function isPairGone(event: RemoteClientEvent): boolean {
  return (
    (event.type === 'bye' && event.reason === 'revoked') ||
    event.type === 'unpaired' ||
    (event.type === 'relay_error' && UNPAIRED_RELAY_ERRORS.has(event.code))
  )
}

/** What one client event changes (spec § 5: offline, 9h, 9i). Pure; `useMobile.apply` writes it. */
export function reduce(state: MobileState, event: RemoteClientEvent, now: number): Partial<MobileState> {
  if (isPairGone(event)) {
    return { screen: 'unpaired', unpaired: true, sessionId: null, pairing: null, ready: false }
  }
  switch (event.type) {
    case 'status':
      return { link: event.status }
    case 'presence':
      return { macOnline: event.macOnline }
    case 'ready':
      return event.ready ? { ready: true, asOf: now } : { ready: false }
    case 'hub':
      return { asOf: now }
    case 'hello':
      if (!isSupportedServer(event.server)) {
        return {
          screen: 'mismatch', macName: event.macName,
          mismatch: { macVersion: event.server, needed: MIN_SERVER_VERSION },
        }
      }
      return { mismatch: null, macName: event.macName, ...(state.screen === 'mismatch' ? { screen: 'list' as const } : {}) }
    case 'bye':
      // The Mac refused our protocol version; it says no more than that.
      return {
        screen: 'mismatch',
        mismatch: { macVersion: state.mismatch?.macVersion ?? null, needed: MIN_SERVER_VERSION },
      }
    default:
      return {}
  }
}

/** The hardware back button (spec § 5): one level up; from the list, out of the app. */
export function back(state: MobileState): Partial<MobileState> | 'exit' {
  switch (state.screen) {
    case 'session':
      return { screen: 'list', sessionId: null }
    case 'settings':
      return { screen: 'list' }
    case 'pairing':
      return state.previous ? { screen: state.previous, previous: null } : 'exit'
    default:
      return 'exit'
  }
}

interface MobileActions {
  apply(event: RemoteClientEvent): void
  go(screen: Screen): void
  openSession(id: string): void
  goBack(): 'exit' | 'stayed'
}

export const useMobile = create<MobileState & MobileActions>()((set, get) => ({
  ...initialMobileState,
  apply: (event) => set(reduce(get(), event, Date.now())),
  go: (screen) => set((s) => ({ screen, previous: s.screen })),
  openSession: (id) => set({ screen: 'session', sessionId: id }),
  goBack: () => {
    const next = back(get())
    if (next === 'exit') return 'exit'
    set(next)
    return 'stayed'
  },
}))
```

- [ ] **Step 5: Add `seatSessions` and `loadSessions` to the store**

In `web/src/store/store.ts`, in `interface OrbitalActions`, directly after `loadInitial(): Promise<void>`, add:

```ts
  /**
   * Seats a full session list as the authoritative snapshot — what
   * `loadInitial` does with its sessions — for a caller that has only the
   * list and the tags: the phone, from its cache or over the tunnel, where
   * `loadInitial`'s settings, rules and errors routes are not allowed (spec
   * 2026-10-02-mobile-app-design § 3).
   */
  seatSessions(sessions: ApiSession[], tags: Tag[]): void
  /** The phone's `loadInitial`: sessions, tags and the model catalog, each a route the tunnel allows. */
  loadSessions(): Promise<void>
```

In the store object, directly after the `async loadInitial() { … },` method, add:

```ts
  seatSessions(list, tags) {
    const sessionsMap: Record<string, ApiSession> = {}
    const pendingDecisions: Record<string, PendingDecision> = {}
    for (const session of list) {
      sessionsMap[session.id] = session
      if (session.pendingDecision) pendingDecisions[session.id] = session.pendingDecision
    }
    // As in `loadInitial`: anything queued goes in first, the snapshot over it.
    flushSessionsEvents()
    set({ sessions: sessionsMap, order: sortIdsByLastAtDesc(sessionsMap), pendingDecisions, tags })
  },

  async loadSessions() {
    const [list, tags, modelsPayload] = await Promise.all([
      api.listSessions(),
      api.listTags(),
      api.listModels().catch(() => ({ models: [] as OrbitalModel[], contextWindows: {} })),
    ])
    get().seatSessions(list, tags)
    set({ models: modelsPayload.models, contextWindows: modelsPayload.contextWindows })
  },
```

(`ApiSession`, `PendingDecision`, `Tag` and `OrbitalModel` are already in the file's type import from `../lib/types`.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test:run -w @orbital/web -- src/test/mobilestate.test.ts src/test/mobilestore.test.ts src/test/store.test.ts`
Expected: PASS (the existing store suite unchanged).

- [ ] **Step 7: Write the wiring**

Create `web/src/mobile/connect.ts`:

```ts
import { RemoteClient } from '@orbital/shared/remote/client'
import type { Identity } from '@orbital/shared/remote/keys'
import { loadOrCreateIdentity } from './platform/identity'
import type { Pairing } from './platform/parse'
import { clientRef } from './transport/clientRef'

/**
 * What `hello` calls this app: the shell's version (mobile/package.json).
 * A function, not a constant: a module-level read of the build-time global
 * would throw in any test that imports this file.
 */
export function mobileApp(): string {
  return `orbital-mobile/${__MOBILE_VERSION__}`
}

export function newClient(relayUrl: string, mac: string, identity: Identity): RemoteClient {
  // The WebView's own WebSocket; `ws` plays it in the server's end-to-end test.
  return new RemoteClient({ relayUrl, mac, identity, WebSocketImpl: WebSocket, app: mobileApp() })
}

/** The paired Mac's link, started and live behind `clientRef`. */
export async function connect(pairing: Pairing): Promise<RemoteClient> {
  const identity = await loadOrCreateIdentity()
  const client = newClient(pairing.relay, pairing.mac, identity)
  clientRef.set(client)
  client.start()
  return client
}
```

Create `web/src/mobile/forget.ts`:

```ts
import { useOrbital } from '../store/store'
import { clearCaches } from './platform/cache'
import { forgetIdentity } from './platform/identity'
import { clearImageCache } from './platform/imageCache'
import { clearPairing, setUnpaired } from './platform/pairing'
import { useMobile } from './state'
import { clientRef } from './transport/clientRef'

/**
 * Everything this phone knows about its Mac goes: the link, the pairing,
 * the identity, the caches (spec § 4). `unpaired` is the Mac's doing — a
 * revoke reached us — and 9h then shows on every launch until a new
 * pairing. Without it the user chose "Pair a different Mac" (9f), and the
 * scanner comes next.
 */
export async function forgetEverything(opts: { unpaired: boolean }): Promise<void> {
  const { macName, pairing } = useMobile.getState()
  const name = macName ?? pairing?.macName ?? ''
  clientRef.set(null)
  await Promise.all([clearPairing(), forgetIdentity(), clearCaches(), clearImageCache()])
  if (opts.unpaired) await setUnpaired(name)
  useOrbital.getState().seatSessions([], [])
  useMobile.setState({
    pairing: null, link: 'off', macOnline: false, ready: false, asOf: null, checkedAt: null,
    sessionId: null, mismatch: null, previous: null,
    unpaired: opts.unpaired,
    macName: opts.unpaired ? name : null,
    screen: opts.unpaired ? 'unpaired' : 'pairing',
  })
}
```

Create `web/src/mobile/boot.ts`:

```ts
import { App } from '@capacitor/app'
import type { RemoteClientEvent } from '@orbital/shared/remote/client'
import { configureApi } from '../lib/api'
import { configureImages } from '../lib/images'
import { configureSocket, getSocket } from '../lib/socket'
import { useOrbital, type ErrorsEvent, type SessionsEvent } from '../store/store'
import { connect } from './connect'
import { CACHE_WRITE_DEBOUNCE_MS, RETRY_WINDOW_MS, TRANSCRIPT_PAGE_SIZE } from './constants'
import { forgetEverything } from './forget'
import { readSessionsCache, writeSessionsCache, writeTranscriptCache } from './platform/cache'
import { readCachedImage, writeCachedImage } from './platform/imageCache'
import { loadPairing, loadUnpaired } from './platform/pairing'
import { isPairGone, useMobile } from './state'
import { clientRef } from './transport/clientRef'
import { makeImageResolver } from './transport/imageResolver'
import { makeTunnelFetch } from './transport/tunnelFetch'
import { TunnelSocket } from './transport/tunnelSocket'

/**
 * Wires the phone once, before the first render (spec § 3): the three seams
 * pointed at the tunnel, the hub topics the list needs, the cache, the app
 * lifecycle, and the paired Mac's link when there is one.
 */
export async function boot(): Promise<void> {
  configureApi({ fetch: makeTunnelFetch(clientRef) })
  configureSocket({ WebSocketImpl: () => new TunnelSocket(clientRef) as unknown as WebSocket })
  configureImages({ resolve: makeImageResolver(clientRef, { read: readCachedImage, write: writeCachedImage }) })
  clientRef.on(onClientEvent)
  wireSocket()
  wireCache()
  await installLifecycle()

  const [pairing, unpaired, cached] = await Promise.all([loadPairing(), loadUnpaired(), readSessionsCache()])
  if (cached) {
    useOrbital.getState().seatSessions(cached.value.sessions, cached.value.tags)
    useMobile.setState({ asOf: cached.asOf })
  }
  useMobile.setState({
    pairing,
    unpaired: unpaired !== null,
    macName: pairing?.macName ?? unpaired?.macName ?? null,
    screen: unpaired ? 'unpaired' : pairing ? 'list' : 'pairing',
  })
  if (pairing && !unpaired) await connect(pairing)
}

function onClientEvent(event: RemoteClientEvent): void {
  useMobile.getState().apply(event)
  if (isPairGone(event)) {
    // Deleted on first contact, then 9h (spec § 4).
    void forgetEverything({ unpaired: true })
    return
  }
  if (event.type === 'hub') refetchDropped(event.frame)
}

/** A hub frame too large for one relay frame arrives as `dropped` (parent § 7): read that session's page again. */
function refetchDropped(frame: unknown): void {
  const f = frame as { topic?: unknown; event?: unknown } | null
  if (f?.event !== 'dropped' || typeof f.topic !== 'string' || !f.topic.startsWith('session:')) return
  void useOrbital.getState().reloadTranscript(f.topic.slice('session:'.length))
}

function wireSocket(): void {
  const socket = getSocket()
  socket.subscribe('sessions', (msg: SessionsEvent) => useOrbital.getState().queueSessionsEvent(msg))
  socket.subscribe('errors', (msg: ErrorsEvent) => useOrbital.getState().applyErrorsEvent(msg))
  // Every open is a new tunnel, and nothing said while it was down is replayed (parent § 4).
  socket.onStatusChange((status) => {
    if (status === 'open') void resync()
  })
}

/** The list and the open transcript, read again over the tunnel. */
export async function resync(): Promise<void> {
  try {
    const id = useOrbital.getState().ui.selectedId
    await useOrbital.getState().loadSessions()
    if (!id) return
    if (useOrbital.getState().historyLoaded[id]) await useOrbital.getState().reloadTranscript(id)
    else await useOrbital.getState().select(id)
  } catch {
    // The next open, or the next return to the foreground, tries again.
  }
}

/** Writes what is live to the cache, so the next offline launch has something honest to show. */
function wireCache(): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  useOrbital.subscribe((state, prev) => {
    if (!useMobile.getState().ready) return
    const id = state.ui.selectedId
    const changed =
      state.sessions !== prev.sessions ||
      state.tags !== prev.tags ||
      (id !== null && state.transcripts[id] !== prev.transcripts[id])
    if (!changed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void persist()
    }, CACHE_WRITE_DEBOUNCE_MS)
  })
}

async function persist(): Promise<void> {
  const { sessions, tags, ui, transcripts } = useOrbital.getState()
  const now = Date.now()
  try {
    await writeSessionsCache({ sessions: Object.values(sessions), tags }, now)
    const id = ui.selectedId
    const messages = id ? transcripts[id] : undefined
    if (id && messages) await writeTranscriptCache(id, messages.slice(-TRANSCRIPT_PAGE_SIZE), now)
  } catch (err) {
    console.warn('orbital: could not write the offline cache', err)
  }
}

async function installLifecycle(): Promise<void> {
  try {
    await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void foreground()
    })
    await App.addListener('backButton', () => {
      if (useMobile.getState().goBack() === 'exit') void App.minimizeApp()
    })
  } catch {
    // A desktop browser has no app lifecycle to listen to.
  }
}

/** Android kills a backgrounded socket without a word: on return, never trust it (parent § 4). */
async function foreground(): Promise<void> {
  if (!clientRef.client) return
  const online = await clientRef.recheck(RETRY_WINDOW_MS)
  useMobile.setState({ checkedAt: Date.now(), macOnline: online })
}
```

Create `web/src/mobile/screens/ScreenPending.tsx`:

```tsx
/** Stands in for a screen a later task builds; Task 13 deletes it. */
export function ScreenPending({ name }: { name: string }) {
  return (
    <main className="flex h-full items-center justify-center font-mono text-[11px] tracking-[0.2em] text-text-muted">
      {name.toUpperCase()}
    </main>
  )
}
```

Replace `web/src/mobile/MobileApp.tsx` with:

```tsx
import { ScreenPending } from './screens/ScreenPending'
import { useMobile } from './state'

/** One screen at a time, chosen by in-memory state (spec § 5). */
export function MobileApp() {
  const screen = useMobile((s) => s.screen)
  return (
    <div className="h-full bg-space font-sans text-text-bright">
      {screen === 'pairing' && <ScreenPending name="pairing" />}
      {screen === 'list' && <ScreenPending name="list" />}
      {screen === 'session' && <ScreenPending name="session" />}
      {screen === 'settings' && <ScreenPending name="settings" />}
      {screen === 'unpaired' && <ScreenPending name="unpaired" />}
      {screen === 'mismatch' && <ScreenPending name="mismatch" />}
    </div>
  )
}
```

In `web/src/mobile/main.tsx`, add `import { boot } from './boot'` after the `MobileApp` import, and replace the `createRoot(…).render(…)` call with:

```tsx
// The seams must be in place before anything renders: the first screen
// may open the socket or ask for an image.
void boot()
  .catch((err: unknown) => console.warn('orbital: boot failed', err))
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <ErrorBoundary label="Orbital">
          <MobileApp />
        </ErrorBoundary>
      </StrictMode>,
    )
  })
```

- [ ] **Step 8: See it boot in a browser**

Run (in the background): `npm run dev:mobile -w @orbital/web`, open `http://localhost:4841`.
Expected: PAIRING centred (no pairing stored in this browser). In the devtools console, `localStorage.setItem('CapacitorStorage.orbital.unpaired', 'studio')` then reload: UNPAIRED. Remove the key again. Stop the dev server.

- [ ] **Step 9: Typecheck, the web suite, lint, the bundle guard**

Run: `npm run typecheck -w @orbital/web && npm run test:run -w @orbital/web && npx eslint web/src/mobile web/src/store/store.ts web/src/test && npm run build:mobile -w @orbital/web && npm run test:bundle -w @orbital/web`
Expected: no errors; all tests pass; the guard passes.

- [ ] **Step 10: Commit**

```bash
git add web/src/mobile web/src/store/store.ts web/src/test/mobilestate.test.ts web/src/test/mobilestore.test.ts
git commit -m "feat(mobile): app state, version gate and boot wiring"
```

---

### Task 9: 9e Pairing

**Files:**
- Modify: `relay/src/pairing.ts`; Test: `relay/test/pairing.test.ts`
- Create: `docs/decisions/the-relay-answers-cors-for-redeem.md`
- Create: `web/src/mobile/pairingFlow.ts`, `web/src/mobile/pairingRun.ts`, `web/src/mobile/platform/scanner.ts`, `web/src/mobile/ui.tsx`, `web/src/mobile/screens/PairingScreen.tsx`
- Modify: `web/src/mobile/MobileApp.tsx`
- Test: `web/src/test/mobilepairing.test.ts`
- Create: `mobile/scripts/pair-emulator.sh`; Modify: `docs/ops/build-the-android-app.md`

**Interfaces:**
- Consumes: Task 1 (`CONNECT_TIMEOUT_MS`, `RemoteClient.start/redeem/waitForPairing/ready/on`), Task 6 (`isHttpUrl`, `loadOrCreateIdentity`, `identityIsDevOnly`, `savePairing`, `clearUnpaired`, `thisDevice`, `Pairing`), Task 7 (`clientRef`), Task 8 (`newClient`, `PAIRED_HELLO_WAIT_MS`, `useMobile`); `QrPayload`, `PAIRING_TOKEN_TTL_MS` (`@orbital/shared/remote/relayApi`), `fingerprint`, `formatFingerprint`, `publicKeyOf` (`@orbital/shared/remote/keys`), `useNow` (`web/src/lib/useNow.ts`).
- Produces:
  - `pairingFlow.ts`: `parseQrText(text: string): QrPayload | null`, `type RedeemVerdict = 'wait' | 'expired' | 'busy' | 'network'`, `redeemOutcome(status: number): RedeemVerdict`, `fingerprintFor(mac: string, phoneKey: Uint8Array): string`
  - `pairingRun.ts`: `type PairingStep`, `RELAY_UNREACHABLE`, `RELAY_BUSY`, `runPairing(qr: QrPayload, report: (step: PairingStep) => void, cancelled: () => boolean): Promise<void>`
  - `platform/scanner.ts`: `type ScanResult = { kind: 'code'; text: string } | { kind: 'cancelled' } | { kind: 'unavailable' }`, `scanQr(): Promise<ScanResult>`
  - `ui.tsx`: `MobileScreen({ header?, children, footer?, scroll? })`, `PrimaryButton`, `SecondaryButton` (`{ children, onClick?, disabled?, type? }`), `Toggle({ checked, onChange, disabled?, label })`, `SectionLabel({ children })`
  - `screens/PairingScreen.tsx`: `PairingScreen()`, `NOT_A_CODE`
  - relay: `OPTIONS /pair/redeem` and an allow-origin header on every `/pair/redeem` answer

- [ ] **Step 1: Write the failing relay test**

In `relay/test/pairing.test.ts`, add inside `describe('pairing', () => {`, after the first `it(…)`:

```ts
  it('lets a WebView redeem across origins, and only redeem', async () => {
    const r = await relay();
    const preflight = await r.app.inject({
      method: 'OPTIONS', url: '/pair/redeem',
      headers: { origin: 'https://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('*');
    expect(preflight.headers['access-control-allow-methods']).toBe('POST');
    expect(preflight.headers['access-control-allow-headers']).toBe('content-type');
    // A refusal must be readable too, or the phone sees a network error where it should say "code expired".
    const refused = await r.post('/pair/redeem', signRequest(r.phone, 'pair.redeem', { token: 'nope', name: 'P', platform: 'android', proof: 'p' }, r.now()));
    expect(refused.statusCode).toBe(404);
    expect(refused.headers['access-control-allow-origin']).toBe('*');
    // The Mac's routes stay closed to browsers.
    const minted = await r.post('/pair/token', signRequest(r.mac, 'pair.token', { name: 'studio' }, r.now()));
    expect(minted.headers['access-control-allow-origin']).toBeUndefined();
    expect((await r.app.inject({ method: 'OPTIONS', url: '/pair/confirm' })).statusCode).toBe(404);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w relay -- test/pairing.test.ts`
Expected: FAIL — the preflight answers 404.

- [ ] **Step 3: Answer CORS for redeem**

In `relay/src/pairing.ts`, after `const RATE_WINDOW_MS = 60_000;`, add:

```ts
/**
 * The phone redeems from a WebView whose page is https://localhost (and from
 * a desktop browser while its layout is worked on), so `/pair/redeem` is a
 * cross-origin JSON POST: the browser asks first, and reads the answer only
 * when it carries an allow-origin. Any origin may: the request is signed,
 * the token single-use, and no cookie is involved. Only redeem — the other
 * three routes are the Mac's, which is not a browser (ADR
 * the-relay-answers-cors-for-redeem).
 */
const REDEEM_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600',
};
```

Directly before `app.post('/pair/redeem', async (req, reply) => {`, add:

```ts
  app.options('/pair/redeem', (_req, reply) => {
    void reply.code(204).headers(REDEEM_CORS).send();
  });
```

and make the first line inside the redeem handler (before `const s = signed(…)`):

```ts
    void reply.header('access-control-allow-origin', REDEEM_CORS['access-control-allow-origin']);
```

- [ ] **Step 4: Run the relay suite**

Run: `npm test -w relay && npm run typecheck -w relay && npx eslint relay/`
Expected: PASS, no errors.

- [ ] **Step 5: Record the decision**

Create `docs/decisions/the-relay-answers-cors-for-redeem.md`:

```markdown
---
id: the-relay-answers-cors-for-redeem
title: The relay answers CORS for /pair/redeem
status: in-force
type: adr
domain: remote
related:
  - 2026-10-02-mobile-app-design
  - 2026-10-02-mobile-app-read
  - run-the-relay
tags:
  - relay
  - mobile
  - security
---
# The relay answers CORS for `/pair/redeem`

**Decided 2026-10-02**, while planning [[2026-10-02-mobile-app-read]].

## Context

The phone redeems a pairing code with a signed `POST /pair/redeem`
([[2026-10-02-mobile-app-design]] § 2). The app is a WebView whose page
origin is `https://localhost` (Capacitor's Android scheme) — and, while its
layout is worked on, a desktop browser on `http://localhost:4841`. The relay
is another origin. A cross-origin JSON POST needs a CORS preflight, and the
relay answered none, so every redeem would fail as a network error before
reaching the route.

## Decision

The relay answers `OPTIONS /pair/redeem` with `access-control-allow-origin: *`,
`POST` and `content-type`, and puts `access-control-allow-origin: *` on every
`/pair/redeem` answer, refusals included, so the phone can tell an expired
code from an unreachable relay. Nothing else gets CORS: `/pair/token`,
`/pair/confirm` and `/pair/revoke` are the Mac's, and the Mac is a Node
process, not a browser.

## Consequences

- Any web page can now send a redeem, and gains nothing by it: the request
  must be signed by the key it names, the token is single-use and expires,
  the Mac checks the pairing proof that only the QR's scanner can make, and
  no cookie or ambient credential is involved.
- A deployed relay has to be redeployed before a phone can pair through it.
- Ruled out: Capacitor's native HTTP (`CapacitorHttp`), which escapes CORS
  on a device but not in the desktop browser the spec relies on for layout
  work and the fidelity pass; and a redeem message over the relay's
  WebSocket, which would change the relay protocol for one request.
```

Run: `bunx @slothworks/atlas validate`
Expected: no errors.

- [ ] **Step 6: Commit the relay change**

```bash
git add relay/src/pairing.ts relay/test/pairing.test.ts docs/decisions/the-relay-answers-cors-for-redeem.md
git commit -m "feat(relay): answer CORS for /pair/redeem so a WebView can pair"
```

- [ ] **Step 7: Write the failing pairing tests**

Create `web/src/test/mobilepairing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { deviceId, generateIdentity, toBase64Url } from '@orbital/shared/remote/keys'
import { parseQrText, redeemOutcome } from '../mobile/pairingFlow'

const mac = deviceId(generateIdentity().publicKey)
const qr = {
  v: 1, relay: 'https://relay.example.org', mac, name: 'studio', token: 'tok',
  secret: toBase64Url(new Uint8Array(16).fill(1)),
}

describe('parseQrText', () => {
  it('reads the code the Mac shows, with whatever whitespace came with it', () => {
    expect(parseQrText(JSON.stringify(qr))).toEqual(qr)
    expect(parseQrText(`\n  ${JSON.stringify(qr, null, 2)}  \n`)).toEqual(qr)
  })

  it('refuses what is not an Orbital pairing code', () => {
    expect(parseQrText('')).toBeNull()
    expect(parseQrText('https://relay.example.org/pair')).toBeNull()
    expect(parseQrText(JSON.stringify({ ...qr, v: 2 }))).toBeNull()
    expect(parseQrText(JSON.stringify({ ...qr, relay: 'ftp://relay.example.org' }))).toBeNull()
    expect(parseQrText(JSON.stringify({ ...qr, mac: 'nope' }))).toBeNull()
    expect(parseQrText(JSON.stringify({ ...qr, token: '' }))).toBeNull()
  })
})

describe('redeemOutcome', () => {
  it('waits for the Mac only on 200', () => {
    expect(redeemOutcome(200)).toBe('wait')
  })

  it('reads an unknown, used, expired or Mac-offline code as expired', () => {
    for (const status of [400, 401, 404, 409]) expect(redeemOutcome(status)).toBe('expired')
  })

  it('tells a busy relay from one that cannot be reached', () => {
    expect(redeemOutcome(429)).toBe('busy')
    expect(redeemOutcome(0)).toBe('network')
    expect(redeemOutcome(502)).toBe('network')
  })
})
```

- [ ] **Step 8: Run them to verify they fail**

Run: `npm run test:run -w @orbital/web -- src/test/mobilepairing.test.ts`
Expected: FAIL — `../mobile/pairingFlow` does not exist.

- [ ] **Step 9: Write the pure pairing logic**

Create `web/src/mobile/pairingFlow.ts`:

```ts
import { fingerprint, publicKeyOf } from '@orbital/shared/remote/keys'
import { QrPayload } from '@orbital/shared/remote/relayApi'
import { isHttpUrl } from './platform/parse'

/**
 * A scanned or pasted code (9e), or null when it is not an Orbital pairing
 * code this phone can use. Checked before anything connects: a relay that
 * is not http(s) or a Mac id that is not a key never reaches the network.
 */
export function parseQrText(text: string): QrPayload | null {
  let data: unknown
  try {
    data = JSON.parse(text.trim())
  } catch {
    return null
  }
  const parsed = QrPayload.safeParse(data)
  if (!parsed.success) return null
  const qr = parsed.data
  if (!isHttpUrl(qr.relay) || publicKeyOf(qr.mac) === null || qr.token === '' || qr.secret === '') return null
  return qr
}

export type RedeemVerdict = 'wait' | 'expired' | 'busy' | 'network'

/**
 * What a `/pair/redeem` answer means for 9e (relay/src/pairing.ts): 200 only
 * says the relay passed it on, so the Mac's answer is still to come; 404
 * (unknown or used token), 409 (the Mac went offline, which also uses the
 * token up) and a refused signature cannot pair this code; 429 is the
 * relay's rate limit; anything else is the relay not being there.
 */
export function redeemOutcome(status: number): RedeemVerdict {
  if (status === 200) return 'wait'
  if (status === 429) return 'busy'
  if (status === 0 || status >= 500) return 'network'
  return 'expired'
}

/** The six characters both screens show (9e, 9o). */
export function fingerprintFor(mac: string, phoneKey: Uint8Array): string {
  const macKey = publicKeyOf(mac)
  if (!macKey) throw new Error('mac is not a device id')
  return fingerprint(macKey, phoneKey)
}
```

- [ ] **Step 10: Run them to verify they pass**

Run: `npm run test:run -w @orbital/web -- src/test/mobilepairing.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 11: Write the scanner, the pairing run and the shared screen parts**

Create `web/src/mobile/platform/scanner.ts`:

```ts
import { Capacitor } from '@capacitor/core'
import { BarcodeFormat, BarcodeScanner } from '@capacitor-mlkit/barcode-scanning'

export type ScanResult = { kind: 'code'; text: string } | { kind: 'cancelled' } | { kind: 'unavailable' }

/**
 * The system's ready-made scanner (ML Kit through Google Play services). No
 * camera API — a desktop browser, a phone without the module yet — answers
 * `unavailable`, and 9e offers the paste field instead (spec § 1).
 */
export async function scanQr(): Promise<ScanResult> {
  if (!Capacitor.isNativePlatform()) return { kind: 'unavailable' }
  try {
    const { supported } = await BarcodeScanner.isSupported()
    if (!supported) return { kind: 'unavailable' }
    if (Capacitor.getPlatform() === 'android') {
      const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable()
      if (!available) {
        // Play services fetch the module in the background; Scan works once it lands.
        await BarcodeScanner.installGoogleBarcodeScannerModule()
        return { kind: 'unavailable' }
      }
    }
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] })
    const text = barcodes[0]?.rawValue
    return text ? { kind: 'code', text } : { kind: 'cancelled' }
  } catch {
    // The user backed out of the scanner, or the module is still installing.
    return { kind: 'cancelled' }
  }
}
```

Create `web/src/mobile/pairingRun.ts`:

```ts
import { CONNECT_TIMEOUT_MS, type RemoteClient, type RemoteClientEvent } from '@orbital/shared/remote/client'
import { PAIRING_TOKEN_TTL_MS, type QrPayload } from '@orbital/shared/remote/relayApi'
import { newClient } from './connect'
import { PAIRED_HELLO_WAIT_MS } from './constants'
import { fingerprintFor, redeemOutcome } from './pairingFlow'
import { thisDevice } from './platform/device'
import { loadOrCreateIdentity } from './platform/identity'
import { clearUnpaired, savePairing } from './platform/pairing'
import { useMobile } from './state'
import { clientRef } from './transport/clientRef'

export type PairingStep =
  | { kind: 'scan'; error: string | null }
  | { kind: 'connecting' }
  | { kind: 'confirm'; macName: string; fingerprint: string; expiresAt: number }
  | { kind: 'paired'; macName: string; relayHost: string; fingerprint: string }
  | { kind: 'expired' }

export const RELAY_UNREACHABLE = "Can't reach the relay in this code."
export const RELAY_BUSY = 'The relay is busy. Try again in a minute.'

function waitFor(client: RemoteClient, match: (event: RemoteClientEvent) => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      off()
      resolve(false)
    }, ms)
    const off = client.on((event) => {
      if (!match(event)) return
      clearTimeout(timer)
      off()
      resolve(true)
    })
  })
}

/**
 * 9e from a parsed code to "Paired with" (spec § 5): a relay link to the
 * code's relay, the redeem with this phone's name, the Mac's confirm, then
 * the handshake and hello. `report` hears every step. `cancelled` is asked
 * after every wait; a cancelled run reports nothing more — its caller has
 * already closed the link.
 */
export async function runPairing(
  qr: QrPayload,
  report: (step: PairingStep) => void,
  cancelled: () => boolean,
): Promise<void> {
  report({ kind: 'connecting' })
  const identity = await loadOrCreateIdentity()
  const fingerprint = fingerprintFor(qr.mac, identity.publicKey)
  const client = newClient(qr.relay, qr.mac, identity)
  clientRef.set(client)
  const online = waitFor(client, (e) => e.type === 'status' && e.status === 'online', CONNECT_TIMEOUT_MS)
  client.start()
  const reached = await online
  if (cancelled()) return
  if (!reached) {
    clientRef.set(null)
    report({ kind: 'scan', error: RELAY_UNREACHABLE })
    return
  }

  report({ kind: 'confirm', macName: qr.name, fingerprint, expiresAt: Date.now() + PAIRING_TOKEN_TTL_MS })
  // Listening before the redeem goes out: the Mac's answer must not slip past.
  const outcome = client.waitForPairing(PAIRING_TOKEN_TTL_MS)
  const device = await thisDevice()
  const verdict = redeemOutcome((await client.redeem(qr.token, qr.secret, device.name, device.platform)).status)
  if (cancelled()) return
  if (verdict !== 'wait') {
    clientRef.set(null)
    report(
      verdict === 'expired'
        ? { kind: 'expired' }
        : { kind: 'scan', error: verdict === 'busy' ? RELAY_BUSY : RELAY_UNREACHABLE },
    )
    return
  }
  const result = await outcome
  if (cancelled()) return
  if (result !== 'paired') {
    clientRef.set(null)
    report({ kind: 'expired' })
    return
  }

  const pairing = { relay: qr.relay, mac: qr.mac, macName: qr.name, fingerprint, pairedAt: Date.now() }
  await Promise.all([savePairing(pairing), clearUnpaired()])
  useMobile.setState({ pairing, unpaired: false, macName: qr.name })
  // The tunnel follows `paired` within moments; "Paired with" waits for it, bounded, and shows either way.
  if (!client.ready) await waitFor(client, (e) => e.type === 'hello', PAIRED_HELLO_WAIT_MS)
  if (cancelled()) return
  report({ kind: 'paired', macName: qr.name, relayHost: new URL(qr.relay).host, fingerprint })
}
```

Create `web/src/mobile/ui.tsx`:

```tsx
import type { ReactNode } from 'react'

/**
 * One phone screen (9a–9i): the header pinned at the top, the body
 * scrolling under it (or, with `scroll={false}`, handing the height to a
 * child that scrolls itself — the transcript), an optional footer pinned
 * at the bottom.
 */
export function MobileScreen({
  header,
  children,
  footer,
  scroll = true,
}: {
  header?: ReactNode
  children: ReactNode
  footer?: ReactNode
  scroll?: boolean
}) {
  return (
    <main className="flex h-full min-h-0 flex-col">
      {header && <header className="shrink-0 border-b border-panel-border bg-[rgba(5,7,13,.92)]">{header}</header>}
      <div className={scroll ? 'min-h-0 flex-1 overflow-y-auto' : 'flex min-h-0 flex-1 flex-col'}>{children}</div>
      {footer && <div className="shrink-0">{footer}</div>}
    </main>
  )
}

type ButtonProps = { children: ReactNode; onClick?: () => void; disabled?: boolean; type?: 'button' | 'submit' }

export function PrimaryButton({ children, onClick, disabled, type = 'button' }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="min-h-11 w-full rounded-[10px] border border-[rgba(89,228,243,.45)] bg-[rgba(89,228,243,.12)] px-4 text-[15px] font-semibold text-text-bright disabled:opacity-40"
    >
      {children}
    </button>
  )
}

export function SecondaryButton({ children, onClick, disabled, type = 'button' }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="min-h-11 w-full rounded-[10px] border border-panel-border px-4 text-[15px] text-text-soft disabled:opacity-40"
    >
      {children}
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'relative h-7 w-12 shrink-0 rounded-full border transition-colors duration-150',
        checked ? 'border-[rgba(89,228,243,.6)] bg-[rgba(89,228,243,.35)]' : 'border-panel-border bg-[rgba(150,205,255,.08)]',
        disabled ? 'opacity-40' : '',
      ].join(' ')}
    >
      <span
        aria-hidden
        className={[
          'absolute top-0.5 h-5.5 w-5.5 rounded-full bg-text-bright transition-transform duration-150',
          checked ? 'translate-x-5.5' : 'translate-x-0.5',
        ].join(' ')}
      />
    </button>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-4 pb-1.5 pt-5 font-mono text-[10.5px] tracking-[0.14em] text-text-muted">{children}</div>
}
```

- [ ] **Step 12: Write the pairing screen**

Create `web/src/mobile/screens/PairingScreen.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { formatFingerprint } from '@orbital/shared/remote/keys'
import { PAIRING_TOKEN_TTL_MS } from '@orbital/shared/remote/relayApi'
import { useNow } from '../../lib/useNow'
import { parseQrText } from '../pairingFlow'
import { runPairing, type PairingStep } from '../pairingRun'
import { identityIsDevOnly } from '../platform/identity'
import { scanQr } from '../platform/scanner'
import { useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { MobileScreen, PrimaryButton, SecondaryButton } from '../ui'

export const NOT_A_CODE = "That isn't an Orbital pairing code."

/** 9e (spec § 5): scan, confirm the fingerprint on the Mac, paired. */
export function PairingScreen() {
  const [step, setStep] = useState<PairingStep>({ kind: 'scan', error: null })
  const [scanner, setScanner] = useState<'unknown' | 'ready' | 'unavailable'>('unknown')
  const [pasted, setPasted] = useState('')
  const run = useRef(0)
  const opened = useRef(false)

  const start = useCallback((text: string) => {
    const qr = parseQrText(text)
    if (!qr) {
      setStep({ kind: 'scan', error: NOT_A_CODE })
      return
    }
    const id = ++run.current
    void runPairing(
      qr,
      (next) => {
        if (run.current === id) setStep(next)
      },
      () => run.current !== id,
    )
  }, [])

  const scan = useCallback(async () => {
    const result = await scanQr()
    if (result.kind === 'unavailable') {
      setScanner('unavailable')
      return
    }
    setScanner('ready')
    if (result.kind === 'code') start(result.text)
  }, [start])

  // Step 1 opens the scanner at once (spec § 5) — once, not again on StrictMode's second mount.
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    void scan()
  }, [scan])

  // Cancel closes the socket and returns to the previous screen, or stays here when there is none.
  const cancel = useCallback(() => {
    run.current++
    clientRef.set(null)
    if (useMobile.getState().goBack() === 'exit') setStep({ kind: 'scan', error: null })
  }, [])

  const scanAgain = useCallback(() => {
    run.current++
    clientRef.set(null)
    setStep({ kind: 'scan', error: null })
    void scan()
  }, [scan])

  if (step.kind === 'connecting') {
    return (
      <Step title="Connecting to the relay…">
        <SecondaryButton onClick={cancel}>Cancel</SecondaryButton>
      </Step>
    )
  }
  if (step.kind === 'confirm') return <ConfirmStep step={step} onCancel={cancel} />
  if (step.kind === 'paired') return <PairedStep step={step} />
  if (step.kind === 'expired') {
    return (
      <Step title="Code expired · scan again">
        <PrimaryButton onClick={scanAgain}>Scan again</PrimaryButton>
        <SecondaryButton onClick={cancel}>Cancel</SecondaryButton>
      </Step>
    )
  }

  const showPaste = scanner === 'unavailable' || __MOBILE_DEV__
  return (
    <Step
      label="STEP 1 OF 2"
      title="Pair with your Mac"
      body="On your Mac, open Settings → Mobile and show the pairing code. Scan it here."
    >
      {scanner !== 'unavailable' && <PrimaryButton onClick={() => void scan()}>Scan code</PrimaryButton>}
      {showPaste && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            start(pasted)
          }}
        >
          <label htmlFor="pairing-code" className="font-mono text-[10.5px] tracking-[0.14em] text-text-muted">
            OR PASTE THE CODE&apos;S TEXT
          </label>
          <textarea
            id="pairing-code"
            value={pasted}
            // Where a code arrives by typing (the emulator, mobile/scripts/pair-emulator.sh), it pairs as soon as it is whole.
            autoFocus={scanner === 'unavailable' || __MOBILE_DEV__}
            onChange={(event) => {
              setPasted(event.target.value)
              if (parseQrText(event.target.value)) start(event.target.value)
            }}
            rows={4}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="rounded-[10px] border border-panel-border bg-[rgba(4,8,16,.6)] p-3 font-mono text-[12px] text-text-soft"
          />
          <SecondaryButton type="submit" disabled={!pasted.trim()}>
            Pair
          </SecondaryButton>
        </form>
      )}
      {step.error && (
        <p role="alert" className="text-[13px] text-[var(--state-interrupted)]">
          {step.error}
        </p>
      )}
      {identityIsDevOnly() && (
        <p className="font-mono text-[10.5px] text-text-muted">dev only · this browser keeps the phone&apos;s key unprotected</p>
      )}
    </Step>
  )
}

function Step({ label, title, body, children }: { label?: string; title: string; body?: string; children: ReactNode }) {
  return (
    <MobileScreen>
      <div className="flex flex-col gap-5 px-6 pt-16">
        <div>
          {label && <div className="font-mono text-[10.5px] tracking-[0.14em] text-text-muted">{label}</div>}
          <h1 className="mt-2 text-[22px] font-semibold">{title}</h1>
          {body && <p className="mt-2 text-[14px] text-text-soft">{body}</p>}
        </div>
        {children}
      </div>
    </MobileScreen>
  )
}

function Fingerprint({ value }: { value: string }) {
  return (
    <div className="flex items-center justify-center gap-3 font-mono text-[26px] tracking-[0.18em]">
      {[value.slice(0, 3), value.slice(3)].map((half, i) => (
        <span key={i} className="rounded-[10px] border border-panel-border px-4 py-3">
          {half}
        </span>
      ))}
    </div>
  )
}

function ConfirmStep({
  step,
  onCancel,
}: {
  step: Extract<PairingStep, { kind: 'confirm' }>
  onCancel: () => void
}) {
  const now = useNow(true)
  const left = Math.max(0, step.expiresAt - now)
  return (
    <Step
      label="STEP 2 OF 2"
      title={`Confirm on ${step.macName}`}
      body="Your Mac shows the same six characters. Accept there if they match."
    >
      <Fingerprint value={step.fingerprint} />
      {/* Drains over PAIRING_TOKEN_TTL_MS, the code's whole life. */}
      <div aria-hidden className="h-[3px] overflow-hidden rounded-full bg-[rgba(150,205,255,.1)]">
        <div
          className="h-full bg-[rgba(89,228,243,.6)] transition-[width] duration-1000 ease-linear"
          style={{ width: `${(left / PAIRING_TOKEN_TTL_MS) * 100}%` }}
        />
      </div>
      <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
    </Step>
  )
}

function PairedStep({ step }: { step: Extract<PairingStep, { kind: 'paired' }> }) {
  return (
    <Step title={`Paired with ${step.macName}`}>
      <dl className="flex flex-col gap-2 font-mono text-[12px] text-text-muted">
        <div className="flex justify-between">
          <dt>relay</dt>
          <dd className="text-text-soft">{step.relayHost}</dd>
        </div>
        <div className="flex justify-between">
          <dt>encryption</dt>
          <dd className="text-text-soft">end-to-end</dd>
        </div>
        <div className="flex justify-between">
          <dt>fingerprint</dt>
          <dd className="text-text-soft">{formatFingerprint(step.fingerprint)}</dd>
        </div>
      </dl>
      <PrimaryButton onClick={() => useMobile.getState().go('list')}>Open sessions</PrimaryButton>
    </Step>
  )
}
```

In `web/src/mobile/MobileApp.tsx`, add `import { PairingScreen } from './screens/PairingScreen'` and replace `{screen === 'pairing' && <ScreenPending name="pairing" />}` with `{screen === 'pairing' && <PairingScreen />}`.

- [ ] **Step 13: Add the emulator pairing script and its runbook section**

Create `mobile/scripts/pair-emulator.sh`:

```sh
#!/bin/sh
# Dev only (runbook build-the-android-app): opens a pairing code on a local
# Orbital server, types it into the paste field of a dev build running on
# the emulator, and accepts the pairing on the Mac once the phone redeemed.
# Usage: mobile/scripts/pair-emulator.sh [server-port]   (default 4838)
# The Mac's name must be plain ASCII without quotes (`input text` types
# nothing else); the runbook's local stack names it studio.
set -eu
PORT="${1:-4838}"
. "$(dirname "$0")/android-env.sh"
adb reverse tcp:4840 tcp:4840 >/dev/null

json_field() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],JSON.parse(s));process.stdout.write(v==null?"":String(v))})' "$1"
}

QR="$(curl -sf -X POST "http://127.0.0.1:$PORT/api/remote/pair" | json_field qr)"
# `input text` ends a word at a space; %s is its escape for one.
adb shell input text "'$(printf %s "$QR" | sed 's/ /%s/g')'"

for _ in $(seq 1 30); do
  PHONE="$(curl -sf "http://127.0.0.1:$PORT/api/remote" | json_field pendingPair.phone)"
  if [ -n "$PHONE" ]; then
    curl -sf -X POST "http://127.0.0.1:$PORT/api/remote/pair/confirm" \
      -H 'content-type: application/json' -d "{\"accept\":true,\"phone\":\"$PHONE\"}" >/dev/null
    echo "paired $PHONE"
    exit 0
  fi
  sleep 1
done
echo "no pairing request reached the Mac" >&2
exit 1
```

Run: `chmod +x mobile/scripts/pair-emulator.sh`

In `docs/ops/build-the-android-app.md`, replace the section

```markdown
## Pair with a relay on this Mac

Task 9 of the 2a plan adds this section, with the script that types a pairing code into the emulator.
```

with:

````markdown
## Pair with a relay on this Mac

A throwaway Mac, a local relay and the phone UI, each in its own terminal
(or in the background):

```bash
env -u ORBITAL_MIGRATIONS_DIR -u ORBITAL_STATIC_DIR ORBITAL_PORT=4848 \
  ORBITAL_DATA_DIR=/tmp/orbital-mobile-dev npm run dev -w server
RELAY_PORT=4840 RELAY_DATA_DIR=/tmp/orbital-mobile-relay npm run dev -w relay
curl -s -X PATCH http://127.0.0.1:4848/api/settings -H 'content-type: application/json' \
  -d '{"remote_enabled":"true","remote_relay_url":"http://127.0.0.1:4840","remote_mac_name":"studio"}'
```

**In a desktop browser:** `ORBITAL_MOBILE_DEV=1 npm run dev:mobile -w @orbital/web`,
open `http://localhost:4841`, then copy a code and paste it into the field:

```bash
curl -s -X POST http://127.0.0.1:4848/api/remote/pair \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).qr))' | pbcopy
```

Accept it on the Mac: `curl -s http://127.0.0.1:4848/api/remote` shows
`pendingPair.phone`; post it to `/api/remote/pair/confirm` as
`{"accept":true,"phone":"<id>"}`.

**On the emulator:** install a dev build (`ORBITAL_MOBILE_DEV=1 npm run build -w @orbital/mobile && npm run apk -w @orbital/mobile`),
launch it, dismiss the system scanner if it opened (`adb shell input keyevent KEYCODE_BACK`),
then `mobile/scripts/pair-emulator.sh 4848`. It reverses the relay port into
the emulator, opens a code, types it into the focused paste field and
accepts the request on the Mac. A real device pairs the same way through
`adb reverse`, or by scanning the code in Settings → Mobile.

To see the other states from the same stack:

- **Mac asleep (9a offline):** stop the server on 4848.
- **Unpaired (9h):** `curl -s -X DELETE http://127.0.0.1:4848/api/remote/devices/<phone id>`.
- **Version mismatch (9i):** restart the server with `ORBITAL_VERSION=0.16.0` in its environment.

Stop everything afterwards: `kill $(lsof -t -iTCP:4848 -sTCP:LISTEN) $(lsof -t -iTCP:4840 -sTCP:LISTEN)`.
````

- [ ] **Step 14: Pair for real**

Start the local stack from the runbook section above (server on 4848, relay on 4840, the settings PATCH). Then, with the emulator from Task 5 running: `ORBITAL_MOBILE_DEV=1 npm run build -w @orbital/mobile && npm run apk -w @orbital/mobile && adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk && adb shell am start -n io.slothworks.orbital.mobile/.MainActivity && sleep 3 && adb shell input keyevent KEYCODE_BACK; sleep 1; mobile/scripts/pair-emulator.sh 4848 && sleep 3 && adb exec-out screencap -p > /tmp/orbital-mobile-paired.png`
Expected: the script prints `paired <id>`; the screenshot shows "Paired with studio", the relay host `127.0.0.1:4840`, "end-to-end" and the fingerprint. Read the PNG. `curl -s http://127.0.0.1:4848/api/remote` lists the phone as a device, online.

If the scanner never opened (the emulator has no Play services module), skip the `KEYCODE_BACK`. Leave the stack and the emulator running for Tasks 10–13.

- [ ] **Step 15: Typecheck, tests, lint, guard**

Run: `npm run typecheck -w @orbital/web && npm run test:run -w @orbital/web && npm run lint && npm run build:mobile -w @orbital/web && npm run test:bundle -w @orbital/web`
Expected: no errors; all pass.

- [ ] **Step 16: Commit**

```bash
git add web/src/mobile web/src/test/mobilepairing.test.ts mobile/scripts/pair-emulator.sh docs/ops/build-the-android-app.md
git commit -m "feat(mobile): 9e pairing — scan or paste, redeem, confirm, paired"
```

---

### Task 10: 9a Session list

**Files:**
- Create: `web/src/mobile/sessionList.ts`, `web/src/mobile/format.ts`, `web/src/mobile/screens/Glyph.tsx`, `web/src/mobile/screens/SessionListScreen.tsx`
- Modify: `web/src/mobile/MobileApp.tsx`
- Test: `web/src/test/mobilelist.test.ts`

**Interfaces:**
- Consumes: Task 7 (`clientRef.recheck`), Task 8 (`useMobile`: `macOnline`, `link`, `macName`, `asOf`, `checkedAt`, `openSession`, `go`; `RETRY_WINDOW_MS`, `CLOCK_TICK_MS`), Task 9 (`MobileScreen`); `sessionStateKey`, `isReadOnly`, `tagColor`, `ApiSession`, `PendingDecision`, `SessionStateKey`, `Tag` (`web/src/lib/types.ts`), `StateDot` type and `stateColor` (`web/src/lib/stateStyle.ts`), `StateDot` component (`web/src/ui/StateDot.tsx`), `timeAgo` (`web/src/lib/format.ts`), `useNow`.
- Produces:
  - `sessionList.ts`: `type GroupKey = 'input' | 'working' | 'idle' | 'ended'`, `GROUP_ORDER`, `GROUP_LABEL`, `groupOf(session): GroupKey`, `interface SessionGroup { key: GroupKey; sessions: ApiSession[] }`, `groupSessions(sessions: readonly ApiSession[], tagId: number | null): SessionGroup[]`, `latestActivity(sessions: readonly ApiSession[]): number | null`, `tagChips(sessions: readonly ApiSession[], tags: readonly Tag[]): { tag: Tag; live: number }[]`, `decisionReason(decision: PendingDecision | null | undefined): string | null`, `GLYPH: Record<SessionStateKey, StateDot>`, `glyphFor(key: SessionStateKey, offline: boolean): StateDot`, `STATE_WORD: Record<SessionStateKey, string>`, `stateLine(key: SessionStateKey, offline: boolean, asOf: number | null, now: number): string`
  - `format.ts`: `asOfLabel(asOf: number, now: number): string`, `checkedLabel(checkedAt: number, now: number): string`, `agoLabel(ts: number, now: number): string`, `basename(path: string): string`, `relayHost(url: string): string`
  - `screens/Glyph.tsx`: `GLYPH_SOLID_PX`, `GLYPH_HOLLOW_PX`, `Glyph({ session, offline })`
  - `screens/SessionListScreen.tsx`: `SessionListScreen()`

**Decision recorded here:** 9a's groups follow the state word. NEEDS INPUT is the amber-edged group; WAITING joins WORKING (its moons are working); DONE and INTERRUPTED join IDLE, wearing their own word on the row — nobody is being asked anything, which is what the first group is for.

- [ ] **Step 1: Write the failing tests**

Create `web/src/test/mobilelist.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ApiSession, PendingDecision, Tag } from '../lib/types'
import { agoLabel, asOfLabel, basename, checkedLabel, relayHost } from '../mobile/format'
import {
  decisionReason, glyphFor, groupOf, groupSessions, latestActivity, stateLine, tagChips,
} from '../mobile/sessionList'

function session(id: string, patch: Partial<ApiSession> = {}): ApiSession {
  return {
    id, cwd: `/w/${id}`, title: id, firstAt: 1, lastAt: 1, messageCount: 1, source: 'web', permissionMode: null,
    model: null, resolvedModel: null, tagIds: [], status: 'idle', subagents: [], ...patch,
  }
}

const question: PendingDecision = {
  id: 'q', kind: 'question', createdAt: 1,
  input: { questions: [{ question: 'Which branch?', header: 'branch', options: [], multiSelect: false }] },
}

describe('groupSessions', () => {
  it('orders the groups needs input, working, idle, ended, each newest first, and drops empty ones', () => {
    const groups = groupSessions(
      [
        session('ended', { status: 'ended', lastAt: 9 }),
        session('idle-old', { lastAt: 1 }),
        session('idle-new', { lastAt: 5 }),
        session('asks', { status: 'needs_input', pendingDecision: question }),
      ],
      null,
    )
    expect(groups.map((g) => g.key)).toEqual(['input', 'idle', 'ended'])
    expect(groups[1].sessions.map((s) => s.id)).toEqual(['idle-new', 'idle-old'])
  })

  it('puts WAITING with working, and DONE and INTERRUPTED with idle', () => {
    expect(groupOf(session('w', { status: 'working', awaitingSubagents: true, subagents: [{ id: 'a', name: 'a', state: 'working', startedAt: 1 }] }))).toBe('working')
    expect(groupOf(session('d', { status: 'needs_input' }))).toBe('idle')
    expect(groupOf(session('i', { status: 'working', interruptedAt: 5 }))).toBe('idle')
  })

  it('filters by tag, locally', () => {
    const groups = groupSessions([session('a', { tagIds: [1] }), session('b', { tagIds: [2] })], 2)
    expect(groups.flatMap((g) => g.sessions.map((s) => s.id))).toEqual(['b'])
  })
})

describe('tagChips and latestActivity', () => {
  const tags: Tag[] = [
    { id: 1, name: 'orbital', hue: 200, is_default: 1 },
    { id: 2, name: 'idle-only', hue: 40, is_default: 0 },
    { id: 3, name: 'unused', hue: 90, is_default: 0 },
  ]

  it('counts live sessions per tag and leaves out tags nothing carries', () => {
    const chips = tagChips(
      [session('a', { tagIds: [1] }), session('b', { tagIds: [1], status: 'ended' }), session('c', { tagIds: [2], status: 'ended' })],
      tags,
    )
    expect(chips.map((c) => [c.tag.id, c.live])).toEqual([[1, 1], [2, 0]])
  })

  it("reads the ended group's latest activity", () => {
    expect(latestActivity([session('a', { lastAt: 3 }), session('b', { lastAt: 7 }), session('c', { lastAt: null })])).toBe(7)
    expect(latestActivity([])).toBeNull()
  })
})

describe('decisionReason', () => {
  it("says what a needs-input session waits on", () => {
    expect(decisionReason(question)).toBe('Which branch?')
    expect(decisionReason({ id: 'p', kind: 'plan', input: {}, createdAt: 1 })).toBe('plan to approve')
    expect(decisionReason({ id: 'r', kind: 'permission', input: {}, createdAt: 1, toolName: 'Bash' })).toBe('wants to run Bash')
    expect(decisionReason({ id: 'r', kind: 'permission', input: {}, createdAt: 1, title: 'Run npm test?' })).toBe('Run npm test?')
    expect(decisionReason(null)).toBeNull()
  })
})

describe('offline', () => {
  it('stops every glyph moving and keeps its shape', () => {
    expect(glyphFor('needs_input', false).motion).toBe('breathe')
    expect(glyphFor('needs_input', true)).toEqual({ shape: 'solid', motion: 'steady' })
    expect(glyphFor('waiting', true)).toEqual({ shape: 'hollow', motion: 'steady' })
  })

  it("reads a transcript's state as what it was", () => {
    expect(stateLine('working', false, null, 0)).toBe('WORKING')
    const asOf = new Date(2026, 9, 2, 14, 32).getTime()
    expect(stateLine('working', true, asOf, asOf + 60_000)).toBe(`WAS WORKING · ${asOfLabel(asOf, asOf + 60_000)}`)
    expect(stateLine('idle', true, null, 0)).toBe('WAS IDLE')
  })
})

describe('labels', () => {
  const at = new Date(2026, 9, 2, 14, 32).getTime()

  it('names the time alone today, and the day before that', () => {
    const today = asOfLabel(at, at + 3_600_000)
    expect(today).toBe(`as of ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
    const earlier = asOfLabel(at, at + 2 * 86_400_000)
    expect(earlier).not.toBe(today)
    expect(earlier.endsWith(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))).toBe(true)
  })

  it('says "checked just now" for a minute, then how long ago', () => {
    expect(checkedLabel(at, at + 30_000)).toBe('checked just now')
    expect(checkedLabel(at, at + 5 * 60_000)).toBe('checked 5m ago')
  })

  it('reads ages, folder names and relay hosts', () => {
    expect(agoLabel(at, at + 10_000)).toBe('just now')
    expect(agoLabel(at, at + 3 * 3_600_000)).toBe('3h ago')
    expect(basename('/w/orbital/')).toBe('orbital')
    expect(relayHost('https://relay.example.org:8443/x')).toBe('relay.example.org:8443')
    expect(relayHost('not a url')).toBe('not a url')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test:run -w @orbital/web -- src/test/mobilelist.test.ts`
Expected: FAIL — `../mobile/format` does not exist.

- [ ] **Step 3: Write the pure list logic and the labels**

Create `web/src/mobile/format.ts`:

```ts
import { timeAgo } from '../lib/format'

const MINUTE_MS = 60_000
const TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

/** "as of 14:32" today, "as of 1 Oct 14:32" before that (9a offline, 9b). */
export function asOfLabel(asOf: number, now: number): string {
  const at = new Date(asOf)
  const time = at.toLocaleTimeString([], TIME)
  if (at.toDateString() === new Date(now).toDateString()) return `as of ${time}`
  return `as of ${at.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

/** After a Retry (9a) or a Try again (9i). */
export function checkedLabel(checkedAt: number, now: number): string {
  return now - checkedAt < MINUTE_MS ? 'checked just now' : `checked ${timeAgo(checkedAt, now)} ago`
}

/** "just now", "3h ago": `timeAgo` with the words around it. */
export function agoLabel(ts: number, now: number): string {
  const age = timeAgo(ts, now)
  return age === 'now' ? 'just now' : `${age} ago`
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || path
}

/** The relay as 9e and 9f name it: its host, or the URL as written when it does not parse. */
export function relayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
```

Create `web/src/mobile/sessionList.ts`:

```ts
import type { StateDot } from '../lib/stateStyle'
import { sessionStateKey, type ApiSession, type PendingDecision, type SessionStateKey, type Tag } from '../lib/types'
import { asOfLabel } from './format'

export type GroupKey = 'input' | 'working' | 'idle' | 'ended'

/** 9a's order (spec § 5): what asks for you first, what is over last. */
export const GROUP_ORDER: readonly GroupKey[] = ['input', 'working', 'idle', 'ended']

export const GROUP_LABEL: Record<GroupKey, string> = {
  input: 'NEEDS INPUT', working: 'WORKING', idle: 'IDLE', ended: 'ENDED',
}

type StateFields = Pick<ApiSession, 'status' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents' | 'backgroundTasks'>

/**
 * The state word decides the group. WAITING is work (its moons run); DONE
 * and INTERRUPTED ask nobody anything, so they sit with IDLE, wearing their
 * own word on the row.
 */
export function groupOf(session: StateFields): GroupKey {
  const key = sessionStateKey(session)
  if (key === 'needs_input') return 'input'
  if (key === 'working' || key === 'waiting') return 'working'
  if (key === 'ended') return 'ended'
  return 'idle'
}

export interface SessionGroup {
  key: GroupKey
  sessions: ApiSession[]
}

/** 9a's groups in order, the empty ones left out, each newest first; `tagId` filters locally. */
export function groupSessions(sessions: readonly ApiSession[], tagId: number | null): SessionGroup[] {
  const buckets = new Map<GroupKey, ApiSession[]>(GROUP_ORDER.map((key) => [key, []]))
  for (const session of sessions) {
    if (tagId !== null && !session.tagIds.includes(tagId)) continue
    buckets.get(groupOf(session))!.push(session)
  }
  return GROUP_ORDER.map((key) => ({
    key,
    sessions: buckets.get(key)!.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
  })).filter((group) => group.sessions.length > 0)
}

/** The collapsed ended group's "latest N ago". */
export function latestActivity(sessions: readonly ApiSession[]): number | null {
  let latest: number | null = null
  for (const session of sessions) {
    if (session.lastAt !== null && (latest === null || session.lastAt > latest)) latest = session.lastAt
  }
  return latest
}

/** The chips (9a): every tag some session carries, with its live — not ended — sessions counted. */
export function tagChips(sessions: readonly ApiSession[], tags: readonly Tag[]): { tag: Tag; live: number }[] {
  return tags
    .filter((tag) => sessions.some((s) => s.tagIds.includes(tag.id)))
    .map((tag) => ({ tag, live: sessions.filter((s) => s.tagIds.includes(tag.id) && s.status !== 'ended').length }))
}

/** A needs-input row's third line (9a): what the session waits on. */
export function decisionReason(decision: PendingDecision | null | undefined): string | null {
  if (!decision) return null
  if (decision.kind === 'question') return decision.input.questions[0]?.question ?? 'has a question'
  if (decision.kind === 'plan') return 'plan to approve'
  return decision.title ?? `wants to run ${decision.toolName ?? 'a tool'}`
}

/** 9p's glyph per state: the shape carries the meaning; motion only where 9p draws it. */
export const GLYPH: Record<SessionStateKey, StateDot> = {
  needs_input: { shape: 'solid', motion: 'breathe' },
  waiting: { shape: 'hollow', motion: 'pulse' },
  working: { shape: 'solid', motion: 'pulse' },
  interrupted: { shape: 'solid', motion: 'steady' },
  done: { shape: 'hollow', motion: 'steady' },
  idle: { shape: 'solid', motion: 'steady' },
  ended: { shape: 'hollow', motion: 'steady' },
}

/** Offline, a glyph keeps its shape and colour and loses its motion (spec § 5). */
export function glyphFor(key: SessionStateKey, offline: boolean): StateDot {
  const dot = GLYPH[key]
  return offline ? { ...dot, motion: 'steady' } : dot
}

export const STATE_WORD: Record<SessionStateKey, string> = {
  needs_input: 'NEEDS INPUT', waiting: 'WAITING', interrupted: 'INTERRUPTED', done: 'DONE',
  working: 'WORKING', idle: 'IDLE', ended: 'ENDED',
}

/** 9b's header state: live, the word; offline, what it was and when (spec § 5). */
export function stateLine(key: SessionStateKey, offline: boolean, asOf: number | null, now: number): string {
  if (!offline) return STATE_WORD[key]
  return asOf === null ? `WAS ${STATE_WORD[key]}` : `WAS ${STATE_WORD[key]} · ${asOfLabel(asOf, now)}`
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm run test:run -w @orbital/web -- src/test/mobilelist.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Write the glyph and the list screen**

Create `web/src/mobile/screens/Glyph.tsx`:

```tsx
import { stateColor } from '../../lib/stateStyle'
import { sessionStateKey, type ApiSession } from '../../lib/types'
import { StateDot } from '../../ui/StateDot'
import { glyphFor } from '../sessionList'

/** 9p's glyph sizes, px; the fidelity pass owns them. */
export const GLYPH_SOLID_PX = 8
export const GLYPH_HOLLOW_PX = 9

type StateFields = Pick<ApiSession, 'status' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents' | 'backgroundTasks'>

export function Glyph({ session, offline }: { session: StateFields; offline: boolean }) {
  const key = sessionStateKey(session)
  return (
    <span className={['inline-flex w-[14px] shrink-0 justify-center', offline ? 'opacity-50' : ''].join(' ')}>
      <StateDot dot={glyphFor(key, offline)} color={stateColor(key)} solidPx={GLYPH_SOLID_PX} hollowPx={GLYPH_HOLLOW_PX} />
    </span>
  )
}
```

Create `web/src/mobile/screens/SessionListScreen.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { timeAgo } from '../../lib/format'
import { isReadOnly, sessionStateKey, tagColor, type ApiSession, type Tag } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { useOrbital } from '../../store/store'
import { CLOCK_TICK_MS, RETRY_WINDOW_MS } from '../constants'
import { agoLabel, asOfLabel, basename, checkedLabel } from '../format'
import { GROUP_LABEL, decisionReason, groupSessions, latestActivity, tagChips } from '../sessionList'
import { useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { MobileScreen } from '../ui'
import { Glyph } from './Glyph'

/** 9a (spec § 5): the sessions, grouped by what they need from you. */
export function SessionListScreen() {
  const sessions = useOrbital(
    useShallow((s) => s.order.map((id) => s.sessions[id]).filter((x): x is ApiSession => x !== undefined)),
  )
  const tags = useOrbital((s) => s.tags)
  const { macOnline, link, macName, asOf, checkedAt } = useMobile(
    useShallow((s) => ({ macOnline: s.macOnline, link: s.link, macName: s.macName, asOf: s.asOf, checkedAt: s.checkedAt })),
  )
  const openSession = useMobile((s) => s.openSession)
  const go = useMobile((s) => s.go)
  const [tagId, setTagId] = useState<number | null>(null)
  const [endedOpen, setEndedOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const now = useNow(true, CLOCK_TICK_MS)

  const offline = !macOnline
  const mac = macName ?? 'Your Mac'
  const groups = useMemo(() => groupSessions(sessions, tagId), [sessions, tagId])
  const chips = useMemo(() => tagChips(sessions, tags), [sessions, tags])
  const tagById = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])

  // One bounded presence check, never a loop (spec § 5, RETRY_WINDOW_MS).
  const retry = async () => {
    setChecking(true)
    const online = await clientRef.recheck(RETRY_WINDOW_MS)
    useMobile.setState({ checkedAt: Date.now(), macOnline: online })
    setChecking(false)
  }

  const header = (
    <div className="flex items-center gap-3 px-4 py-2">
      <h1 className="truncate text-[17px] font-semibold">{mac}</h1>
      {link === 'connecting' && (
        <span role="img" aria-label="connecting to the relay" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--state-neutral)] opacity-60" />
      )}
      <button type="button" aria-label="Settings" onClick={() => go('settings')} className="ml-auto min-h-11 min-w-11 text-[18px] text-text-muted">
        ⚙
      </button>
    </div>
  )

  return (
    <MobileScreen header={header}>
      {offline && (
        <section className="mx-4 mt-3 rounded-[12px] border border-panel-border bg-[rgba(10,16,28,.7)] px-4 py-3">
          <p className="text-[14px] text-text-soft">
            {mac} is asleep · Showing what it last sent
          </p>
          <div className="mt-1 flex items-center gap-3 font-mono text-[11px] text-text-muted">
            {asOf !== null && <span>{asOfLabel(asOf, now)}</span>}
            {checkedAt !== null && <span>{checkedLabel(checkedAt, now)}</span>}
            <button type="button" disabled={checking} onClick={() => void retry()} className="ml-auto min-h-11 px-2 text-text-soft disabled:opacity-40">
              Retry
            </button>
          </div>
        </section>
      )}

      {chips.length > 0 && (
        <div className="flex gap-2 overflow-x-auto px-4 pt-3">
          <Chip active={tagId === null} onClick={() => setTagId(null)} label="All" />
          {chips.map(({ tag, live }) => (
            <Chip
              key={tag.id}
              active={tagId === tag.id}
              onClick={() => setTagId(tagId === tag.id ? null : tag.id)}
              label={tag.name}
              count={live}
              hue={tag.hue}
            />
          ))}
        </div>
      )}

      {groups.map((group) => {
        const rows = group.sessions.map((s) => (
          <SessionRow key={s.id} session={s} tag={tagById.get(s.tagIds[0])} offline={offline} now={now} onOpen={openSession} />
        ))
        if (group.key === 'ended') {
          const latest = latestActivity(group.sessions)
          return (
            <section key="ended" className="mt-4">
              <button
                type="button"
                aria-expanded={endedOpen}
                onClick={() => setEndedOpen(!endedOpen)}
                className="flex min-h-11 w-full items-center gap-2 px-4 font-mono text-[10.5px] tracking-[0.14em] text-text-muted"
              >
                <span>
                  {GROUP_LABEL.ended} · {group.sessions.length}
                </span>
                {latest !== null && <span>· latest {agoLabel(latest, now)}</span>}
                <span aria-hidden className="ml-auto">
                  {endedOpen ? '▾' : '▸'}
                </span>
              </button>
              {endedOpen && rows}
            </section>
          )
        }
        return (
          <section
            key={group.key}
            className={
              group.key === 'input'
                ? 'mx-3 mt-4 rounded-[12px] border border-[color-mix(in_oklch,var(--state-input)_45%,transparent)]'
                : 'mt-4'
            }
          >
            <div className="px-4 pb-1 pt-3 font-mono text-[10.5px] tracking-[0.14em] text-text-muted">
              {GROUP_LABEL[group.key]} · {group.sessions.length}
            </div>
            {rows}
          </section>
        )
      })}

      {groups.length === 0 && <p className="px-4 pt-10 text-center text-[14px] text-text-muted">No sessions yet.</p>}

      {/* 9d is 2b: drawn, disabled, with its reason. */}
      <div className="px-4 py-6">
        <button type="button" disabled className="min-h-11 w-full rounded-[10px] border border-panel-border text-[15px] text-text-muted opacity-60">
          + New session
        </button>
        <p className="mt-1.5 text-center font-mono text-[10.5px] text-text-muted">
          {offline ? `needs ${mac} awake` : 'coming with 2b'}
        </p>
      </div>
    </MobileScreen>
  )
}

function Chip({
  active,
  onClick,
  label,
  count,
  hue,
}: {
  active: boolean
  onClick: () => void
  label: string
  count?: number
  hue?: number
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px]',
        active ? 'border-[rgba(89,228,243,.5)] text-text-bright' : 'border-panel-border text-text-muted',
      ].join(' ')}
    >
      {hue !== undefined && <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: tagColor(hue) }} />}
      <span>{label}</span>
      {count !== undefined && <span className="font-mono text-[11px] text-text-muted">{count}</span>}
    </button>
  )
}

function SessionRow({
  session,
  tag,
  offline,
  now,
  onOpen,
}: {
  session: ApiSession
  tag: Tag | undefined
  offline: boolean
  now: number
  onOpen: (id: string) => void
}) {
  const [moonsOpen, setMoonsOpen] = useState(false)
  const reason = sessionStateKey(session) === 'needs_input' ? decisionReason(session.pendingDecision) : null
  return (
    <div>
      <button type="button" onClick={() => onOpen(session.id)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left">
        <span className="pt-[6px]">
          <Glyph session={session} offline={offline} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[15px] text-text-bright">{session.title || 'Untitled session'}</span>
            {isReadOnly(session) && (
              <span className="shrink-0 font-mono text-[9.5px] tracking-[0.1em] text-text-muted">READ-ONLY</span>
            )}
            {session.lastAt !== null && (
              <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">{timeAgo(session.lastAt, now)}</span>
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-2 font-mono text-[11px] text-text-muted">
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: tag ? tagColor(tag.hue) : 'var(--state-neutral)' }}
            />
            <span className="truncate">{basename(session.cwd)}</span>
            {session.git && <span className="truncate">⎇ {session.git.ref}</span>}
          </span>
          {reason && <span className="mt-1 block truncate text-[13px] text-[var(--state-input)]">{reason}</span>}
        </span>
      </button>
      {session.subagents.length > 0 && (
        <div className="pb-1 pl-[42px] pr-4">
          <button
            type="button"
            aria-expanded={moonsOpen}
            onClick={() => setMoonsOpen(!moonsOpen)}
            className="min-h-9 font-mono text-[11px] text-text-muted"
          >
            {session.subagents.length} {session.subagents.length === 1 ? 'subagent' : 'subagents'} {moonsOpen ? '▾' : '▸'}
          </button>
          {moonsOpen && (
            <ul className="pb-2">
              {session.subagents.map((agent) => (
                <li key={agent.id} className="flex gap-2 py-0.5 font-mono text-[11px] text-text-muted">
                  <span className="truncate text-text-soft">{agent.name}</span>
                  <span className="ml-auto shrink-0">{agent.state}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
```

In `web/src/mobile/MobileApp.tsx`, add `import { SessionListScreen } from './screens/SessionListScreen'` and replace `{screen === 'list' && <ScreenPending name="list" />}` with `{screen === 'list' && <SessionListScreen />}`.

- [ ] **Step 6: See the list on the emulator, live and offline**

With the local stack and the paired emulator from Task 9 still running: `npm run build -w @orbital/mobile && npm run apk -w @orbital/mobile && adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk && adb shell am start -n io.slothworks.orbital.mobile/.MainActivity && sleep 5 && adb exec-out screencap -p > /tmp/orbital-mobile-list.png`
Expected: the list of this Mac's sessions (the dev server reads `~/.claude`), grouped, with glyphs and the disabled "+ New session · coming with 2b". (The reinstall keeps the app's data, so it opens paired.)

Then stop the server: `kill $(lsof -t -iTCP:4848 -sTCP:LISTEN)`, wait 5 s, `adb exec-out screencap -p > /tmp/orbital-mobile-offline.png`.
Expected: the card "studio is asleep · Showing what it last sent" with "as of" and Retry; glyphs dimmed. Read both PNGs. Start the server again with the Task 9 command before the next task.

- [ ] **Step 7: Typecheck, tests, lint, guard**

Run: `npm run typecheck -w @orbital/web && npm run test:run -w @orbital/web && npm run lint && npm run build:mobile -w @orbital/web && npm run test:bundle -w @orbital/web`
Expected: no errors; all pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/mobile web/src/test/mobilelist.test.ts
git commit -m "feat(mobile): 9a session list with groups, tags and the offline card"
```

---

### Task 11: 9b Transcript, read-only

**Files:**
- Modify: `web/src/store/store.ts` (`configureTranscriptPages` and the four `getMessages` calls in `select`, `loadOlder`, `reloadTranscript`, `resyncAfterReconnect`)
- Modify: `web/src/mobile/boot.ts` (one line), `web/src/mobile/MobileApp.tsx`
- Create: `web/src/mobile/screens/SessionScreen.tsx`
- Test: `web/src/test/mobilestore.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3 (`ImageThumb` through `useImageUrl`, used inside the panels), Task 6 (`readTranscriptCache`), Task 7 (`clientRef.seen`), Task 8 (`useMobile`: `sessionId`, `ready`, `asOf`, `goBack`; `TRANSCRIPT_PAGE_SIZE`, `CLOCK_TICK_MS`), Task 9 (`MobileScreen`), Task 10 (`Glyph`, `stateLine`, `basename`); `TranscriptView` (`web/src/panels/TranscriptView.tsx`), `getSocket`, store `select`, `loadOlder`, `applySessionEvent`, `SessionEvent`.
- Produces: `configureTranscriptPages(size: number | undefined): void` exported from `web/src/store/store.ts`; `SessionScreen()`.

- [ ] **Step 1: Write the failing store test**

Append to `web/src/test/mobilestore.test.ts`:

```ts
import { afterEach } from 'vitest'
import type { ChatMessage } from '../lib/types'
import { configureTranscriptPages } from '../store/store'

describe('configureTranscriptPages', () => {
  afterEach(() => configureTranscriptPages(undefined))

  it('asks for pages of the configured size, the first and the older ones', async () => {
    configureTranscriptPages(30)
    vi.mocked(api.getMessages).mockResolvedValue([{ id: 'm1', role: 'user', text: 'hi' } as ChatMessage])
    useOrbital.setState({ transcripts: {}, historyLoaded: {}, detachedIds: [] })
    await useOrbital.getState().select('s1')
    expect(api.getMessages).toHaveBeenCalledWith('s1', { limit: 30 })
    await useOrbital.getState().loadOlder('s1')
    expect(api.getMessages).toHaveBeenLastCalledWith('s1', { before: 'm1', limit: 30 })
  })

  it("leaves the server's default alone when nothing is configured", async () => {
    vi.mocked(api.getMessages).mockResolvedValue([])
    await useOrbital.getState().select('s2')
    expect(api.getMessages).toHaveBeenCalledWith('s2')
  })
})
```

(Move the two new imports to the top of the file with the others: `afterEach` joins the `vitest` import, `ChatMessage` joins the `../lib/types` type import, and `configureTranscriptPages` joins the `../store/store` import.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:run -w @orbital/web -- src/test/mobilestore.test.ts`
Expected: FAIL — `configureTranscriptPages` is not exported.

- [ ] **Step 3: Page transcripts by a configurable size**

In `web/src/store/store.ts`, directly above `export const useOrbital = create<OrbitalStore>()(`, add:

```ts
/**
 * How many messages a transcript fetch asks for; undefined leaves it to the
 * server's default, as the desktop always has. The phone sets
 * `TRANSCRIPT_PAGE_SIZE` (spec 2026-10-02-mobile-app-design § 5): one
 * answer must fit one relay frame.
 */
let transcriptPageSize: number | undefined

export function configureTranscriptPages(size: number | undefined): void {
  transcriptPageSize = size
}

/** One page of a transcript: the newest, or the one before `before`. */
function messagesPage(id: string, before?: string): Promise<ChatMessage[]> {
  if (before === undefined) {
    return transcriptPageSize === undefined ? api.getMessages(id) : api.getMessages(id, { limit: transcriptPageSize })
  }
  return api.getMessages(id, transcriptPageSize === undefined ? { before } : { before, limit: transcriptPageSize })
}
```

Then replace exactly these four calls (the transcript check's `api.getMessages(id, { limit: TRANSCRIPT_CHECK_PAGE })` stays as it is):

- in `resyncAfterReconnect`: `const fetched = selectedId ? await api.getMessages(selectedId) : null` → `const fetched = selectedId ? await messagesPage(selectedId) : null`
- in `reloadTranscript`: `const fetched = await api.getMessages(id)` → `const fetched = await messagesPage(id)`
- in `select`: `const fetched = await api.getMessages(id)` → `const fetched = await messagesPage(id)`
- in `loadOlder`: `fetched = await api.getMessages(id, { before: firstId })` → `fetched = await messagesPage(id, firstId)`

In `web/src/mobile/boot.ts`, add `configureTranscriptPages` to the store import (`import { configureTranscriptPages, useOrbital, type ErrorsEvent, type SessionsEvent } from '../store/store'`) and make it the first line of `boot()`:

```ts
  configureTranscriptPages(TRANSCRIPT_PAGE_SIZE)
```

- [ ] **Step 4: Run the store tests**

Run: `npm run test:run -w @orbital/web -- src/test/mobilestore.test.ts src/test/store.test.ts`
Expected: PASS — the existing suite still sees `getMessages('s1')` and `getMessages('s1', { before: 'm5' })` exactly.

- [ ] **Step 5: Write the session screen**

Create `web/src/mobile/screens/SessionScreen.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import { getSocket } from '../../lib/socket'
import { stateColor } from '../../lib/stateStyle'
import { isReadOnly, sessionStateKey, tagColor, type ChatMessage } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { TranscriptView } from '../../panels/TranscriptView'
import { useOrbital, type SessionEvent } from '../../store/store'
import { CLOCK_TICK_MS } from '../constants'
import { basename } from '../format'
import { readTranscriptCache } from '../platform/cache'
import { stateLine } from '../sessionList'
import { useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { MobileScreen } from '../ui'
import { Glyph } from './Glyph'

const EMPTY: ChatMessage[] = []

/** 9b (spec § 5): one session's transcript, read-only in 2a. */
export function SessionScreen() {
  const id = useMobile((s) => s.sessionId)
  return id ? <SessionView key={id} id={id} /> : null
}

function SessionView({ id }: { id: string }) {
  const session = useOrbital((s) => s.sessions[id])
  const messages = useOrbital((s) => s.transcripts[id] ?? EMPTY)
  const models = useOrbital((s) => s.models)
  const tag = useOrbital((s) => (session ? s.tags.find((t) => t.id === session.tagIds[0]) : undefined))
  const select = useOrbital((s) => s.select)
  const loadOlder = useOrbital((s) => s.loadOlder)
  const applySessionEvent = useOrbital((s) => s.applySessionEvent)
  const ready = useMobile((s) => s.ready)
  const asOf = useMobile((s) => s.asOf)
  const goBack = useMobile((s) => s.goBack)
  const [exhausted, setExhausted] = useState(false)
  const offline = !ready
  const now = useNow(offline, CLOCK_TICK_MS)

  // Open: from the cache while the Mac is away, over the tunnel when it is
  // not (spec § 4). Seated as loaded, so the reconnect's resync replaces it
  // with the Mac's page rather than prepending to it.
  useEffect(() => {
    let live = true
    void (async () => {
      if (!useMobile.getState().ready) {
        const cached = await readTranscriptCache(id)
        if (live && cached && !useOrbital.getState().historyLoaded[id]) {
          useOrbital.setState((s) => ({
            transcripts: { ...s.transcripts, [id]: cached.value },
            historyLoaded: { ...s.historyLoaded, [id]: true },
          }))
        }
      }
      if (live) await select(id)
    })()
    clientRef.seen(id)
    return () => {
      live = false
      // Leaving drops the held transcript (the store's own rule), so coming back reads the file again.
      useOrbital.setState((s) => (s.ui.selectedId === id ? { ui: { ...s.ui, selectedId: null } } : s))
    }
  }, [id, select])

  useEffect(
    () => getSocket().subscribe(`session:${id}`, (msg: SessionEvent) => applySessionEvent(id, msg)),
    [id, applySessionEvent],
  )

  // Pages of TRANSCRIPT_PAGE_SIZE, "older" as the reader nears the top.
  const handleLoadOlder = useCallback(async () => {
    const added = await loadOlder(id)
    if (added === null) return null
    if (added.length === 0) setExhausted(true)
    return added.length
  }, [loadOlder, id])

  const key = session ? sessionStateKey(session) : null
  const header = (
    <div className="pb-1.5 pt-1">
      <div className="flex items-center gap-1 pr-4">
        <button type="button" aria-label="Back" onClick={() => goBack()} className="min-h-11 min-w-11 text-[22px] text-text-soft">
          ‹
        </button>
        <h1 className="min-w-0 flex-1 truncate text-[16px] font-semibold">{session?.title || 'Untitled session'}</h1>
        {session && key && (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tracking-[0.1em]" style={{ color: stateColor(key) }}>
            <Glyph session={session} offline={offline} />
            {stateLine(key, offline, asOf, now)}
          </span>
        )}
      </div>
      {session && (
        <div className="flex min-w-0 items-center gap-2 pl-11 pr-4 font-mono text-[11px] text-text-muted">
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tag ? tagColor(tag.hue) : 'var(--state-neutral)' }} />
          <span className="truncate">{basename(session.cwd)}</span>
          {session.git && <span className="truncate">⎇ {session.git.ref}</span>}
        </div>
      )}
    </div>
  )

  // Where the data ends while the Mac sleeps (9b offline).
  const divider = offline ? (
    <div className="my-4 flex items-center gap-3 font-mono text-[10px] tracking-[0.14em] text-text-muted">
      <span className="h-px flex-1 bg-panel-border" />
      <span>NOTHING NEWER · MAC ASLEEP</span>
      <span className="h-px flex-1 bg-panel-border" />
    </div>
  ) : undefined

  // The composer's place: 9p's line for a terminal session; nothing for an Orbital one until 2b.
  const footer =
    session && isReadOnly(session) ? (
      <div className="border-t border-panel-border px-4 py-3 text-center font-mono text-[11px] text-text-muted">
        terminal session · no composer
      </div>
    ) : undefined

  return (
    <MobileScreen header={header} footer={footer} scroll={false}>
      <TranscriptView
        messages={messages}
        isWorking={!offline && session?.status === 'working'}
        models={models}
        resetKey={id}
        sessionId={id}
        onLoadOlder={ready ? handleLoadOlder : undefined}
        exhausted={exhausted}
        readOnly
        footer={divider}
        footerKey={offline ? 'offline' : 'live'}
      />
    </MobileScreen>
  )
}
```

In `web/src/mobile/MobileApp.tsx`, add `import { SessionScreen } from './screens/SessionScreen'` and replace `{screen === 'session' && <ScreenPending name="session" />}` with `{screen === 'session' && <SessionScreen />}`.

- [ ] **Step 6: Check `TranscriptView`'s required props**

Run: `npm run typecheck -w @orbital/web`
Expected: no errors. If `TranscriptView` reports a required prop this screen does not pass, read its `TranscriptViewProps` in `web/src/panels/TranscriptView.tsx` and pass the read-only value (for a callback, omit it if optional; nothing in `panels/` may change for this).

- [ ] **Step 7: See a transcript on the emulator**

Rebuild and install as in Task 10 Step 6 (local stack running, app paired). Tap a session: `adb shell uiautomator dump /sdcard/ui.xml >/dev/null && adb exec-out cat /sdcard/ui.xml > /tmp/ui.xml` and read `/tmp/ui.xml` for the first session row's `bounds="[x1,y1][x2,y2]"` (the row's title text appears as a `text` or `content-desc` attribute), then `adb shell input tap <x> <y>` at its centre, `sleep 3`, `adb exec-out screencap -p > /tmp/orbital-mobile-session.png`.
Expected: the sticky two-row header (title, state word; folder and branch), the transcript's last page with tool rows at touch height, images (if the session has any) loading into their reserved boxes; a terminal session shows "terminal session · no composer" at the bottom. Read the PNG. If the dump carries no WebView text on this emulator image, record that in the task report and rely on the main session's browser pass for this screen.

- [ ] **Step 8: Tests, lint, guard**

Run: `npm run test:run -w @orbital/web && npm run lint && npm run build:mobile -w @orbital/web && npm run test:bundle -w @orbital/web`
Expected: all pass; the guard still finds no three.js (the transcript panels pull none in).

- [ ] **Step 9: Commit**

```bash
git add web/src/store/store.ts web/src/mobile web/src/test/mobilestore.test.ts
git commit -m "feat(mobile): 9b read-only transcript in pages, with the offline divider"
```

---

### Task 12: 9f Settings

**Files:**
- Create: `web/src/mobile/screens/SettingsScreen.tsx`
- Modify: `web/src/mobile/MobileApp.tsx`

**Interfaces:**
- Consumes: Task 6 (`readNotificationsCache`, `writeNotificationsCache`), Task 7 (`clientRef.getNotifications`, `clientRef.setNotifications`), Task 8 (`useMobile`: `pairing`, `macName`, `macOnline`, `ready`, `goBack`; `forgetEverything`), Task 9 (`MobileScreen`, `PrimaryButton`, `SecondaryButton`, `SectionLabel`, `Toggle`), Task 10 (`relayHost`), Task 5 (`__MOBILE_VERSION__`); `formatFingerprint` (`@orbital/shared/remote/keys`), `NotificationSettings` (`@orbital/shared/remote/messages`).
- Produces: `NOTIFICATION_ROWS: readonly { key: keyof NotificationSettings; label: string }[]`, `SettingsScreen()`.

This task is screens only: its logic (the rules' cache parser, the client calls, `forgetEverything`) is tested where it lives. The verification is the emulator or the browser.

- [ ] **Step 1: Write the settings screen**

Create `web/src/mobile/screens/SettingsScreen.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { formatFingerprint } from '@orbital/shared/remote/keys'
import type { NotificationSettings } from '@orbital/shared/remote/messages'
import { useOrbital } from '../../store/store'
import { forgetEverything } from '../forget'
import { relayHost } from '../format'
import { readNotificationsCache, writeNotificationsCache } from '../platform/cache'
import { useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { MobileScreen, PrimaryButton, SecondaryButton, SectionLabel, Toggle } from '../ui'

/** The desktop's five rows, in its order and with its words (Settings → Notifications). */
export const NOTIFICATION_ROWS: readonly { key: keyof NotificationSettings; label: string }[] = [
  { key: 'needsInput', label: 'A session needs your input' },
  { key: 'sessionEnded', label: 'A session ends' },
  { key: 'sessionFailed', label: 'A session fails' },
  { key: 'onlyWhenBackground', label: 'Only when Orbital is in the background' },
  { key: 'sound', label: 'Play a sound' },
]

/** 9f (spec § 5): the Mac, this phone's notification rules, the relay. */
export function SettingsScreen() {
  const pairing = useMobile((s) => s.pairing)
  const macName = useMobile((s) => s.macName)
  const macOnline = useMobile((s) => s.macOnline)
  const ready = useMobile((s) => s.ready)
  const goBack = useMobile((s) => s.goBack)
  const live = useOrbital((s) => Object.values(s.sessions).filter((x) => x.status !== 'ended').length)
  const [rules, setRules] = useState<NotificationSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const name = macName ?? pairing?.macName ?? 'Your Mac'

  // Read on open: from the Mac when the tunnel is up, as last read when it is not.
  useEffect(() => {
    let current = true
    void (async () => {
      const cached = await readNotificationsCache()
      if (current && cached) setRules(cached.value)
      if (!ready) return
      try {
        const fresh = await clientRef.getNotifications()
        if (!current) return
        setRules(fresh)
        await writeNotificationsCache(fresh, Date.now())
      } catch {
        // The cached rules, or none, stand.
      }
    })()
    return () => {
      current = false
    }
  }, [ready])

  const toggle = async (key: keyof NotificationSettings, value: boolean) => {
    if (!rules) return
    setSaving(true)
    try {
      const saved = await clientRef.setNotifications({ ...rules, [key]: value })
      setRules(saved)
      await writeNotificationsCache(saved, Date.now())
    } catch {
      // Unchanged: the Mac never took it, and the row still shows what it holds.
    } finally {
      setSaving(false)
    }
  }

  const replace = async () => {
    setConfirming(false)
    // Forget the pairing, the identity and the cache; the scanner comes next.
    await forgetEverything({ unpaired: false })
  }

  const header = (
    <div className="flex items-center gap-1 px-1 py-1">
      <button type="button" aria-label="Back" onClick={() => goBack()} className="min-h-11 min-w-11 text-[22px] text-text-soft">
        ‹
      </button>
      <h1 className="text-[17px] font-semibold">Settings</h1>
    </div>
  )

  return (
    <MobileScreen header={header}>
      <SectionLabel>MAC</SectionLabel>
      <div className="mx-4 rounded-[12px] border border-panel-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[15px] text-text-bright">{name}</span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">{macOnline ? 'online' : 'offline'}</span>
        </div>
        <div className="mt-0.5 font-mono text-[11px] text-text-muted">
          {live} live {live === 1 ? 'session' : 'sessions'}
        </div>
        <div className="mt-3">
          <SecondaryButton onClick={() => setConfirming(true)}>Pair a different Mac</SecondaryButton>
        </div>
      </div>

      <SectionLabel>NOTIFICATIONS</SectionLabel>
      <div className="mx-4 rounded-[12px] border border-panel-border">
        {NOTIFICATION_ROWS.map((row) => (
          <div key={row.key} className="flex min-h-12 items-center gap-3 border-b border-panel-border px-4 last:border-b-0">
            <span className="flex-1 text-[14px] text-text-soft">{row.label}</span>
            <Toggle
              label={row.label}
              checked={rules?.[row.key] ?? false}
              disabled={!rules || !ready || saving}
              onChange={(next) => void toggle(row.key, next)}
            />
          </div>
        ))}
      </div>
      <p className="px-4 pt-2 text-[12px] text-text-muted">Just for this phone. Copied from your Mac when you paired.</p>

      <SectionLabel>ADVANCED</SectionLabel>
      <div className="mx-4 rounded-[12px] border border-panel-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[14px] text-text-soft">Relay</span>
          <span className="ml-auto truncate font-mono text-[12px] text-text-muted">{pairing ? relayHost(pairing.relay) : '—'}</span>
        </div>
        <p className="mt-1 text-[12px] text-text-muted">Must match the relay set on the Mac.</p>
      </div>

      <footer className="px-4 py-8 text-center font-mono text-[10.5px] text-text-muted">
        <div>orbital mobile {__MOBILE_VERSION__}</div>
        {pairing && <div className="mt-1">{formatFingerprint(pairing.fingerprint)}</div>}
      </footer>

      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Replace ${name}?`}
          onClick={() => setConfirming(false)}
          className="fixed inset-0 z-20 flex items-end bg-[rgba(2,4,9,.6)]"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full rounded-t-[16px] border-t border-panel-border bg-panel-solid px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-5"
          >
            <h2 className="text-[17px] font-semibold">Replace {name}?</h2>
            <p className="mt-2 text-[14px] text-text-soft">
              This phone forgets {name}, the sessions it showed and its own key. You scan the new Mac&apos;s code next.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <PrimaryButton onClick={() => void replace()}>Pair a different Mac</PrimaryButton>
              <SecondaryButton onClick={() => setConfirming(false)}>Cancel</SecondaryButton>
            </div>
          </div>
        </div>
      )}
    </MobileScreen>
  )
}
```

In `web/src/mobile/MobileApp.tsx`, add `import { SettingsScreen } from './screens/SettingsScreen'` and replace `{screen === 'settings' && <ScreenPending name="settings" />}` with `{screen === 'settings' && <SettingsScreen />}`.

- [ ] **Step 2: Typecheck, tests, lint, guard**

Run: `npm run typecheck -w @orbital/web && npm run test:run -w @orbital/web && npm run lint && npm run build:mobile -w @orbital/web && npm run test:bundle -w @orbital/web`
Expected: no errors; all pass.

- [ ] **Step 3: See it on the emulator, and that a toggle reaches the Mac**

Rebuild and install (local stack running, app paired): `npm run build -w @orbital/mobile && npm run apk -w @orbital/mobile && adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk && adb shell am start -n io.slothworks.orbital.mobile/.MainActivity && sleep 4`. Tap the ⚙ (find its bounds with `uiautomator dump` by `content-desc="Settings"`, as in Task 11 Step 7), `sleep 2`, screenshot to `/tmp/orbital-mobile-settings.png`. Then tap the "A session ends" switch the same way and run `curl -s http://127.0.0.1:4848/api/remote | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).devices.map(d=>d.notifications)))'`.
Expected: the screenshot shows MAC (studio, online, the live count, "Pair a different Mac"), the five rows, the caption, ADVANCED with `127.0.0.1:4840`, and the footer `orbital mobile 0.1.0` with the fingerprint; after the tap, the Mac's record shows `sessionEnded: false`. If the dump has no WebView nodes, record it and rely on the browser pass.

- [ ] **Step 4: Commit**

```bash
git add web/src/mobile
git commit -m "feat(mobile): 9f settings — the Mac, this phone's notification rules, the relay"
```

---

### Task 13: 9h Unpaired and 9i Version mismatch

**Files:**
- Create: `web/src/mobile/screens/UnpairedScreen.tsx`, `web/src/mobile/screens/MismatchScreen.tsx`
- Modify: `web/src/mobile/MobileApp.tsx`
- Delete: `web/src/mobile/screens/ScreenPending.tsx`

**Interfaces:**
- Consumes: Task 8 (`useMobile`: `macName`, `mismatch`, `checkedAt`, `go`; `MIN_SERVER_VERSION`; `RETRY_WINDOW_MS`, `CLOCK_TICK_MS`; the 9h/9i transitions in `reduce`, tested there), Task 7 (`clientRef.recheck`), Task 9 (`MobileScreen`, `PrimaryButton`, `SecondaryButton`), Task 10 (`checkedLabel`), Task 5 (`__MOBILE_VERSION__`); `App` (`@capacitor/app`).
- Produces: `UnpairedScreen()`, `MismatchScreen()`.

The state behind both screens — which events lead here, what "Try again" and the foreground re-check do — is Task 8's, tested in `mobilestate.test.ts`. This task draws them.

- [ ] **Step 1: Write the two screens**

Create `web/src/mobile/screens/UnpairedScreen.tsx`:

```tsx
import { App } from '@capacitor/app'
import { useMobile } from '../state'
import { MobileScreen, PrimaryButton, SecondaryButton } from '../ui'

/**
 * 9h (spec § 4): the Mac revoked this phone. Its pairing, identity and cache
 * are already gone; this screen comes back on every launch until a new
 * pairing. "Not now" leaves the app here.
 */
export function UnpairedScreen() {
  const macName = useMobile((s) => s.macName)
  const name = macName || 'Your Mac'
  return (
    <MobileScreen>
      <div className="flex flex-col gap-5 px-6 pt-20">
        <h1 className="text-[22px] font-semibold">This phone was unpaired</h1>
        <p className="text-[14px] text-text-soft">
          {name} removed this phone, so it can no longer see your sessions. Pair again to bring them back.
        </p>
        <PrimaryButton onClick={() => useMobile.getState().go('pairing')}>Pair again</PrimaryButton>
        <SecondaryButton onClick={() => void notNow()}>Not now</SecondaryButton>
      </div>
    </MobileScreen>
  )
}

async function notNow(): Promise<void> {
  try {
    await App.minimizeApp()
  } catch {
    // A browser cannot be minimized; the screen simply stays.
  }
}
```

Create `web/src/mobile/screens/MismatchScreen.tsx`:

```tsx
import { useState } from 'react'
import { useNow } from '../../lib/useNow'
import { CLOCK_TICK_MS, RETRY_WINDOW_MS } from '../constants'
import { checkedLabel } from '../format'
import { useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { MobileScreen, PrimaryButton } from '../ui'
import { MIN_SERVER_VERSION } from '../version'

/**
 * 9i (spec § 5): the Mac refused our protocol, or runs an Orbital older than
 * MIN_SERVER_VERSION. The whole app waits behind this. "Try again" is one
 * bounded reconnect and hello (RETRY_WINDOW_MS); every return to the
 * foreground checks again (`boot.ts`), and a new-enough hello leaves for
 * the list by itself (`reduce`).
 */
export function MismatchScreen() {
  const mismatch = useMobile((s) => s.mismatch)
  const checkedAt = useMobile((s) => s.checkedAt)
  const [trying, setTrying] = useState(false)
  const now = useNow(checkedAt !== null, CLOCK_TICK_MS)
  const needed = mismatch?.needed ?? MIN_SERVER_VERSION

  const tryAgain = async () => {
    setTrying(true)
    await clientRef.recheck(RETRY_WINDOW_MS)
    useMobile.setState({ checkedAt: Date.now() })
    setTrying(false)
  }

  return (
    <MobileScreen>
      <div className="flex flex-col gap-5 px-6 pt-20">
        <h1 className="text-[22px] font-semibold">Update Orbital on the Mac</h1>
        <p className="text-[14px] text-text-soft">This phone needs Orbital {needed} or newer on the Mac.</p>
        <dl className="flex flex-col gap-2 font-mono text-[12px] text-text-muted">
          <div className="flex justify-between">
            <dt>Mac</dt>
            <dd className="text-text-soft">{mismatch?.macVersion ?? 'unknown'}</dd>
          </div>
          <div className="flex justify-between">
            <dt>this phone</dt>
            <dd className="text-text-soft">orbital mobile {__MOBILE_VERSION__}</dd>
          </div>
        </dl>
        <PrimaryButton disabled={trying} onClick={() => void tryAgain()}>
          Try again
        </PrimaryButton>
        {checkedAt !== null && <p className="font-mono text-[11px] text-text-muted">{checkedLabel(checkedAt, now)}</p>}
      </div>
    </MobileScreen>
  )
}
```

Replace `web/src/mobile/MobileApp.tsx` with:

```tsx
import { MismatchScreen } from './screens/MismatchScreen'
import { PairingScreen } from './screens/PairingScreen'
import { SessionListScreen } from './screens/SessionListScreen'
import { SessionScreen } from './screens/SessionScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { UnpairedScreen } from './screens/UnpairedScreen'
import { useMobile } from './state'

/** One screen at a time, chosen by in-memory state (spec § 5). */
export function MobileApp() {
  const screen = useMobile((s) => s.screen)
  return (
    <div className="h-full bg-space font-sans text-text-bright">
      {screen === 'pairing' && <PairingScreen />}
      {screen === 'list' && <SessionListScreen />}
      {screen === 'session' && <SessionScreen />}
      {screen === 'settings' && <SettingsScreen />}
      {screen === 'unpaired' && <UnpairedScreen />}
      {screen === 'mismatch' && <MismatchScreen />}
    </div>
  )
}
```

Run: `git rm web/src/mobile/screens/ScreenPending.tsx`

- [ ] **Step 2: Typecheck, tests, lint, guard**

Run: `npm run typecheck -w @orbital/web && npm run test:run -w @orbital/web && npm run lint && npm run build:mobile -w @orbital/web && npm run test:bundle -w @orbital/web`
Expected: no errors; all pass.

- [ ] **Step 3: Drive both states from the Mac**

With the local stack running and the emulator paired, rebuild and install as in Task 12 Step 3.

Mismatch: stop the server (`kill $(lsof -t -iTCP:4848 -sTCP:LISTEN)`) and start it again with `ORBITAL_VERSION=0.16.0` added to the Task 9 command's environment; wait 10 s; screenshot `/tmp/orbital-mobile-mismatch.png`.
Expected: "Update Orbital on the Mac", Mac `0.16.0`, this phone `orbital mobile 0.1.0`, Try again. Restart the server without `ORBITAL_VERSION`, tap Try again (bounds by text "Try again" from `uiautomator dump`), and expect the list within `RETRY_WINDOW_MS` plus a moment.

Unpaired: `PHONE=$(curl -s http://127.0.0.1:4848/api/remote | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).devices[0].id))') && curl -s -X DELETE "http://127.0.0.1:4848/api/remote/devices/$PHONE"`; wait 3 s; screenshot `/tmp/orbital-mobile-unpaired.png`; then `adb shell am force-stop io.slothworks.orbital.mobile && adb shell am start -n io.slothworks.orbital.mobile/.MainActivity && sleep 3` and screenshot again.
Expected: both screenshots show "This phone was unpaired" naming studio — the second proves it survives a relaunch. Read the PNGs.

- [ ] **Step 4: Commit**

```bash
git add web/src/mobile
git commit -m "feat(mobile): 9h unpaired and 9i version mismatch"
```

---

### Task 14: The relay tells a returning phone that its pair is gone

**Files:**
- Modify: `shared/src/remote/relayApi.ts` (`relayWsUrl` gains a `paired` flag), `shared/test/relayApi.test.ts`
- Modify: `shared/src/remote/client.ts` (`RemoteClientOptions.expectPaired`), `shared/test/client.test.ts`
- Modify: `relay/src/ws.ts` (`handleSocket` takes the expected Mac; `attach` answers `unpaired`), `relay/src/app.ts` (reads the query), `relay/test/helpers.ts` (`connectDevice` takes extra query), `relay/test/ws.test.ts`
- Modify: `web/src/mobile/connect.ts` (`newClient` passes `expectPaired`)
- Modify: `server/test/remoteClient.test.ts` (revoked while away)
- Modify: `docs/superpowers/specs/2026-09-30-mobile-remote-design.md` § 7 (one contract bullet), `docs/ops/run-the-relay.md` ("More than one instance" mentions the flag)

**Interfaces:**
- Consumes: Task 1's `RemoteClient`, `RemoteClientOptions`, `RemoteClientEvent` (`unpaired` already exists and Task 8's `reduce` already maps it to 9h); Task 2's harness (`startMacAndRelay`, `until`); Task 8's `newClient`/`connect` in `web/src/mobile/connect.ts`; Task 9's `runPairing` (which builds its client WITHOUT `expectPaired`); existing `relay/test/helpers.ts` `connectDevice`, `relay/src/store.ts` `revokePair`.
- Produces: `relayWsUrl(httpUrl: string, mac: string, opts?: { paired?: boolean }): string`; `RemoteClientOptions.expectPaired?: boolean`; relay `handleSocket(socket: WebSocket, ctx: WsContext, expectMac: string | null): void`; relay answers `{ type: 'unpaired', mac }` right after `ok` when the socket's query says `paired=1` and the named Mac has no pair with this device.

Why: a phone revoked while it was not connected never hears `bye` or `unpaired` (the relay sends `unpaired` to a socket that does not exist), and `ok` lists only peers that are online — so the phone would read its Mac as asleep forever. The phone cannot tell "no pair" from "Mac offline" on its own; the relay can. A phone that is only about to pair has no pair yet either, which is why the phone has to say that it expects one.

- [ ] **Step 1: Write the failing `relayWsUrl` test**

In `shared/test/relayApi.test.ts`, next to the existing `relayWsUrl` expectations, add:

```ts
  it('adds paired=1 only when asked', () => {
    expect(relayWsUrl('https://orbital-relay.example', 'm1', { paired: true })).toBe('wss://orbital-relay.example/ws?mac=m1&paired=1');
    expect(relayWsUrl('https://orbital-relay.example', 'm1', { paired: false })).toBe('wss://orbital-relay.example/ws?mac=m1');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd shared && npx vitest run test/relayApi.test.ts`
Expected: FAIL — the third argument is ignored, no `paired=1` in the URL.

- [ ] **Step 3: Extend `relayWsUrl`**

In `shared/src/remote/relayApi.ts` replace the function:

```ts
/**
 * The relay's socket URL for a device. `mac` is the Mac the device is anchored
 * to (the QR's `mac`); `paired` says the device believes it is paired with
 * that Mac, so the relay answers `unpaired` on connect when it is not
 * (relay/src/ws.ts). A phone that is only about to pair leaves it off.
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
```

- [ ] **Step 4: Run the shared tests**

Run: `cd shared && npx vitest run test/relayApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing client test**

In `shared/test/client.test.ts`, in the `describe` that builds clients with `FakeSocket` (Task 1), add:

```ts
  it('asks the relay to confirm the pair only when built from a stored pairing', () => {
    const expecting = new RemoteClient({ ...baseOptions(), expectPaired: true });
    expecting.start();
    expect(FakeSocket.all.at(-1)!.url).toContain('paired=1');
    expecting.stop();
    const pairing = new RemoteClient(baseOptions());
    pairing.start();
    expect(FakeSocket.all.at(-1)!.url).not.toContain('paired=');
    pairing.stop();
  });
```

(`baseOptions()` is whatever helper Task 1's test file uses to build a client's options with `WebSocketImpl: FakeSocket`; if it has another name, use that name and do not add a second helper.)

- [ ] **Step 6: Run it to verify it fails**

Run: `cd shared && npx vitest run test/client.test.ts -t "stored pairing"`
Expected: FAIL — `expectPaired` is not an option and the URL never carries `paired=1`.

- [ ] **Step 7: Add the option**

In `shared/src/remote/client.ts`, in `RemoteClientOptions` after `app: string;`:

```ts
  /**
   * True when the client is built from a stored pairing: the relay then
   * answers `unpaired` on connect if the Mac no longer has this phone, which
   * is the only way a phone revoked while it was away ever learns it. Off
   * while pairing, when no pair exists yet.
   */
  expectPaired?: boolean;
```

and in `connect()` replace the URL line:

```ts
      ws = new this.opts.WebSocketImpl(relayWsUrl(this.opts.relayUrl, this.opts.mac, { paired: this.opts.expectPaired === true }));
```

- [ ] **Step 8: Run the client tests**

Run: `cd shared && npx vitest run test/client.test.ts`
Expected: PASS, every test.

- [ ] **Step 9: Write the failing relay test**

In `relay/test/helpers.ts` give `connectDevice` a fourth parameter for extra query text:

```ts
export async function connectDevice(base: string, identity: Identity, mac = deviceId(identity.publicKey), query = ''): Promise<Device> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?mac=${mac}${query}`);
```

(only the signature and the URL line change). In `relay/test/ws.test.ts` add:

```ts
  it('tells a phone that expects its pair that the pair is gone, and says nothing to one that is about to pair', async () => {
    const { base, store, mac, phone } = await relay();
    const macId = deviceId(mac.publicKey);
    await store.revokePair(macId, deviceId(phone.publicKey));
    const back = await connectDevice(base, phone, macId, '&paired=1');
    expect(await back.next('unpaired')).toMatchObject({ type: 'unpaired', mac: macId });
    const fresh = await connectDevice(base, generateIdentity(), macId);
    await sleep(50);
    expect(fresh.control.find((m) => m.type === 'unpaired')).toBeUndefined();
    const still = await connectDevice(base, phone, macId, '&paired=1');
    // Not revoked: a paired phone with paired=1 hears nothing either.
    await store.confirmPair(macId, deviceId(phone.publicKey), Date.now());
    await sleep(50);
    expect(still.control.find((m) => m.type === 'unpaired')).toBeUndefined();
    back.ws.close(); fresh.ws.close(); still.ws.close();
  });
```

- [ ] **Step 10: Run it to verify it fails**

Run: `cd relay && npx vitest run test/ws.test.ts -t "pair is gone"`
Expected: FAIL — `next('unpaired')` never resolves (the test times out) because the relay ignores the query.

- [ ] **Step 11: Read the query on the relay**

In `relay/src/app.ts` replace the socket route:

```ts
  app.get('/ws', { websocket: true }, (socket, req) => {
    // `?mac=` names the Mac the device is anchored to; `paired=1` says the
    // device believes it is paired with it, and asks to be told if it is not.
    const q = req.query as { mac?: string; paired?: string };
    handleSocket(socket, ctx, q.paired === '1' && typeof q.mac === 'string' ? q.mac : null);
  });
```

In `relay/src/ws.ts` change the signatures and add the answer:

```ts
export function handleSocket(socket: WebSocket, ctx: WsContext, expectMac: string | null): void {
```

(the body is unchanged except the `attach` call becomes `attach({ socket, id: pub, peers }, ctx, early, expectMac);`)

```ts
function attach(conn: Conn, ctx: WsContext, early: [RawData, boolean][], expectMac: string | null): void {
  const { socket, id, peers } = conn;
  const previous = ctx.connections.add(conn);
  // One socket per device: the predecessor is replaced outright, since a
  // closing handshake would leave it routing frames until the peer answers.
  previous?.socket.terminate();
  // A phone that came online has seen everything pending for it.
  ctx.tracker.clear(id);
  log(`device ${short(id)} connected${previous ? ', replacing its previous socket' : ''}`);

  send(socket, { type: 'ok', peers: [...peers].filter((p) => ctx.connections.isOnline(p)) });
  // A device that expects a pair the relay no longer holds would otherwise
  // read its Mac as asleep forever: `ok` lists only online peers, and the
  // `unpaired` sent at revoke time went to a socket that did not exist.
  if (expectMac !== null && !peers.has(expectMac)) send(socket, { type: 'unpaired', mac: expectMac });
```

(the rest of `attach` is unchanged.) Fix every other caller of `handleSocket` the compiler reports (`relay/src/app.ts` is the only one today).

- [ ] **Step 12: Run the relay tests**

Run: `cd relay && npx vitest run && npm run typecheck`
Expected: PASS, every test; typecheck clean.

- [ ] **Step 13: The phone sends the flag**

In `web/src/mobile/connect.ts` change `newClient`:

```ts
export function newClient(relayUrl: string, mac: string, identity: Identity): RemoteClient {
  // The WebView's own WebSocket; `ws` plays it in the server's end-to-end test.
  // Built from a stored pairing, so the relay is asked to say if that pair is gone.
  return new RemoteClient({ relayUrl, mac, identity, WebSocketImpl: WebSocket, app: mobileApp(), expectPaired: true })
}
```

Check `web/src/mobile/pairingRun.ts` (Task 9): the client it builds while pairing must NOT pass `expectPaired` — it constructs `RemoteClient` itself, not through `newClient`. If it uses `newClient`, give `newClient` a second signature `newClient(relayUrl, mac, identity, { expectPaired }: { expectPaired: boolean })` and pass `false` there.

Run: `npm run typecheck -w @orbital/web`
Expected: clean.

- [ ] **Step 14: Write the failing end-to-end case**

In `server/test/remoteClient.test.ts` add, using the same harness and helpers as the existing cases:

```ts
  it('a phone revoked while it was away learns it on its next connect', async () => {
    const { relayUrl, app, api } = await startMacAndRelay(closers);
    const identity = generateIdentity();
    // Pair as the other cases do (QR → connect → redeem → confirm), then stop the phone.
    const first = await pairPhone({ relayUrl, app, api }, identity);
    first.stop();
    await until(async () => (await api('GET', '/api/remote')).json().devices[0]?.online === false);
    const phoneId = deviceId(identity.publicKey);
    expect((await api('DELETE', `/api/remote/devices/${phoneId}`)).statusCode).toBe(200);
    const back = new RemoteClient({ ...first.options, expectPaired: true });
    const unpaired = new Promise<RemoteClientEvent>((resolve) => back.on((e) => { if (e.type === 'unpaired') resolve(e); }));
    back.start();
    expect(await unpaired).toEqual({ type: 'unpaired' });
    back.stop();
  });
```

`pairPhone` is the test file's own helper from Task 2 that runs the pairing flow and returns the live client and the options it was built with; if Task 2 named it differently, use that name, and if it does not return `options`, build the second client from the same `relayUrl`, `mac` (from the QR) and `identity` the helper used. Do not add a second pairing helper.

- [ ] **Step 15: Run it to verify it fails**

Run: `cd server && env ORBITAL_STATIC_DIR= ORBITAL_MIGRATIONS_DIR= npx vitest run test/remoteClient.test.ts -t "revoked while it was away"`
Expected: FAIL until the relay change is picked up — the server's test imports the relay from `@orbital/relay`, so this passes as soon as Steps 11–13 are in; if it fails on `unpaired` never arriving, check that the client's URL carries `paired=1` (Step 7) and that `pairPhone`'s QR `mac` is what `back` was built with.

- [ ] **Step 16: Run the server suite**

Run: `cd server && env ORBITAL_STATIC_DIR= ORBITAL_MIGRATIONS_DIR= npx vitest run`
Expected: PASS, every test.

- [ ] **Step 17: Record the contract**

In `docs/superpowers/specs/2026-09-30-mobile-remote-design.md` § 7, after the bullet that starts "**The relay's `?mac=` query parameter is the Mac's id from the QR**", add:

```markdown
- **Send `paired=1` when connecting from a stored pairing** (added
  2026-10-02 by [[2026-10-02-mobile-app-read]] Task 14): the relay then
  answers `unpaired` right after `ok` when the named Mac has no pair with
  this phone, which is how a phone revoked while it was away learns it.
  Leave the flag off while pairing — no pair exists yet, and the relay
  would say so.
```

In `docs/ops/run-the-relay.md`, in the "More than one instance" section, after the sentence about `?mac=`, add: "Since 2026-10-02 the same query may carry `paired=1`, which the relay does read: a device that expects a pair the relay no longer holds is told `unpaired` on connect."

Run: `bunx @slothworks/atlas validate`
Expected: no errors.

- [ ] **Step 18: Commit**

```bash
git add shared/src/remote/relayApi.ts shared/test/relayApi.test.ts shared/src/remote/client.ts shared/test/client.test.ts relay/src/ws.ts relay/src/app.ts relay/test/helpers.ts relay/test/ws.test.ts web/src/mobile/connect.ts server/test/remoteClient.test.ts docs/superpowers/specs/2026-09-30-mobile-remote-design.md docs/ops/run-the-relay.md
git commit -m "feat(relay): a phone that expects its pair is told when it is gone"
```

---

### Task 15: Wrap-up — documents, full verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-02-mobile-app-design.md` (an "As built (2a)" section), `docs/ops/build-the-android-app.md` (status), this plan (status), `README.md` (check)

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Record what was built against the spec**

Append to `docs/superpowers/specs/2026-10-02-mobile-app-design.md`, before `## 8. Known limits of 2a` (keep the spec's `status: active` — 2b is still to come):

```markdown
## As built (2a)

Built from [[2026-10-02-mobile-app-read]]. Decisions the spec left open:

- **Redeem across origins.** The WebView's page is `https://localhost`, so
  the relay now answers CORS for `/pair/redeem` and nothing else
  ([[the-relay-answers-cors-for-redeem]]). A deployed relay must be
  redeployed before a phone can pair through it.
- **The bundle guard reads a module list.** A Vite manifest names chunks,
  not the modules in them; `vite.mobile.config.ts` also writes
  `.vite/chunk-modules.json`, and `web/src/test/mobilebundle.test.ts` reads
  both. `npm test` skips it without a build; `npm run build -w @orbital/mobile`
  runs it after every build, where a missing build fails.
- **Groups.** WAITING sits with WORKING; DONE and INTERRUPTED sit with IDLE
  and keep their own word on the row (`web/src/mobile/sessionList.ts`).
- **`MIN_SERVER_VERSION` is `0.17.1`**, the release that shipped Settings → Mobile.
- **The relay link's silence watchdog runs only while a tunnel is up.** The
  relay's pings never reach page code, so a quiet link with the Mac away
  cannot be told from a dead one; every return to the foreground rebuilds
  the link instead (`recheck`).
- **The paste field** shows when there is no scanner and in every dev build
  (`ORBITAL_MOBILE_DEV=1`), where a complete code pairs as it is typed —
  that is how `mobile/scripts/pair-emulator.sh` pairs the emulator.
- **A phone revoked while it was away** is told so by the relay on its
  next connect: the client connects with `paired=1` when built from a
  stored pairing, and the relay answers `unpaired` when the Mac has no pair
  with it (Task 14; parent spec § 7).
```

In `docs/ops/build-the-android-app.md`, change `status: active` to `status: in-force`. In this plan's frontmatter, change `status: active` to `status: done`.

Read `README.md`'s `## Mobile remote` section and check it still describes what exists (Task 5 wrote it); correct anything that is not.

- [ ] **Step 2: Validate the documents**

Run: `bunx @slothworks/atlas validate`
Expected: no errors.

- [ ] **Step 3: Run everything**

Run: `npm run typecheck && npm run lint && npm test -w shared && env ORBITAL_STATIC_DIR= ORBITAL_MIGRATIONS_DIR= npm test -w server && npm run test:run -w @orbital/web && npm test -w desktop && npm test -w relay && npm run build -w @orbital/web && npm run build -w @orbital/mobile && npm run apk -w @orbital/mobile`
Expected: every step passes; the desktop web build (`npm run build -w @orbital/web`) is unaffected by the phone's entry; the APK builds.

- [ ] **Step 4: Stop what the tasks started**

Run: `kill $(lsof -t -iTCP:4848 -sTCP:LISTEN) $(lsof -t -iTCP:4840 -sTCP:LISTEN) $(lsof -t -iTCP:4841 -sTCP:LISTEN) 2>/dev/null; adb emu kill 2>/dev/null; true`
Expected: no listeners left on 4848, 4840, 4841; the emulator closed.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-10-02-mobile-app-design.md docs/ops/build-the-android-app.md docs/superpowers/plans/2026-10-02-mobile-app-read.md README.md
git commit -m "docs: mobile 2a as built, the revoked-while-away gap, runbook in force"
```

The desktop version bump is not part of this plan: the change touches `web/`, `shared/`, `relay/` and `server/test/`, and the controller asks the owner whether and how to bump `desktop/package.json`.

---

## Self-review

**Spec coverage.**
- § 1 workspaces and builds: `mobile/` workspace, config, generated Android project, scripts `build`/`apk`/`run`, the six plugins (Task 5); `index.mobile.html`, `vite.mobile.config.ts` with `dist-mobile` and no proxy, `build:mobile`/`dev:mobile`, the entry `web/src/mobile/main.tsx`, browser fallbacks (localStorage identity, labelled — Task 6/9; paste field — Task 9), the bundle guard (Task 4); `data-platform="mobile"` and `mobile.css` for 9b's row metrics (Task 4); nothing in `panels/` imports `mobile/` (the only panel edits are a data attribute and the image hook). iOS stays out (spec § 6).
- § 2 the client: every bullet in Task 1 — relay link with challenge/auth, `peersOnline` reduced to `macOnline` for its one Mac, backoff, connect timeout, watchdog; the three handshake triggers; hello and re-subscribe; `request` with ids and timeouts, rejection on lost cipher and bye; `subscribe`/`unsubscribe`; `hub` verbatim; `getBlob` with interleaving; `wake`; `redeem` and the bounded wait; notifications, `seen`, `pushToken`; listeners never throw. `putBlob` is 2b. The end-to-end list (pair, hello, subscribe and receive `sessions`, allowed and denied request, image, notifications, Mac away and back, revoke) is Task 2.
- § 3 platform wiring: the three seams (Task 3), `tunnelFetch` and `TunnelSocket` and the image resolver (Task 7), `boot.ts` (Task 8, plus page size in Task 11). `uploadImage`/`uploadAttachment` is routed through `apiFetch` like every call, and `tunnelFetch` refuses its multipart body — 2b sends photos as blobs.
- § 4 state: identity in secure storage, pairing and cache in Preferences (Task 6); unpaired on `bye revoked`, `unpaired`, pair-gone relay error, deleting everything on first contact and persisting 9h (Tasks 6, 8, 13).
- § 5 screens: navigation and back button (Task 8); 9e (Task 9); 9a and its offline card (Task 10); 9b (Task 11); 9f (Task 12); 9h and 9i (Task 13); the 9a header's connecting dot (Task 10).
- § 7 testing: every "worth a test" item has a test — the client's pure parts (Task 1), the end-to-end (Task 2), `tunnelFetch` and `TunnelSocket` (Task 7), offline/unpaired/mismatch derivation, version compare, parsers (Tasks 6, 8), the bundle guard (Task 4). Screens, sizes and motion are untested, as § 7 says.
- § 8 known limits: no push, no writes, no iOS — nothing in the plan contradicts them; a fourth gap found while planning (a phone revoked while away) is closed by Task 14 rather than written down.

**Placeholder scan.** Searched for "TBD", "TODO", "similar to", "add error handling", "fill in": none. Two steps are conditional rather than open: Task 2 Step 4 (what to do if the end-to-end test finds a client bug — it names the files and the test-first order) and Task 11 Step 6 (a `TranscriptView` prop the plan did not foresee — it names the file and forbids changing `panels/`). `ScreenPending` is a named scaffold, created in Task 8 and deleted in Task 13 with the exact replacement lines.

**Type consistency.** Checked across tasks: `RemoteClientEvent` variants (`status`, `presence`, `hello`, `ready`, `bye`, `paired`, `rejected`, `unpaired`, `relay_error`, `hub`, `wake`) are the same in Task 1, the fake client (7), `reduce` (8) and `runPairing` (9); `ClientRef`'s `SwappableClient` covers every method later tasks call on `clientRef` (`request`, `getBlob`, `subscribe`, `unsubscribe`, `getNotifications`, `setNotifications`, `seen`, `recheck`, `stop`); `Pairing` fields (`relay`, `mac`, `macName`, `fingerprint`, `pairedAt`) match between `parse.ts`, `pairingRun.ts` and `forget.ts`; `loadUnpaired` returns `{ macName } | null` everywhere it is read; `MobileScreen`'s `scroll` prop is used only by `SessionScreen`; `configureTranscriptPages` is exported in Task 11 before boot imports it in the same task; `__MOBILE_VERSION__` is declared and defined in Task 5 before `connect.ts` (Task 8) and the screens use it; `CLOCK_TICK_MS` is defined in Task 8 before Tasks 10–13 import it.

**Review Focus.** Each of the five lines has its test in the owning task: foreground recheck (Task 1, "recheck opens a fresh link at once…"), the silent relay (Task 1, "gives up on a socket that never reaches ok…"), the 413 page (Task 7, "hands a 413 and a 403 back…"), messy QR text (Task 9, `parseQrText`), a redeem that cannot succeed (Task 9, `redeemOutcome`).
