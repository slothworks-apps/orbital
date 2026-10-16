/**
 * Two real Orbital servers and one real relay: a Mac pairs with another by
 * its code, both directions come up, each sees the other's sessions on its
 * own list and reads one through the tunnel (spec 2026-10-06-peer-macs-design).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildRelay } from '@orbital/relay/app';
import { openRelayStore } from '@orbital/relay/store';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { settings as settingsTable } from '../src/db/schema.js';
import { RETENTION_KEY, RETENTION_NEVER } from '../src/retention.js';
import { parsePairingCode, sessionOfTopic } from '../src/peers/service.js';
import { peerAllowedPath, peerMaySet } from '../src/remote/allowlist.js';
import WebSocket from 'ws';
import { generateIdentity } from '@orbital/shared/remote/keys';
import { QrPayload } from '@orbital/shared/remote/relayApi';
import { RemoteClient } from '@orbital/shared/remote/client';
import { listen, pairingCode, until } from './remoteHarness.js';
import { makeTmpDir } from './tmp.js';

const STUDIO_SESSION = 's-studio';
const LAPTOP_SESSION = 's-laptop';

async function startMac(closers: (() => unknown)[], relayUrl: string, name: string, session?: string) {
  const dir = makeTmpDir(`peer-${name}`);
  const dbPath = join(dir, 'index.db');
  const db = openDb(dbPath);
  for (const [key, value] of [
    ['remote_enabled', 'true'], ['remote_relay_url', relayUrl], ['remote_mac_name', name], [RETENTION_KEY, RETENTION_NEVER],
  ]) {
    db.insert(settingsTable).values({ key, value }).onConflictDoUpdate({ target: settingsTable.key, set: { value } }).run();
  }
  db.$client.close();
  if (session) {
    mkdirSync(join(dir, 'claude', 'projects', 'p'), { recursive: true });
    copyFileSync(join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'), join(dir, 'claude', 'projects', 'p', `${session}.jsonl`));
  }
  const app = await buildServer({ dbPath, claudeDir: join(dir, 'claude'), dataDir: dir });
  closers.push(() => app.close());
  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as any });
  await until(async () => (await api('GET', '/api/remote')).json().relay === 'online');
  return { api, app };
}

describe('peer Macs through one relay', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

  it('pairs both ways from one code, and each lists and reads the other\'s sessions', async () => {
    const relay = await buildRelay({ store: await openRelayStore(':memory:') });
    const relayUrl = await listen(relay);
    closers.push(() => relay.close());
    const studio = await startMac(closers, relayUrl, 'studio', STUDIO_SESSION);
    const laptop = await startMac(closers, relayUrl, 'laptop', LAPTOP_SESSION);
    await until(async () => (await studio.api('GET', '/api/sessions')).json().sessions.some((s: any) => s.id === STUDIO_SESSION));

    // The studio shows a code, the laptop pastes it and shows the code to type back.
    const { code } = (await studio.api('POST', '/api/peers/code')).json();
    const paired = await laptop.api('POST', '/api/peers/pair', { code });
    expect(paired.statusCode).toBe(200);
    const typed = paired.json().code as string;
    await until(async () => (await studio.api('GET', '/api/remote')).json().pendingPair !== null);
    const pending = (await studio.api('GET', '/api/remote')).json().pendingPair;
    expect(pending).toMatchObject({ name: 'laptop', platform: 'macos' });
    const confirm = await studio.api('POST', '/api/remote/pair/confirm', { accept: true, phone: pending.phone, code: typed });
    expect(confirm.statusCode).toBe(200);

    // The laptop is the studio's client, and the studio became the laptop's without a second code.
    await until(async () => (await laptop.api('GET', '/api/peers')).json().peers.some((p: any) => p.online), 10_000);
    await until(async () => (await studio.api('GET', '/api/peers')).json().peers.some((p: any) => p.online), 10_000);

    // The studio's session is on the laptop's list, marked with its machine.
    await until(async () => (await laptop.api('GET', '/api/sessions')).json().sessions.some((s: any) => s.id === STUDIO_SESSION));
    const listed = (await laptop.api('GET', '/api/sessions')).json().sessions.find((s: any) => s.id === STUDIO_SESSION);
    expect(listed.machine).toMatchObject({ name: 'studio', online: true });

    // Read through the tunnel as if it were local.
    const one = await laptop.api('GET', `/api/sessions/${STUDIO_SESSION}`);
    expect(one.statusCode).toBe(200);
    expect(one.json().session.machine).toMatchObject({ name: 'studio' });
    const messages = await laptop.api('GET', `/api/sessions/${STUDIO_SESSION}/messages?limit=30`);
    expect(messages.statusCode).toBe(200);
    expect(messages.json().messages.length).toBeGreaterThan(0);

    // A composer's image for the studio's session is stored on the laptop, to go on with the message.
    const boundary = 'b0undary';
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');
    const upload = await laptop.app.inject({
      method: 'POST', url: `/api/sessions/${STUDIO_SESSION}/attachments`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
        png, Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().ref).toMatch(/\.png$/);

    // A change on the studio reaches the laptop's list.
    expect((await laptop.api('PUT', `/api/sessions/${STUDIO_SESSION}/pinned`, { pinned: true })).statusCode).toBe(200);
    await until(async () => (await studio.api('GET', `/api/sessions/${STUDIO_SESSION}`)).json().session.pinnedAt !== null);

    // No chaining: the studio does not get its own session back from the laptop.
    const own = (await studio.api('GET', '/api/sessions')).json().sessions.filter((s: any) => s.id === STUDIO_SESSION);
    expect(own).toHaveLength(1);
    expect(own[0].machine).toBeUndefined();

    // A phone paired with the studio alone sees the laptop's session too, and reads it.
    await until(async () => (await studio.api('GET', '/api/sessions')).json().sessions.some((s: any) => s.id === LAPTOP_SESSION));
    const qr = QrPayload.parse(JSON.parse((await studio.api('POST', '/api/remote/pair')).json().qr));
    const identity = generateIdentity();
    const phone = new RemoteClient({ relayUrl, mac: qr.mac, identity, WebSocketImpl: WebSocket, app: 'orbital-mobile/test' });
    closers.push(() => phone.stop());
    phone.start();
    await until(() => phone.status === 'online');
    const outcome = phone.waitForPairing();
    await phone.redeem(qr.token, qr.secret, 'Pixel', 'android');
    await until(async () => (await studio.api('GET', '/api/remote')).json().pendingPair?.platform === 'android');
    void studio.api('POST', '/api/remote/pair/confirm', { accept: true, phone: phone.id, code: pairingCode(qr.mac, identity.publicKey) });
    expect(await outcome).toBe('paired');
    await until(() => phone.ready);
    const phoneList = await phone.request('GET', '/api/sessions?limit=50&ended=only');
    const onPhone = (phoneList.body as { sessions: any[] }).sessions.find((s) => s.id === LAPTOP_SESSION);
    expect(onPhone?.machine).toMatchObject({ name: 'laptop' });
    const phoneMessages = await phone.request('GET', `/api/sessions/${LAPTOP_SESSION}/messages?limit=30`);
    expect(phoneMessages.status).toBe(200);
    expect((phoneMessages.body as { messages: unknown[] }).messages.length).toBeGreaterThan(0);

    // An offer to pair the other way comes only through a paired Mac's tunnel.
    expect((await studio.api('POST', '/api/peers/offer', { code })).statusCode).toBe(403);

    // Forgotten on the laptop: the studio's session leaves its list.
    const studioId = listed.machine.id as string;
    expect((await laptop.api('DELETE', `/api/peers/${studioId}`)).statusCode).toBe(200);
    expect((await laptop.api('GET', '/api/sessions')).json().sessions.some((s: any) => s.id === STUDIO_SESSION)).toBe(false);
  }, 30_000);
});

describe('peer helpers', () => {
  it('reads a pairing code as JSON or as one base64url word, and nothing else', () => {
    const qr = { v: 1, relay: 'https://r.example', mac: 'A'.repeat(42) + 'A', name: 'studio', token: 't', secret: 's' };
    expect(parsePairingCode(JSON.stringify(qr))?.name).toBe('studio');
    expect(parsePairingCode(Buffer.from(JSON.stringify(qr)).toString('base64url'))?.name).toBe('studio');
    expect(parsePairingCode('nonsense')).toBeNull();
    expect(parsePairingCode(JSON.stringify({ ...qr, mac: 'short' }))).toBeNull();
  });

  it('names the session of a per-session topic', () => {
    expect(sessionOfTopic('session:abc')).toBe('abc');
    expect(sessionOfTopic('subagent:abc:t1')).toBe('abc');
    expect(sessionOfTopic('task-output:abc:t1')).toBe('abc');
    expect(sessionOfTopic('sessions')).toBeNull();
  });

  it('lets a peer Mac call everything but pairing, dev tools and the IDE bridge', () => {
    expect(peerAllowedPath('GET', '/api/settings')).toBe('/api/settings');
    expect(peerAllowedPath('GET', '/api/images/' + 'a'.repeat(64) + '.png')).not.toBeNull();
    expect(peerAllowedPath('POST', '/api/peers/offer')).not.toBeNull();
    expect(peerAllowedPath('POST', '/api/peers/pair')).toBeNull();
    expect(peerAllowedPath('POST', '/api/remote/pair')).toBeNull();
    expect(peerAllowedPath('POST', '/api/dev/sessions/x/simulate-compaction')).toBeNull();
    expect(peerAllowedPath('GET', '/api/sessions/x/ide/open-files')).toBeNull();
    expect(peerAllowedPath('GET', '/api/sessions/../remote')).toBeNull();
    expect(peerAllowedPath('GET', '/api/sessions/%2e%2e/remote')).toBeNull();
    expect(peerAllowedPath('GET', '/ws')).toBeNull();
  });
});

describe('what a paired Mac may not do', () => {
  it('keeps the CLI path, the remote settings and the terminals away from it', () => {
    expect(peerMaySet('claude_executable_path')).toBe(false);
    expect(peerMaySet('remote_relay_url')).toBe(false);
    expect(peerMaySet('retention_days')).toBe(true);
    expect(peerAllowedPath('POST', '/api/sessions/x/terminals')).toBeNull();
    expect(peerAllowedPath('DELETE', '/api/terminals/t1')).toBeNull();
  });
});
