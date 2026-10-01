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
  const closers: (() => unknown)[] = [];
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
    // Seeded before boot so the remote starts enabled; the server opens its own handle.
    db.$client.close();
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
    // A real phone handshakes the moment it hears `paired`, which the relay
    // sends before it answers the Mac's confirm — so the confirm is not awaited first.
    const confirm = api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.id });
    expect(await phone.nextControl('paired')).toMatchObject({ type: 'paired', name: 'studio' });
    await phone.handshake();
    expect((await confirm).statusCode).toBe(200);
    await until(async () => (await api('GET', '/api/remote')).json().devices.some((d: any) => d.id === phone.id && d.online));

    // Tunnel: hello, hub subscriptions, an allowed and a denied call.
    expect(await phone.hello()).toMatchObject({ t: 'hello', macName: 'studio' });
    phone.send({ t: 'ws', type: 'subscribe', topic: 'sessions' });
    phone.send({ t: 'ws', type: 'subscribe', topic: 'errors' });
    // Messages are handled in order, so this answer also means both subscriptions are in.
    phone.send({ t: 'http', id: 1, method: 'GET', path: '/api/sessions' });
    const sessions = await phone.next('http_res', (m) => m.id === 1);
    expect(sessions.status).toBe(200);
    // Recorded on the Mac directly (the phone may not post errors); the hub frame reaches the phone.
    const recorded = await app.inject({ method: 'POST', url: '/api/errors', payload: { kind: 'render_crash', message: 'e2e boom' } });
    expect(recorded.statusCode).toBe(200);
    const errorFrame = await phone.next('ws', (m) => (m.frame as any)?.topic === 'errors');
    expect(errorFrame.frame).toMatchObject({ topic: 'errors', event: 'error', error: { message: 'e2e boom' } });
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
    // Stored on the Mac, not only echoed back.
    const stored = (await api('GET', '/api/remote')).json().devices.find((d: any) => d.id === phone.id);
    expect(stored.notifications.sessionEnded).toBe(false);

    // The same phone back on a new socket, as after an app restart: the relay
    // supersedes the old socket without an `offline`, and the fresh
    // handshake must still be answered.
    const again = new FakePhone(phone.identity);
    closers.push(() => again.close());
    await again.connectStored({ relay: relayUrl, mac: status.macId });
    await again.handshake();
    expect(await again.hello()).toMatchObject({ t: 'hello', macName: 'studio' });
    again.send({ t: 'http', id: 20, method: 'GET', path: '/api/sessions' });
    expect(await again.next('http_res', (m) => m.id === 20)).toMatchObject({ status: 200 });
    await phone.close();

    // Revoke on the Mac: the tunnel says bye, the relay says unpaired, the device is gone.
    expect((await api('DELETE', `/api/remote/devices/${again.id}`)).statusCode).toBe(200);
    expect(await again.next('bye')).toEqual({ t: 'bye', reason: 'revoked' });
    expect(await again.nextControl('unpaired')).toMatchObject({ type: 'unpaired' });
    expect((await api('GET', '/api/remote')).json().devices).toEqual([]);
  }, 20_000);
});
