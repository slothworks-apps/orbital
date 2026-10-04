import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

export const migration: Migration = {
  async up(db: Kysely<any>) {
    await db.schema.createTable('devices')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('name', 'text', (c) => c.notNull().defaultTo(''))
      .addColumn('platform', 'text')
      .addColumn('push_token', 'text')
      .addColumn('last_seen_at', 'bigint')
      .execute();
    await db.schema.createTable('pairs')
      .addColumn('mac', 'text', (c) => c.notNull())
      .addColumn('phone', 'text', (c) => c.notNull())
      .addColumn('created_at', 'bigint', (c) => c.notNull())
      .addPrimaryKeyConstraint('pairs_pk', ['mac', 'phone'])
      .execute();
    await db.schema.createTable('pairing_tokens')
      .addColumn('token', 'text', (c) => c.primaryKey())
      .addColumn('mac', 'text', (c) => c.notNull())
      .addColumn('expires_at', 'bigint', (c) => c.notNull())
      .addColumn('phone', 'text')
      .addColumn('phone_name', 'text')
      .addColumn('phone_platform', 'text')
      .addColumn('state', 'text', (c) => c.notNull().defaultTo('open'))
      .execute();
    await db.schema.createIndex('pairing_tokens_pending')
      .on('pairing_tokens').columns(['mac', 'phone', 'state']).execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('pairing_tokens').execute();
    await db.schema.dropTable('pairs').execute();
    await db.schema.dropTable('devices').execute();
  },
};
