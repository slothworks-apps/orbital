import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { generateIdentity, deviceId, publicKeyOf } from '@orbital/shared/remote/keys';
import { CLOSE_BAD_SECRET, verifyAuthSignature } from '@orbital/shared/remote/relayApi';
import { RelayClient } from '../src/remote/relayClient.js';

/**
 * A relay stand-in: challenges, checks the signature, then echoes binary
 * frames back. `listen()` binds asynchronously even for `port: 0` on
 * localhost — `address()` is still null the instant the constructor
 * returns — so this waits for the `listening` event before handing back a
 * URL with the real port.
 */
async function fakeRelay(opts: { secret?: string } = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const sockets: WebSocket[] = [];
  const authed: string[] = [];
  const auths: Record<string, unknown>[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify({ type: 'challenge', nonce: 'n-' + sockets.length }));
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return ws.send(raw);
      const msg = JSON.parse((raw as Buffer).toString('utf8'));
      if (msg.type === 'auth') {
        auths.push(msg);
        const ok = verifyAuthSignature(publicKeyOf(msg.pub)!, 'n-' + sockets.length, msg.sig);
        if (!ok) return ws.close(4001);
        if (opts.secret !== undefined && msg.secret !== opts.secret) return ws.close(CLOSE_BAD_SECRET);
        authed.push(msg.pub);
        ws.send(JSON.stringify({ type: 'ok', peers: ['peer-a'] }));
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, sockets, authed: () => authed, auths: () => auths,
    connections: () => sockets.length, close: () => wss.close(),
  };
}

/** A relay that accepts the connection but sends nothing — tests the connect watchdog. */
async function fakeRelayThatNeverChallenges() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  let connections = 0;
  wss.on('connection', () => {
    connections++;
  });
  const port = (wss.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, connections: () => connections, close: () => wss.close() };
}

describe('RelayClient', () => {
  const closers: (() => void)[] = [];
  afterEach(() => closers.splice(0).forEach((c) => c()));

  it('authenticates, reports online with the peers, round-trips data, and reconnects after a drop', async () => {
    const relay = await fakeRelay();
    closers.push(relay.close);
    const me = generateIdentity();
    const client = new RelayClient({ relayUrl: relay.url, identity: me, reconnectDelayMs: 20 });
    closers.push(() => client.stop());
    const statuses: string[] = [];
    client.on('status', (s) => statuses.push(s));
    const controls: string[] = [];
    client.on('control', (msg) => controls.push(msg.type));
    client.start();
    await waitFor(() => client.status === 'online');
    expect(relay.authed()).toEqual([deviceId(me.publicKey)]);
    expect([...client.peersOnline]).toEqual(['peer-a']);
    expect(controls).toContain('challenge');
    expect(controls).toContain('ok');

    // A listener reading state on a `presence` sees it already applied.
    const seenInListener = new Promise<string[]>((r) => client.on('control', (msg) => {
      if (msg.type === 'presence') r([...client.peersOnline]);
    }));
    relay.sockets[0].send(JSON.stringify({ type: 'presence', peer: 'peer-b', online: true }));
    expect(await seenInListener).toEqual(['peer-a', 'peer-b']);

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
    const relay = await fakeRelay();
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

  it('gives up on a connection that never challenges, and tries again', async () => {
    const relay = await fakeRelayThatNeverChallenges();
    closers.push(relay.close);
    const client = new RelayClient({
      relayUrl: relay.url,
      identity: generateIdentity(),
      reconnectDelayMs: 20,
      connectTimeoutMs: 30,
    });
    closers.push(() => client.stop());
    client.start();
    await waitFor(() => relay.connections() >= 2);
    expect(client.status).toBe('connecting');
  });

  it('gives up on an online connection that goes silent, and reconnects', async () => {
    const relay = await fakeRelay();
    closers.push(relay.close);
    const client = new RelayClient({
      relayUrl: relay.url,
      identity: generateIdentity(),
      reconnectDelayMs: 20,
      silenceTimeoutMs: 30,
    });
    closers.push(() => client.stop());
    client.start();
    await waitFor(() => client.status === 'online');
    await waitFor(() => relay.authed().length >= 2);
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
  it('sends the relay secret with auth and every signed request when it has one, and nothing without', async () => {
    const relay = await fakeRelay({ secret: 's3cret' });
    closers.push(relay.close);
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const withSecret = new RelayClient({ relayUrl: relay.url, identity: generateIdentity(), relaySecret: 's3cret', fetchImpl });
    closers.push(() => withSecret.stop());
    withSecret.start();
    await waitFor(() => withSecret.status === 'online');
    expect(relay.auths()[0]).toMatchObject({ type: 'auth', secret: 's3cret' });
    await withSecret.post('/pair/token', 'pair.token', { name: 'studio' });
    expect(bodies[0]).toMatchObject({ secret: 's3cret' });

    const open = await fakeRelay();
    closers.push(open.close);
    const without = new RelayClient({ relayUrl: open.url, identity: generateIdentity(), fetchImpl });
    closers.push(() => without.stop());
    without.start();
    await waitFor(() => without.status === 'online');
    expect(open.auths()[0]).not.toHaveProperty('secret');
    await without.post('/pair/token', 'pair.token', { name: 'studio' });
    expect(bodies[1]).not.toHaveProperty('secret');
  });
  it('a refused secret stops the client and reports it, with no reconnect after the backoff', async () => {
    const relay = await fakeRelay({ secret: 'right' });
    closers.push(relay.close);
    const client = new RelayClient({ relayUrl: relay.url, identity: generateIdentity(), relaySecret: 'wrong', reconnectDelayMs: 20 });
    closers.push(() => client.stop());
    const refused: string[] = [];
    client.on('refused', (reason) => refused.push(reason));
    client.start();
    await waitFor(() => refused.length > 0);
    expect(refused).toEqual(['bad_secret']);
    expect(client.status).toBe('off');
    await new Promise((r) => setTimeout(r, 80));
    expect(relay.connections()).toBe(1);
    expect(client.status).toBe('off');
  });
  it('post answers status 0 instead of rejecting when the relay is unreachable', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const client = new RelayClient({ relayUrl: 'http://relay.test', identity: generateIdentity(), fetchImpl });
    expect(await client.post('/pair/token', 'pair.token', {})).toEqual({ status: 0, body: { error: 'network' } });
  });
});

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
