/**
 * What the relay remembers: who exists, who is paired with whom, which
 * pairing tokens are open, and where to push. Nothing about sessions — that
 * is the whole point (spec 2026-09-30-mobile-remote-design § 2). A pair's
 * existence is also cached on each live connection (`Conn.peers`, ws.ts), so
 * routing a frame never waits on this store.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { asNumber, openRelayDb, type RelayDb } from './db.js';

export type DeviceKind = 'mac' | 'phone';
export type DeviceRow = {
  id: string; kind: DeviceKind; name: string; platform: string | null;
  pushToken: string | null; lastSeenAt: number | null;
};

export interface RelayStore {
  upsertDevice(d: { id: string; kind: DeviceKind; name?: string; platform?: string }): Promise<void>;
  device(id: string): Promise<DeviceRow | null>;
  touch(id: string, now: number): Promise<void>;
  setPushToken(id: string, token: string | null): Promise<void>;
  createPairingToken(mac: string, expiresAt: number): Promise<string>;
  /** Open and unexpired → pending for this phone; anything else → null. */
  redeemPairingToken(token: string, phone: string, name: string, platform: string, now: number): Promise<{ mac: string } | null>;
  pending(mac: string, phone: string): Promise<{ name: string; platform: string } | null>;
  confirmPair(mac: string, phone: string, now: number): Promise<boolean>;
  rejectPair(mac: string, phone: string): Promise<void>;
  /** True when a pair was actually deleted. */
  revokePair(mac: string, phone: string): Promise<boolean>;
  isPaired(a: string, b: string): Promise<boolean>;
  /** Every device paired with this one, whichever side it is. */
  peersOf(id: string): Promise<string[]>;
  phonesOf(mac: string): Promise<string[]>;
  pruneExpiredTokens(now: number): Promise<void>;
  /** Empties every table. Tests only; the name says so. */
  clearForTests(): Promise<void>;
  close(): Promise<void>;
}

export class KyselyRelayStore implements RelayStore {
  constructor(private readonly db: RelayDb) {}

  async upsertDevice(d: { id: string; kind: DeviceKind; name?: string; platform?: string }): Promise<void> {
    const name = d.name ?? '';
    await this.db.insertInto('devices')
      .values({ id: d.id, kind: d.kind, name, platform: d.platform ?? null })
      .onConflict((oc) => oc.column('id').doUpdateSet((eb) => ({
        kind: d.kind,
        // An empty name never overwrites a real one: a reconnecting phone
        // does not know its name, the pairing did.
        name: name === '' ? eb.ref('devices.name') : name,
        platform: d.platform ?? eb.ref('devices.platform'),
      })))
      .execute();
  }

  async device(id: string): Promise<DeviceRow | null> {
    const row = await this.db.selectFrom('devices')
      .select(['id', 'kind', 'name', 'platform', 'push_token', 'last_seen_at'])
      .where('id', '=', id).executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id, kind: row.kind, name: row.name, platform: row.platform,
      pushToken: row.push_token, lastSeenAt: asNumber(row.last_seen_at),
    };
  }

  async touch(id: string, now: number): Promise<void> {
    await this.db.updateTable('devices').set({ last_seen_at: now }).where('id', '=', id).execute();
  }

  async setPushToken(id: string, token: string | null): Promise<void> {
    await this.db.updateTable('devices').set({ push_token: token }).where('id', '=', id).execute();
  }

  async createPairingToken(mac: string, expiresAt: number): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await this.db.insertInto('pairing_tokens').values({ token, mac, expires_at: expiresAt, state: 'open' }).execute();
    return token;
  }

  async redeemPairingToken(token: string, phone: string, name: string, platform: string, now: number) {
    const open = await this.db.selectFrom('pairing_tokens').select('mac')
      .where('token', '=', token).where('state', '=', 'open').where('expires_at', '>=', now)
      .executeTakeFirst();
    if (!open) return null;
    // The state check in the UPDATE is what makes a double redeem lose the race.
    const result = await this.db.updateTable('pairing_tokens')
      .set({ state: 'pending', phone, phone_name: name, phone_platform: platform })
      .where('token', '=', token).where('state', '=', 'open')
      .executeTakeFirst();
    return result.numUpdatedRows === 1n ? { mac: open.mac } : null;
  }

  async pending(mac: string, phone: string) {
    const row = await this.db.selectFrom('pairing_tokens')
      .select(['phone_name', 'phone_platform'])
      .where('mac', '=', mac).where('phone', '=', phone).where('state', '=', 'pending')
      .executeTakeFirst();
    return row ? { name: row.phone_name ?? '', platform: row.phone_platform ?? '' } : null;
  }

  async confirmPair(mac: string, phone: string, now: number): Promise<boolean> {
    const result = await this.db.updateTable('pairing_tokens').set({ state: 'confirmed' })
      .where('mac', '=', mac).where('phone', '=', phone).where('state', '=', 'pending')
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) return false;
    await this.db.insertInto('pairs').values({ mac, phone, created_at: now })
      .onConflict((oc) => oc.columns(['mac', 'phone']).doNothing()).execute();
    return true;
  }

  async rejectPair(mac: string, phone: string): Promise<void> {
    await this.db.updateTable('pairing_tokens').set({ state: 'rejected' })
      .where('mac', '=', mac).where('phone', '=', phone).where('state', '=', 'pending').execute();
  }

  async revokePair(mac: string, phone: string): Promise<boolean> {
    const result = await this.db.deleteFrom('pairs')
      .where('mac', '=', mac).where('phone', '=', phone)
      .executeTakeFirst();
    return result.numDeletedRows === 1n;
  }

  async isPaired(a: string, b: string): Promise<boolean> {
    const row = await this.db.selectFrom('pairs').select(sql<number>`1`.as('one'))
      .where((eb) => eb.or([
        eb.and([eb('mac', '=', a), eb('phone', '=', b)]),
        eb.and([eb('mac', '=', b), eb('phone', '=', a)]),
      ]))
      .executeTakeFirst();
    return row !== undefined;
  }

  async peersOf(id: string): Promise<string[]> {
    const asMac = await this.db.selectFrom('pairs').select('phone as peer').where('mac', '=', id).execute();
    const asPhone = await this.db.selectFrom('pairs').select('mac as peer').where('phone', '=', id).execute();
    return [...new Set([...asMac, ...asPhone].map((r) => r.peer))].sort();
  }

  async phonesOf(mac: string): Promise<string[]> {
    const rows = await this.db.selectFrom('pairs').select('phone').where('mac', '=', mac).orderBy('phone').execute();
    return rows.map((r) => r.phone);
  }

  async pruneExpiredTokens(now: number): Promise<void> {
    // A pending request past its expiry goes too: the Mac stops offering its
    // confirmation when the code expires, so nobody can confirm it any more.
    await this.db.deleteFrom('pairing_tokens')
      .where('expires_at', '<', now).where('state', 'in', ['open', 'pending', 'rejected']).execute();
  }

  async clearForTests(): Promise<void> {
    await this.db.deleteFrom('pairing_tokens').execute();
    await this.db.deleteFrom('pairs').execute();
    await this.db.deleteFrom('devices').execute();
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}

export async function openRelayStore(target: string): Promise<RelayStore> {
  return new KyselyRelayStore(await openRelayDb(target));
}
