import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PAIRING_TOKEN_TTL_MS } from '@orbital/shared/remote/relayApi';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { Migrator } from 'kysely/migration';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migration as m0001 } from '../migrations/0001_initial.js';
import { openRelayDb } from '../src/db.js';
import { openRelayStore, type RelayStore } from '../src/store.js';

const backends: [string, () => Promise<RelayStore>][] = [['sqlite', () => openRelayStore(':memory:')]];
if (process.env.RELAY_TEST_DATABASE_URL) {
  backends.push(['postgres', () => openRelayStore(process.env.RELAY_TEST_DATABASE_URL!)]);
}

describe.each(backends)('RelayStore (%s)', (_name, open) => {
  let store: RelayStore;
  beforeEach(async () => {
    store = await open();
    await store.clearForTests();
  });
  afterEach(async () => { await store.close(); });

  it('a pairing token is redeemed once, within its ttl, and then confirmed into a pair', async () => {
    await store.upsertDevice({ id: 'mac1', kind: 'mac' });
    const token = await store.createPairingToken('mac1', 1000 + PAIRING_TOKEN_TTL_MS);
    expect(await store.redeemPairingToken(token, 'phone1', 1000)).toEqual({ mac: 'mac1' });
    expect(await store.redeemPairingToken(token, 'phone2', 1000)).toBeNull();
    expect(await store.pending('mac1', 'phone1')).toBe(true);
    expect(await store.isPaired('mac1', 'phone1')).toBe(false);
    expect(await store.confirmPair('mac1', 'phone1', 2000)).toBe(true);
    expect(await store.isPaired('mac1', 'phone1')).toBe(true);
    expect(await store.isPaired('phone1', 'mac1')).toBe(true);
    expect(await store.pending('mac1', 'phone1')).toBe(false);
    expect(await store.confirmPair('mac1', 'phone1', 2000)).toBe(false);
  });
  it('an expired token answers null', async () => {
    await store.upsertDevice({ id: 'mac1', kind: 'mac' });
    const token = await store.createPairingToken('mac1', 1000 + PAIRING_TOKEN_TTL_MS);
    expect(await store.redeemPairingToken(token, 'p', 1000 + PAIRING_TOKEN_TTL_MS + 1)).toBeNull();
  });
  it('reject clears the pending request; revoke removes the pair', async () => {
    await store.upsertDevice({ id: 'mac1', kind: 'mac' });
    const t1 = await store.createPairingToken('mac1', 9000);
    await store.redeemPairingToken(t1, 'phone1', 1);
    await store.rejectPair('mac1', 'phone1');
    expect(await store.pending('mac1', 'phone1')).toBe(false);
    const t2 = await store.createPairingToken('mac1', 9000);
    await store.redeemPairingToken(t2, 'phone1', 1);
    await store.confirmPair('mac1', 'phone1', 2);
    expect(await store.peersOf('mac1')).toEqual(['phone1']);
    expect(await store.phonesOf('mac1')).toEqual(['phone1']);
    expect(await store.revokePair('mac1', 'phone1')).toBe(true);
    expect(await store.isPaired('mac1', 'phone1')).toBe(false);
    expect(await store.peersOf('phone1')).toEqual([]);
    expect(await store.revokePair('mac1', 'phone1')).toBe(false);
    expect(await store.revokePair('mac1', 'never-paired')).toBe(false);
  });
  it('devices keep a kind, a push token and a last-seen stamp, which a second upsert leaves alone', async () => {
    await store.upsertDevice({ id: 'phone1', kind: 'phone' });
    await store.setPushToken('phone1', 'fcm-abc');
    await store.touch('phone1', 123);
    await store.upsertDevice({ id: 'phone1', kind: 'phone' });
    expect(await store.device('phone1')).toEqual({ id: 'phone1', kind: 'phone', pushToken: 'fcm-abc', lastSeenAt: 123 });
    expect(await store.device('nope')).toBeNull();
  });
  it('prune drops expired open and pending tokens, but keeps a confirmed pair', async () => {
    await store.upsertDevice({ id: 'mac1', kind: 'mac' });
    await store.redeemPairingToken(await store.createPairingToken('mac1', 100), 'phone1', 1);
    await store.redeemPairingToken(await store.createPairingToken('mac1', 100), 'phone2', 1);
    await store.confirmPair('mac1', 'phone2', 2);
    await store.pruneExpiredTokens(101);
    expect(await store.pending('mac1', 'phone1')).toBe(false);
    expect(await store.confirmPair('mac1', 'phone1', 102)).toBe(false);
    expect(await store.isPaired('mac1', 'phone2')).toBe(true);
  });
  it('migrations are idempotent: opening twice is fine', async () => {
    const again = await open();
    expect(await again.device('nope')).toBeNull();
    await again.close();
  });
});

describe('migration 0002_no_names', () => {
  it('drops every name a relay from before it stored, and leaves the pairs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-'));
    const file = join(dir, 'relay.db');
    try {
      const old = new Kysely<any>({ dialect: new SqliteDialect({ database: new Database(file) }) });
      const { error } = await new Migrator({
        db: old, provider: { getMigrations: () => Promise.resolve({ '0001_initial': m0001 }) },
      }).migrateToLatest();
      expect(error).toBeUndefined();
      await old.insertInto('devices').values([
        { id: 'mac1', kind: 'mac', name: 'studio' },
        { id: 'phone1', kind: 'phone', name: 'Pixel', platform: 'android', push_token: 'fcm' },
      ]).execute();
      await old.insertInto('pairs').values({ mac: 'mac1', phone: 'phone1', created_at: 1 }).execute();
      await old.insertInto('pairing_tokens').values({
        token: 't', mac: 'mac1', expires_at: 9, phone: 'phone1', phone_name: 'Pixel', phone_platform: 'android', state: 'pending',
      }).execute();
      await old.destroy();

      const db = await openRelayDb(file);
      const columns = Object.fromEntries((await db.introspection.getTables())
        .map((t) => [t.name, t.columns.map((c) => c.name).sort()]));
      expect(columns.devices).toEqual(['id', 'kind', 'last_seen_at', 'push_token']);
      expect(columns.pairing_tokens).toEqual(['expires_at', 'mac', 'phone', 'state', 'token']);
      await db.destroy();
      const store = await openRelayStore(file);
      expect(await store.isPaired('mac1', 'phone1')).toBe(true);
      expect(await store.device('phone1')).toMatchObject({ pushToken: 'fcm' });
      expect(await store.pending('mac1', 'phone1')).toBe(true);
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
