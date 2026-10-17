import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

/**
 * One device's half of a mutual pair (spec 2026-10-16-device-group-design
 * § 4): `from` signed that it wants a pair with `to`, until `expires_at`.
 * The pair itself goes into `pairs` once both halves are in.
 */
export const migration: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.createTable('mutual_halves')
      .addColumn('from_id', 'text', (c) => c.notNull())
      .addColumn('to_id', 'text', (c) => c.notNull())
      .addColumn('expires_at', 'bigint', (c) => c.notNull())
      .addPrimaryKeyConstraint('mutual_halves_pk', ['from_id', 'to_id'])
      .execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('mutual_halves').execute();
  },
};
