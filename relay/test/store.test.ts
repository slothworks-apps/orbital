import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PAIRING_TOKEN_TTL_MS } from '@orbital/shared/remote/relayApi';
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
    await store.upsertDevice({ id: 'mac1', kind: 'mac', name: 'studio' });
    const token = await store.createPairingToken('mac1', 1000 + PAIRING_TOKEN_TTL_MS);
    expect(await store.redeemPairingToken(token, 'phone1', 'Pixel', 'android', 1000)).toEqual({ mac: 'mac1' });
    expect(await store.redeemPairingToken(token, 'phone2', 'Other', 'ios', 1000)).toBeNull();
    expect(await store.pending('mac1', 'phone1')).toEqual({ name: 'Pixel', platform: 'android' });
    expect(await store.isPaired('mac1', 'phone1')).toBe(false);
    expect(await store.confirmPair('mac1', 'phone1', 2000)).toBe(true);
    expect(await store.isPaired('mac1', 'phone1')).toBe(true);
    expect(await store.isPaired('phone1', 'mac1')).toBe(true);
    expect(await store.pending('mac1', 'phone1')).toBeNull();
    expect(await store.confirmPair('mac1', 'phone1', 2000)).toBe(false);
  });
  it('an expired token answers null', async () => {
    await store.upsertDevice({ id: 'mac1', kind: 'mac', name: 'studio' });
    const token = await store.createPairingToken('mac1', 1000 + PAIRING_TOKEN_TTL_MS);
    expect(await store.redeemPairingToken(token, 'p', 'n', 'android', 1000 + PAIRING_TOKEN_TTL_MS + 1)).toBeNull();
  });
  it('reject clears the pending request; revoke removes the pair', async () => {
    await store.upsertDevice({ id: 'mac1', kind: 'mac', name: 'studio' });
    const t1 = await store.createPairingToken('mac1', 9000);
    await store.redeemPairingToken(t1, 'phone1', 'n', 'android', 1);
    await store.rejectPair('mac1', 'phone1');
    expect(await store.pending('mac1', 'phone1')).toBeNull();
    const t2 = await store.createPairingToken('mac1', 9000);
    await store.redeemPairingToken(t2, 'phone1', 'n', 'android', 1);
    await store.confirmPair('mac1', 'phone1', 2);
    expect(await store.peersOf('mac1')).toEqual(['phone1']);
    expect(await store.phonesOf('mac1')).toEqual(['phone1']);
    expect(await store.revokePair('mac1', 'phone1')).toBe(true);
    expect(await store.isPaired('mac1', 'phone1')).toBe(false);
    expect(await store.peersOf('phone1')).toEqual([]);
    expect(await store.revokePair('mac1', 'phone1')).toBe(false);
    expect(await store.revokePair('mac1', 'never-paired')).toBe(false);
  });
  it('devices keep a name, a push token and a last-seen stamp', async () => {
    await store.upsertDevice({ id: 'phone1', kind: 'phone', name: 'Pixel', platform: 'android' });
    await store.setPushToken('phone1', 'fcm-abc');
    await store.touch('phone1', 123);
    expect(await store.device('phone1')).toMatchObject({ kind: 'phone', name: 'Pixel', pushToken: 'fcm-abc', lastSeenAt: 123 });
    await store.upsertDevice({ id: 'phone1', kind: 'phone', name: 'Pixel 9' });
    expect((await store.device('phone1'))?.name).toBe('Pixel 9');
    expect(await store.device('nope')).toBeNull();
  });
  it('an empty name never overwrites a real one', async () => {
    await store.upsertDevice({ id: 'phone1', kind: 'phone', name: 'Pixel', platform: 'android' });
    await store.upsertDevice({ id: 'phone1', kind: 'phone' });
    expect(await store.device('phone1')).toMatchObject({ name: 'Pixel', platform: 'android' });
    await store.upsertDevice({ id: 'phone1', kind: 'phone', name: '', platform: 'ios' });
    expect(await store.device('phone1')).toMatchObject({ name: 'Pixel', platform: 'ios' });
  });
  it('prune drops expired open and pending tokens, but keeps a confirmed pair', async () => {
    await store.upsertDevice({ id: 'mac1', kind: 'mac', name: 'studio' });
    await store.redeemPairingToken(await store.createPairingToken('mac1', 100), 'phone1', 'n', 'android', 1);
    await store.redeemPairingToken(await store.createPairingToken('mac1', 100), 'phone2', 'n', 'android', 1);
    await store.confirmPair('mac1', 'phone2', 2);
    await store.pruneExpiredTokens(101);
    expect(await store.pending('mac1', 'phone1')).toBeNull();
    expect(await store.confirmPair('mac1', 'phone1', 102)).toBe(false);
    expect(await store.isPaired('mac1', 'phone2')).toBe(true);
  });
  it('migrations are idempotent: opening twice is fine', async () => {
    const again = await open();
    expect(await again.device('nope')).toBeNull();
    await again.close();
  });
});
