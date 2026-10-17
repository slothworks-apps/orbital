import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceId, generateIdentity } from '../src/remote/keys.js';
import { FLAG_WAKE, ZERO_WAKE, decodeFrame, encodeFrame } from '../src/remote/frame.js';
import { CLOSE_BAD_SECRET, verifyRequest, type RelayToDevice } from '../src/remote/relayApi.js';
import {
  CONNECT_TIMEOUT_MS, RECONNECT_DELAY_MS, RECONNECT_MAX_MS, RelayLink, type RelayLinkEvent, type SocketLike,
} from '../src/remote/relayLink.js';
import { MIN_RELAY_VERSION, RELAY_VERSION_HEADER } from '../src/remote/version.js';

/** A WebSocket the test plays the relay through. */
class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  binaryType = 'blob';
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  readonly text: any[] = [];
  readonly frames: Uint8Array[] = [];
  closed = false;

  constructor(readonly url: string) {
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
}

function setup(opts: { fetchImpl?: (input: string, init: RequestInit) => Promise<Response> } = {}) {
  FakeSocket.all = [];
  const identity = generateIdentity();
  const link = new RelayLink({ relayUrl: 'https://relay.test', identity, WebSocketImpl: FakeSocket, ...opts });
  const events: RelayLinkEvent[] = [];
  link.on((e) => events.push(e));
  link.start();
  return { link, identity, events, sock: () => FakeSocket.all[FakeSocket.all.length - 1] };
}

function online(s: ReturnType<typeof setup>, ok: { peers: string[]; pairs?: string[] }): void {
  s.sock().control({ type: 'challenge', nonce: 'n', version: MIN_RELAY_VERSION });
  s.sock().control({ type: 'ok', ...ok });
}

const idOf = () => deviceId(generateIdentity().publicKey);

afterEach(() => {
  vi.useRealTimers();
});

describe('RelayLink', () => {
  it('anchors the socket on its own id unless told another', () => {
    const s = setup();
    expect(new URL(s.sock().url).searchParams.get('mac')).toBe(s.link.id);
  });

  it('reconnects with a doubling delay up to the most, and resets it on ok', () => {
    vi.useFakeTimers();
    const s = setup();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeSocket.all.length;
      s.sock().onclose?.({ code: 1006 });
      let waited = 0;
      while (FakeSocket.all.length === before) {
        vi.advanceTimersByTime(1_000);
        waited += 1_000;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([0, 1, 2, 3, 4, 5].map((n) => Math.min(RECONNECT_DELAY_MS * 2 ** n, RECONNECT_MAX_MS)));
    online(s, { peers: [] });
    const before = FakeSocket.all.length;
    s.sock().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(RECONNECT_DELAY_MS);
    expect(FakeSocket.all.length).toBe(before + 1);
  });

  it('gives up on a socket that never reaches ok', () => {
    vi.useFakeTimers();
    const s = setup();
    const first = s.sock();
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    expect(first.closed).toBe(true);
    expect(s.link.status).toBe('connecting');
  });

  it('ok sets who is online and every pair, and presence keeps the first', () => {
    const s = setup();
    const [a, b, c] = [idOf(), idOf(), idOf()];
    online(s, { peers: [a], pairs: [a, b] });
    expect(s.link.status).toBe('online');
    expect([...s.link.peersOnline]).toEqual([a]);
    expect([...s.link.pairs!]).toEqual([a, b]);
    s.sock().control({ type: 'presence', peer: b, online: true });
    s.sock().control({ type: 'presence', peer: a, online: false });
    expect([...s.link.peersOnline]).toEqual([b]);
    s.sock().control({ type: 'linked', peer: c });
    s.sock().control({ type: 'unpaired', mac: a });
    expect([...s.link.pairs!].sort()).toEqual([b, c].sort());
    expect(s.events).toContainEqual({ type: 'presence', peer: b, online: true });
  });

  it('knows no pairs from a relay whose ok names none', () => {
    const s = setup();
    online(s, { peers: [] });
    expect(s.link.pairs).toBeNull();
  });

  it('emits a frame from any peer with its id, and an empty one as a wake', () => {
    const s = setup();
    online(s, { peers: [] });
    const peer = generateIdentity().publicKey;
    s.sock().binary(encodeFrame({ peer, flags: 0, wake: ZERO_WAKE, body: new Uint8Array([1, 2]) }));
    s.sock().binary(encodeFrame({ peer, flags: FLAG_WAKE, wake: ZERO_WAKE, body: new Uint8Array(0) }));
    s.sock().binary(new Uint8Array([9, 9, 9]));
    expect(s.events).toContainEqual({ type: 'frame', peer: deviceId(peer), body: new Uint8Array([1, 2]), flags: 0 });
    expect(s.events).toContainEqual({ type: 'wake', peer: deviceId(peer), flags: FLAG_WAKE });
    expect(s.link.dropped).toBe(1);
  });

  it('sends a frame to the peer it is given', () => {
    const s = setup();
    online(s, { peers: [] });
    const peer = generateIdentity().publicKey;
    s.link.send(peer, new Uint8Array([7]));
    const frame = decodeFrame(s.sock().frames[0])!;
    expect(deviceId(frame.peer)).toBe(deviceId(peer));
    expect([...frame.body]).toEqual([7]);
  });

  it('stops for good when the relay refuses its secret', () => {
    vi.useFakeTimers();
    const s = setup();
    s.sock().onclose?.({ code: CLOSE_BAD_SECRET });
    vi.advanceTimersByTime(RECONNECT_MAX_MS * 2);
    expect(FakeSocket.all.length).toBe(1);
    expect(s.link.status).toBe('off');
    expect(s.events).toContainEqual({ type: 'relay_error', code: 'bad_secret' });
  });

  it('post signs the request, and answers status 0 when the relay cannot be reached', async () => {
    let sent: { url: string; body: unknown } | null = null;
    const s = setup({
      fetchImpl: async (url, init) => {
        sent = { url, body: JSON.parse(init.body as string) };
        return new Response('{"ok":true}', { status: 200, headers: { [RELAY_VERSION_HEADER]: MIN_RELAY_VERSION } });
      },
    });
    const res = await s.link.post('/pair/mutual', 'pair.mutual', { peer: 'x' });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(sent!.url).toBe('https://relay.test/pair/mutual');
    const verified = verifyRequest(sent!.body, 'pair.mutual', Date.now());
    expect(verified).toMatchObject({ ok: true, id: s.link.id, payload: { peer: 'x' } });

    const down = setup({ fetchImpl: () => Promise.reject(new Error('offline')) });
    expect(await down.link.post('/pair/mutual', 'pair.mutual', {})).toEqual({ status: 0, body: { error: 'network' } });
  });
});
