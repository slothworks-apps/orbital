import { describe, it, expect, vi } from 'vitest';
import { generateIdentity, deviceId } from '@orbital/shared/remote/keys';
import { startHandshake, type SessionCipher } from '@orbital/shared/remote/handshake';
import { BLOB_CHUNK_BYTES, PROTOCOL_VERSION, chunkBlob, decodeInner, encodeInner, type MacMessage } from '@orbital/shared/remote/messages';
import { Hub } from '../src/api/hub.js';
import { createImageStore } from '../src/images/store.js';
import { DeviceWatcher } from '../src/remote/deviceWatcher.js';
import { MAX_INNER_BYTES, PhoneSession } from '../src/remote/phoneSession.js';
import { wakeToken } from '../src/remote/wake.js';
import { makeTmpDir } from './tmp.js';

const allOn = { needsInput: true, sessionEnded: true, sessionFailed: true, onlyWhenBackground: true, sound: true };

/** A phone on the other end: completes the handshake and speaks the inner codec. */
function makePhone(mac: ReturnType<typeof generateIdentity>, session: () => PhoneSession) {
  const me = generateIdentity();
  let hs = startHandshake(me, mac.publicKey, 'initiator');
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
  /** What a phone does on a new socket: forget the keys and handshake again, same identity. */
  const rehandshake = () => {
    hs = startHandshake(me, mac.publicKey, 'initiator');
    cipher = null;
    session().receive(hs.message!);
  };
  return { me, hs, out, blobs, onMacBody, send, sendBlob, rehandshake, hasCipher: () => cipher !== null };
}

