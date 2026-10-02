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
