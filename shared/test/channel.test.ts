import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateIdentity } from '../src/remote/keys.js';
import {
  Channel, HANDSHAKE_TIMEOUT_MS, MAX_INNER_BYTES, TunnelError, type ChannelReply, type ChannelServer,
} from '../src/remote/channel.js';
import { HANDSHAKE_BYTES, startHandshake } from '../src/remote/handshake.js';
import { RESPONDER_FIRST_ID } from '../src/remote/device.js';
import type { AskMessage, HelloMessage } from '../src/remote/messages.js';

const desktop = (name: string, capabilities: string[] = ['sessions']) => ({
  app: `orbital-desktop/1.0.0`, server: '1.0.0', macName: name, version: '1.0.0', kind: 'desktop', os: 'macos', name,
  capabilities,
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

/**
 * Two channels wired back to back through a queue, as the relay would carry
 * their frames. Both hellos name `['sessions', 'group']` by default; `bHello`
 * overrides b's alone (its `capabilities`, say, to test a peer that does not
 * name the group capability).
 */
function pair(opts: { aServes?: boolean; bServes?: boolean; capabilities?: string[]; bHello?: Partial<HelloMessage> } = {}) {
  const aId = generateIdentity();
  const bId = generateIdentity();
  const capabilities = opts.capabilities ?? ['sessions', 'group'];
  const queue: (() => void)[] = [];
  const pump = () => { while (queue.length) queue.shift()!(); };
  const aServer = echoServer('a');
  const bServer = echoServer('b');
  const a: Channel = new Channel({
    identity: aId, peerKey: bId.publicKey, role: 'initiator', hello: desktop('a', capabilities),
    send: (body) => queue.push(() => b.receive(body)), serve: opts.aServes === false ? undefined : aServer,
  });
  const b: Channel = new Channel({
    identity: bId, peerKey: aId.publicKey, role: 'responder', hello: { ...desktop('b', capabilities), ...opts.bHello },
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

  it('carries group messages only between members that name the group capability', () => {
    const { a, b, pump } = pair(); // both hellos with ['sessions', 'group']
    const got: unknown[] = [];
    b.on((e) => { if (e.type === 'group') got.push(e.msg); });
    a.start();
    pump();
    expect(a.groups && b.groups).toBe(true);
    expect(a.sendGroup({ t: 'roster_digest', digest: 'ab' })).toBe(true);
    pump();
    expect(got).toEqual([{ t: 'roster_digest', digest: 'ab' }]);
  });

  it('does not send group messages to a peer that does not name the capability', () => {
    const { a, pump } = pair({ bHello: { capabilities: ['sessions'] } });
    a.start();
    pump();
    expect(a.groups).toBe(false);
    expect(a.sendGroup({ t: 'removed' })).toBe(false);
  });

  it('does not emit a group event from a sender whose own hello never named the capability', () => {
    // a.groups is a's view of b (who does name it), so a's own sendGroup
    // still goes out; the guard this test is after is on the receiving
    // side, b's view of a (who does not name it).
    const { a, b, pump } = pair({ capabilities: ['sessions'], bHello: { capabilities: ['sessions', 'group'] } });
    const got: unknown[] = [];
    b.on((e) => { if (e.type === 'group') got.push(e.msg); });
    a.start();
    pump();
    expect(a.groups).toBe(true);
    expect(b.groups).toBe(false);
    expect(a.sendGroup({ t: 'removed' })).toBe(true);
    pump();
    expect(got).toEqual([]);
    expect(b.dropped).toBe(1);
  });

  it('a judge refusal closes the responder with bye before it greets', () => {
    const aId = generateIdentity();
    const bId = generateIdentity();
    const events: string[] = [];
    const a: Channel = new Channel({
      identity: aId, peerKey: bId.publicKey, role: 'initiator', hello: { app: 'orbital-mobile/0.0.1', kind: 'phone' },
      send: (body) => b.receive(body),
    });
    const b: Channel = new Channel({
      identity: bId, peerKey: aId.publicKey, role: 'responder', hello: desktop('b'),
      send: (body) => a.receive(body), judge: () => ({ reason: 'app_too_old', needed: '9.0.0' }),
    });
    a.on((e) => events.push(e.type === 'bye' ? `bye:${e.reason}` : e.type));
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

  it('the initiator starts over when the peer completes the handshake but never says hello', () => {
    vi.useFakeTimers();
    const aId = generateIdentity();
    const bId = generateIdentity();
    const queue: (() => void)[] = [];
    let handshakes = 0;
    const a: Channel = new Channel({
      identity: aId, peerKey: bId.publicKey, role: 'initiator', hello: desktop('a'), handshakeTimeoutMs: 100,
      send: (body) => {
        if (body.length !== HANDSHAKE_BYTES) return;
        handshakes++;
        // A peer that answers the handshake and then says nothing: its hello lost, or never sent.
        const reply = startHandshake(bId, aId.publicKey, 'responder');
        expect(reply.complete(body)).not.toBeNull();
        queue.push(() => a.receive(reply.message!));
      },
    });
    a.start();
    queue.shift()!();
    expect(handshakes).toBe(1);
    expect(a.ready).toBe(false);
    vi.advanceTimersByTime(99);
    expect(handshakes).toBe(1);
    vi.advanceTimersByTime(1);
    expect(handshakes).toBe(2);
    a.close();
    vi.advanceTimersByTime(1_000);
    expect(handshakes).toBe(2);
  });

  it('a hello that arrives in time stops the initiator from starting over', () => {
    vi.useFakeTimers();
    const { a, b, pump } = pair();
    a.start();
    pump();
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS * 2);
    expect(a.ready && b.ready).toBe(true);
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
