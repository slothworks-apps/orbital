import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * The relay keeps no device names (spec 2026-10-08-relay-knows-no-names-design):
 * the Mac's name, the phone's name and its platform go, with whatever was
 * stored in them. One column per statement, as SQLite alters one at a time.
 */
export const migration: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.alterTable('devices').dropColumn('name').execute();
    await db.schema.alterTable('devices').dropColumn('platform').execute();
    await db.schema.alterTable('pairing_tokens').dropColumn('phone_name').execute();
    await db.schema.alterTable('pairing_tokens').dropColumn('phone_platform').execute();
  },
  async down(db: Kysely<any>) {
    // The columns come back empty: the names they held are gone for good.
    await db.schema.alterTable('devices').addColumn('name', 'text', (c) => c.notNull().defaultTo('')).execute();
    await db.schema.alterTable('devices').addColumn('platform', 'text').execute();
    await db.schema.alterTable('pairing_tokens').addColumn('phone_name', 'text').execute();
    await db.schema.alterTable('pairing_tokens').addColumn('phone_platform', 'text').execute();
  },
};