function build(opts: { inject?: PhoneSession['opts']['inject']; handshake?: boolean } = {}) {
  const mac = generateIdentity();
  const hub = new Hub({ heartbeatIntervalMs: 60_000 });
  const dir = makeTmpDir('remote');
  const images = createImageStore(dir);
  // The closure reads `session` only once a message flows, after it is built below.
  const phone = makePhone(mac, () => session);
  const notifications = { current: allOn, get: () => notifications.current, set: (s: typeof allOn) => { notifications.current = s; } };
  const onSeen = vi.fn();
  const onClose = vi.fn();
  const session: PhoneSession = new PhoneSession({
    deviceId: deviceId(phone.me.publicKey), identity: mac, phonePublicKey: phone.me.publicKey, hub,
    inject: opts.inject ?? (async () => ({ statusCode: 500, body: '{}' })),
    images, imagesDir: dir, serverVersion: '0.15.0', macName: 'studio',
    notifications, send: phone.onMacBody, onSeen, onClose,
  });
  // The initiator's half exists from the start; only the responder's waits for `complete`.
  if (opts.handshake !== false) session.receive(phone.hs.message!);
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
  it('subscribes only to allowlisted topics', () => {
    const { phone, hub } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    for (const topic of ['remote', 'settings', 'session:', 'sessionsX']) phone.send({ t: 'ws', type: 'subscribe', topic });
    for (const topic of ['remote', 'settings', 'session:', 'sessionsX']) expect(hub.subscriberCount(topic)).toBe(0);
    hub.publish('remote', { event: 'pair_request', phone: 'p' });
    expect(phone.out).toEqual([{ t: 'hello', protocol: PROTOCOL_VERSION, server: '0.15.0', macName: 'studio' }]);
    for (const topic of ['errors', 'session:s1', 'subagent:s1:a1', 'task-output:s1:t1']) {
      phone.send({ t: 'ws', type: 'subscribe', topic });
      expect(hub.subscriberCount(topic)).toBe(1);
    }
  });
  it('a hub frame too large for one relay frame becomes a dropped notice naming the message', () => {
    const { phone, hub } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    phone.send({ t: 'ws', type: 'subscribe', topic: 'session:s1' });
    hub.publish('session:s1', { event: 'message', message: { id: 'm1', text: 'x'.repeat(MAX_INNER_BYTES) } });
    expect(phone.out.at(-1)).toEqual({ t: 'ws', frame: { topic: 'session:s1', event: 'dropped', reason: 'too_large', id: 'm1' } });
  });
  it('a fresh handshake from the same phone replaces the keys, and the phone greets again', () => {
    const { phone, hub, session, onClose } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    phone.send({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    expect(hub.subscriberCount('sessions')).toBe(1);
    phone.rehandshake();
    expect(phone.hasCipher()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    // The old connection's subscriptions are gone; nothing but hello counts until hello.
    expect(hub.subscriberCount('sessions')).toBe(0);
    phone.out.length = 0;
    phone.send({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    expect(hub.subscriberCount('sessions')).toBe(0);
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    expect(phone.out).toEqual([{ t: 'hello', protocol: PROTOCOL_VERSION, server: '0.15.0', macName: 'studio' }]);
    phone.send({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    expect(hub.subscriberCount('sessions')).toBe(1);
    expect(session.ready).toBe(true);
  });
  it('a handshake signed by another identity does not reset the session', () => {
    const { phone, mac, session } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    session.receive(startHandshake(generateIdentity(), mac.publicKey, 'initiator').message!);
    phone.send({ t: 'notifications_get' });
    expect(phone.out.at(-1)).toEqual({ t: 'notifications', settings: allOn });
    expect(session.ready).toBe(true);
  });
  it('an http answer too large for one frame answers 413 instead', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(MAX_INNER_BYTES) });
    const { phone } = build({ inject: async () => ({ statusCode: 200, body: big }) });
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    phone.send({ t: 'http', id: 7, method: 'GET', path: '/api/sessions?limit=2' });
    await new Promise((r) => setTimeout(r, 0));
    expect(phone.out.at(-1)).toEqual({ t: 'http_res', id: 7, status: 413, body: { error: 'too_large' } });
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
    const { phone, session, hub } = build();
    phone.send({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    expect(phone.out).toEqual([]);
    session.receive(new Uint8Array([0, 1, 2]));
    expect(phone.out).toEqual([]);
    expect(hub.subscriberCount('sessions')).toBe(0);
  });
  it('a first frame that is not a valid handshake closes the session', () => {
    const { session, onClose, phone } = build({ handshake: false });
    session.receive(crypto.getRandomValues(new Uint8Array(96)));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(session.ready).toBe(false);
    expect(phone.hasCipher()).toBe(false);
  });
  it('close tears down the hub subscription and stops all output', () => {
    const { phone, hub, session } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    phone.send({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    expect(hub.subscriberCount('sessions')).toBe(1);
    session.close();
    expect(hub.subscriberCount('sessions')).toBe(0);
    const before = phone.out.length;
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'working' });
    expect(phone.out).toHaveLength(before);
  });
  it('blob_put refuses a fifth open upload, an overrun and a short upload', () => {
    const { phone } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    for (let id = 1; id <= 5; id++) phone.send({ t: 'blob_put', id, mediaType: 'image/png', bytes: 10 });
    expect(phone.out).toContainEqual({ t: 'blob_put_done', id: 5, error: 'busy' });
    phone.sendBlob({ kind: 'blob', id: 1, seq: 0, last: false, bytes: new Uint8Array(11) });
    expect(phone.out).toContainEqual({ t: 'blob_put_done', id: 1, error: 'too_large' });
    phone.sendBlob({ kind: 'blob', id: 2, seq: 0, last: true, bytes: new Uint8Array(9) });
    expect(phone.out).toContainEqual({ t: 'blob_put_done', id: 2, error: 'size_mismatch' });
  });
  it('a throwing hook answers the request instead of throwing out of receive', () => {
    const { phone, images, onSeen } = build();
    phone.send({ t: 'hello', protocol: PROTOCOL_VERSION, app: 'x' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(images, 'putBytes').mockImplementation(() => { throw new Error('disk full'); });
    onSeen.mockImplementation(() => { throw new Error('boom'); });
    phone.send({ t: 'blob_put', id: 6, mediaType: 'image/png', bytes: 1 });
    expect(() => phone.sendBlob({ kind: 'blob', id: 6, seq: 0, last: true, bytes: new Uint8Array(1) })).not.toThrow();
    expect(phone.out).toContainEqual({ t: 'blob_put_done', id: 6, error: 'internal' });
    expect(() => phone.send({ t: 'seen', sessionId: 's1' })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
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
  it('seen clears the debounce, but does not invent a transition', () => {
    const hub = new Hub({ heartbeatIntervalMs: 60_000 });
    const wakes: string[] = [];
    const w = new DeviceWatcher({ deviceId: 'p1', hub, settings: () => allOn, onWake: (id) => wakes.push(id) });
    w.start([{ id: 's1', title: 'one', status: 'working' }]);
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
    w.seen('s1');
    hub.publish('sessions', { event: 'upsert', session: { id: 's1', title: 'one', status: 'needs_input' } });
    expect(wakes).toEqual(['s1']);
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'working' });
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
    expect(wakes).toEqual(['s1', 's1']);
    w.stop();
  });
  it('a failure wakes even while a needs_input wake for the session is pending', () => {
    const hub = new Hub({ heartbeatIntervalMs: 60_000 });
    const wakes: string[] = [];
    const w = new DeviceWatcher({ deviceId: 'p1', hub, settings: () => allOn, onWake: (id) => wakes.push(id) });
    w.start([{ id: 's1', title: 'one', status: 'working' }]);
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
    hub.publish('errors', { event: 'error', error: { kind: 'session_failed', sessionId: 's1', message: 'boom' } });
    expect(wakes).toEqual(['s1', 's1']);
    w.stop();
  });
  it('a throwing wake hook does not stop later wakes, and start twice subscribes once', () => {
    const hub = new Hub({ heartbeatIntervalMs: 60_000 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const w = new DeviceWatcher({
      deviceId: 'p1', hub, settings: () => allOn,
      onWake: () => { calls++; if (calls === 1) throw new Error('push down'); },
    });
    w.start([{ id: 's1', title: 'one', status: 'working' }]);
    w.start([]);
    expect(hub.subscriberCount('sessions')).toBe(1);
    hub.publish('sessions', { event: 'status', sessionId: 's1', status: 'needs_input' });
    hub.publish('sessions', { event: 'upsert', session: { id: 's2', title: 'two', status: 'working' } });
    hub.publish('sessions', { event: 'status', sessionId: 's2', status: 'needs_input' });
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    w.stop();
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
