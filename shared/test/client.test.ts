import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceId, fromBase64Url, generateIdentity, toBase64Url, type Identity } from '../src/remote/keys.js';
import { FLAG_STATE, FLAG_WAKE, ZERO_WAKE, decodeFrame, encodeFrame } from '../src/remote/frame.js';
import { HANDSHAKE_BYTES, startHandshake, type SessionCipher } from '../src/remote/handshake.js';
import {
  PROTOCOL_VERSION, chunkBlob, decodeInner, encodeInner, type Inner, type MacMessage, type PhoneMessage,
} from '../src/remote/messages.js';
import { verifyAuthSignature, verifyPairingProof, type RelayToDevice } from '../src/remote/relayApi.js';
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
  vi.unstubAllGlobals();
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

  it('rejects a blob whose chunks arrive out of order', async () => {
    const s = setup();
    connect(s);
    const blob = s.client.getBlob(REF);
    const get = s.mac.read(s.sock) as Extract<PhoneMessage, { t: 'blob_get' }>;
    const chunks = chunkBlob(get.id, new Uint8Array(150_000));
    s.mac.send(s.sock, { t: 'blob_meta', id: get.id, status: 200, bytes: 150_000, mediaType: 'image/png' });
    s.mac.sendInner(s.sock, chunks[0]);
    s.mac.sendInner(s.sock, chunks[0]);
    await expect(blob).rejects.toMatchObject({ reason: 'lost' });
    expect(s.client.ready).toBe(true);
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

describe('RemoteClient notifications', () => {
  const SETTINGS = { needsInput: true, sessionEnded: true, sessionFailed: true, onlyWhenBackground: false, sound: true };

  it('settles overlapping calls one reply each, in order', async () => {
    const s = setup();
    connect(s);
    const current = s.client.getNotifications();
    const changed = s.client.setNotifications({ ...SETTINGS, sound: false });
    expect(s.mac.read(s.sock)).toEqual({ t: 'notifications_get' });
    expect(s.mac.read(s.sock)).toMatchObject({ t: 'notifications_set' });
    s.mac.send(s.sock, { t: 'notifications', settings: SETTINGS });
    s.mac.send(s.sock, { t: 'notifications', settings: { ...SETTINGS, sound: false } });
    await expect(current).resolves.toEqual(SETTINGS);
    await expect(changed).resolves.toEqual({ ...SETTINGS, sound: false });
  });
});

describe('RemoteClient redeem', () => {
  const secret = toBase64Url(new Uint8Array(16).fill(7));

  it('posts a signed redeem carrying the proof and answers the relay JSON', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const s = setup();
    await expect(s.client.redeem('tok', secret, 'phone', 'ios')).resolves.toEqual({ status: 200, body: { ok: true } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://relay.test/pair/redeem');
    const sent = JSON.parse(init.body as string);
    expect(sent.payload).toMatchObject({ token: 'tok', name: 'phone', platform: 'ios' });
    expect(verifyPairingProof(fromBase64Url(secret), s.phone.publicKey, sent.payload.proof)).toBe(true);
  });

  it('wraps a body that is not JSON as its error text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })));
    const s = setup();
    await expect(s.client.redeem('tok', secret, 'phone', 'ios')).resolves.toEqual({
      status: 502, body: { error: 'Bad Gateway' },
    });
  });

  it('answers status 0 when the relay is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));
    const s = setup();
    await expect(s.client.redeem('tok', secret, 'phone', 'ios')).resolves.toEqual({
      status: 0, body: { error: 'network' },
    });
  });
});
