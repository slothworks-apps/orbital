import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { buildServer } from '../src/index.js';
import { openDb } from '../src/db/database.js';
import { settings as settingsTable } from '../src/db/schema.js';
import type { OrbitalDb } from '../src/db/database.js';
import { DeviceStore } from '../src/remote/devices.js';
import { RemoteService } from '../src/remote/service.js';
import { Hub } from '../src/api/hub.js';
import { remoteInjectOptions } from '../src/remote/inject.js';
import { generateIdentity, deviceId } from '@orbital/shared/remote/keys';
import { parseNotificationSettings } from '@orbital/shared/notifications';
import { makeTmpDir } from './tmp.js';

async function server(enabled: boolean, relayUrl = 'http://127.0.0.1:1', seed?: (db: OrbitalDb) => void) {
  const dir = makeTmpDir('remote');
  const dbPath = join(dir, 'index.db');
  const db = openDb(dbPath);
  db.insert(settingsTable).values({ key: 'remote_enabled', value: String(enabled) })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: String(enabled) } }).run();
  db.insert(settingsTable).values({ key: 'remote_relay_url', value: relayUrl })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: relayUrl } }).run();
  seed?.(db);
  db.$client.close();
  return buildServer({ dbPath, claudeDir: join(dir, 'claude'), dataDir: dir });
}

describe('/api/remote', () => {
  it('reports a disabled service and refuses to pair', async () => {
    const app = await server(false);
    const status = await app.inject({ method: 'GET', url: '/api/remote' });
    expect(status.json()).toMatchObject({ enabled: false, relay: 'off', devices: [], pendingPair: null, macId: null });
    const pair = await app.inject({ method: 'POST', url: '/api/remote/pair' });
    expect(pair.statusCode).toBe(409);
    expect(pair.json()).toEqual({ error: 'disabled' });
    await app.close();
  });
  it('an enabled service has an identity and reports connecting while the relay is unreachable', async () => {
    const app = await server(true);
    const status = await app.inject({ method: 'GET', url: '/api/remote' });
    expect(status.json()).toMatchObject({ enabled: true, relay: 'connecting', relayUrl: 'http://127.0.0.1:1' });
    expect(status.json().macId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(status.json().macName).not.toBe('');
    const pair = await app.inject({ method: 'POST', url: '/api/remote/pair' });
    expect(pair.statusCode).toBe(409);
    expect(pair.json()).toEqual({ error: 'offline' });
    expect((await app.inject({ method: 'POST', url: '/api/remote/pair/confirm', payload: { accept: true, phone: 'p' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/api/remote/devices/nope' })).statusCode).toBe(404);
    await app.close();
  });
  it('a settings change to remote_enabled starts and stops the service', async () => {
    const app = await server(false);
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { remote_enabled: 'true' } });
    expect((await app.inject({ method: 'GET', url: '/api/remote' })).json().enabled).toBe(true);
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { remote_enabled: 'false' } });
    expect((await app.inject({ method: 'GET', url: '/api/remote' })).json()).toMatchObject({ enabled: false, relay: 'off' });
    await app.close();
  });
  it('a remote that cannot start leaves boot alone and reports why, until a good setting fixes it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await server(true, 'foo');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[remote] could not start'));
    warn.mockRestore();
    const broken = (await app.inject({ method: 'GET', url: '/api/remote' })).json();
    expect(broken).toMatchObject({ enabled: true, relay: 'off', macId: null });
    expect(broken.error).toEqual(expect.any(String));
    expect((await app.inject({ method: 'GET', url: '/api/sessions' })).statusCode).toBe(200);
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { remote_relay_url: 'http://127.0.0.1:1' } });
    expect((await app.inject({ method: 'GET', url: '/api/remote' })).json()).toMatchObject({ relay: 'connecting', error: null });
    await app.close();
  });
  it('a Mac-name change publishes the new name without restarting; a relay URL change restarts', async () => {
    const app = await server(true);
    const stop = vi.spyOn(RemoteService.prototype, 'stop');
    const publish = vi.spyOn(Hub.prototype, 'publish');
    try {
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { remote_mac_name: 'Studio' } });
      expect(stop).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledWith('remote', expect.objectContaining({ event: 'status', macName: 'Studio' }));
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { remote_relay_url: 'http://127.0.0.1:2' } });
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      stop.mockRestore();
      publish.mockRestore();
      await app.close();
    }
  });
  it('a relay secret change restarts the remote; saving the same secret again does not', async () => {
    const app = await server(true);
    const stop = vi.spyOn(RemoteService.prototype, 'stop');
    try {
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { remote_relay_secret: 'x' } });
      expect(stop).toHaveBeenCalledTimes(1);
      await app.inject({ method: 'PATCH', url: '/api/settings', payload: { remote_relay_secret: 'x' } });
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      stop.mockRestore();
      await app.close();
    }
  });
  it('restart tries again with the same settings and answers the new status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = await server(true, 'foo');
    warn.mockClear();
    const res = await app.inject({ method: 'POST', url: '/api/remote/restart' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[remote] could not start'));
    warn.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, relay: 'off' });
    expect(res.json().error).toEqual(expect.any(String));
    await app.close();
  });
  it('confirm needs the phone the user verified', async () => {
    const app = await server(false);
    const noPhone = await app.inject({ method: 'POST', url: '/api/remote/pair/confirm', payload: { accept: true } });
    expect(noPhone.statusCode).toBe(400);
    const none = await app.inject({ method: 'POST', url: '/api/remote/pair/confirm', payload: { accept: true, phone: 'p' } });
    expect(none.statusCode).toBe(404);
    await app.close();
  });
  it('revoke removes a paired phone with the remote off', async () => {
    const phone = deviceId(generateIdentity().publicKey);
    const app = await server(false, 'http://127.0.0.1:1', (db) => new DeviceStore(db).add({
      id: phone, name: 'iPhone', platform: 'ios', pairedAt: 1, notifications: parseNotificationSettings({}),
    }));
    expect((await app.inject({ method: 'GET', url: '/api/remote' })).json().devices).toHaveLength(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/remote/devices/${phone}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/remote' })).json().devices).toEqual([]);
    await app.close();
  });
  it('a phone\'s body-less POST reaches its route instead of failing on an empty JSON body', async () => {
    const app = await server(false);
    const res = await app.inject(remoteInjectOptions({ method: 'POST', url: '/api/sessions/nope/interrupt' }));
    expect(res.statusCode).not.toBe(400);
    expect(res.body).not.toContain('FST_ERR_CTP_EMPTY_JSON_BODY');
    await app.close();
  });
});

describe('remoteInjectOptions', () => {
  it('passes the host guard, and sends a content type only with a body', () => {
    expect(remoteInjectOptions({ method: 'GET', url: '/api/sessions' })).toEqual({
      method: 'GET', url: '/api/sessions', payload: undefined, headers: { host: '127.0.0.1' },
    });
    expect(remoteInjectOptions({ method: 'POST', url: '/api/sessions/s/message', payload: { text: 'hi' } }).headers)
      .toEqual({ host: '127.0.0.1', 'content-type': 'application/json' });
  });
});
