import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { DeviceStore } from '../src/remote/devices.js';
import { IDENTITY_FILE, loadOrCreateIdentity, macDisplayName } from '../src/remote/identity.js';
import { makeTmpDir } from './tmp.js';

const settings = { needsInput: true, sessionEnded: false, sessionFailed: true, onlyWhenBackground: true, sound: true };

describe('identity', () => {
  it('creates a private key file once and reads it back', () => {
    const dir = makeTmpDir('remote');
    const a = loadOrCreateIdentity(dir).identity;
    const b = loadOrCreateIdentity(dir).identity;
    expect(b.publicKey).toEqual(a.publicKey);
    expect(statSync(join(dir, IDENTITY_FILE)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, IDENTITY_FILE), 'utf8'))).toHaveProperty('secretKey');
  });
  it('display name prefers the stored one and strips .local from the hostname', () => {
    expect(macDisplayName('studio', 'Tomas-MacBook-Pro.local')).toBe('studio');
    expect(macDisplayName('', 'Tomas-MacBook-Pro.local')).toBe('Tomas-MacBook-Pro');
    expect(macDisplayName('  ', 'box')).toBe('box');
  });
  it('a secret key of the wrong length is quarantined and replaced with a fresh identity', () => {
    const dir = makeTmpDir('remote');
    const path = join(dir, IDENTITY_FILE);
    writeFileSync(path, JSON.stringify({ secretKey: 'YWJj' })); // decodes to 3 bytes, not 32
    const loaded = loadOrCreateIdentity(dir);
    const fresh = loaded.identity;
    expect(loaded.regenerated).toBe(true);
    expect(fresh.publicKey.length).toBe(32);
    const corrupted = readdirSync(dir).filter((f) => f.startsWith(`${IDENTITY_FILE}.corrupt-`));
    expect(corrupted.length).toBe(1);
    const again = loadOrCreateIdentity(dir);
    expect(again.identity.publicKey).toEqual(fresh.publicKey);
    expect(again.regenerated).toBe(false);
  });
  it('half a JSON document is quarantined and replaced with a fresh identity', () => {
    const dir = makeTmpDir('remote');
    const path = join(dir, IDENTITY_FILE);
    writeFileSync(path, '{"secretKey": "abc');
    const fresh = loadOrCreateIdentity(dir).identity;
    expect(fresh.publicKey.length).toBe(32);
    const corrupted = readdirSync(dir).filter((f) => f.startsWith(`${IDENTITY_FILE}.corrupt-`));
    expect(corrupted.length).toBe(1);
    expect(loadOrCreateIdentity(dir).identity.publicKey).toEqual(fresh.publicKey);
  });
  it('the replacement file is 0600 even when the corrupted one was world-readable', () => {
    const dir = makeTmpDir('remote');
    const path = join(dir, IDENTITY_FILE);
    writeFileSync(path, 'not json', { mode: 0o644 });
    loadOrCreateIdentity(dir);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('DeviceStore', () => {
  it('adds, lists, touches, updates notifications and removes', () => {
    const dir = makeTmpDir('remote');
    const db = openDb(join(dir, 'index.db'));
    const store = new DeviceStore(db);
    store.add({ id: 'p1', name: 'Pixel', platform: 'android', pairedAt: 10, notifications: settings });
    expect(store.list()).toEqual([{ id: 'p1', name: 'Pixel', platform: 'android', pairedAt: 10, lastSeenAt: null, notifications: settings }]);
    store.touch('p1', 20);
    expect(store.get('p1')?.lastSeenAt).toBe(20);
    store.setNotifications('p1', { ...settings, sound: false });
    expect(store.get('p1')?.notifications.sound).toBe(false);
    store.remove('p1');
    expect(store.get('p1')).toBeNull();
    expect(store.list()).toEqual([]);
  });
  it('a row with unreadable notifications falls back to every flag on', () => {
    const dir = makeTmpDir('remote');
    const db = openDb(join(dir, 'index.db'));
    const store = new DeviceStore(db);
    store.add({ id: 'p1', name: 'Pixel', platform: 'android', pairedAt: 10, notifications: settings });
    db.run(`UPDATE remote_devices SET notifications = 'junk' WHERE id = 'p1'`);
    expect(store.get('p1')?.notifications).toEqual({ needsInput: true, sessionEnded: true, sessionFailed: true, onlyWhenBackground: true, sound: true });
  });
  it('re-adding a device keeps its own notifications and lastSeenAt; only name, platform and pairedAt change', () => {
    const dir = makeTmpDir('remote');
    const db = openDb(join(dir, 'index.db'));
    const store = new DeviceStore(db);
    store.add({ id: 'p1', name: 'Pixel', platform: 'android', pairedAt: 10, notifications: settings });
    store.setNotifications('p1', { ...settings, sound: false });
    store.touch('p1', 20);
    store.add({ id: 'p1', name: 'Pixel 9', platform: 'android', pairedAt: 30, notifications: { ...settings, sound: true } });
    const row = store.get('p1');
    expect(row?.name).toBe('Pixel 9');
    expect(row?.notifications).toEqual({ ...settings, sound: false });
    expect(row?.lastSeenAt).toBe(20);
  });
});
