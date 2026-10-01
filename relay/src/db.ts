/**
 * The relay's tables, once, for both dialects (spec
 * 2026-09-30-mobile-remote-design § 2). SQLite is for tests and a laptop;
 * every real deployment runs Postgres (`RELAY_DATABASE_URL`). Timestamps are
 * epoch milliseconds in a BIGINT; pg hands those back as strings, so the
 * store converts them (`asNumber`).
 */
import Database from 'better-sqlite3';
import { Kysely, Migrator, PostgresDialect, SqliteDialect, type Migration, type MigrationProvider } from 'kysely';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { migration as m0001 } from '../migrations/0001_initial.js';

export interface DevicesTable {
  id: string;
  kind: 'mac' | 'phone';
  name: string;
  platform: string | null;
  push_token: string | null;
  last_seen_at: number | string | null;
}
export interface PairsTable {
  mac: string;
  phone: string;
  created_at: number | string;
}
export interface PairingTokensTable {
  token: string;
  mac: string;
  expires_at: number | string;
  phone: string | null;
  phone_name: string | null;
  phone_platform: string | null;
  state: 'open' | 'pending' | 'confirmed' | 'rejected';
}
export interface RelayDatabase {
  devices: DevicesTable;
  pairs: PairsTable;
  pairing_tokens: PairingTokensTable;
}

export type RelayDb = Kysely<RelayDatabase>;

/** Every migration, in order, by name. Add a line here for each new file. */
const MIGRATIONS: Record<string, Migration> = {
  '0001_initial': m0001,
};

const provider: MigrationProvider = { getMigrations: () => Promise.resolve(MIGRATIONS) };

export function isPostgresUrl(target: string): boolean {
  return /^postgres(ql)?:\/\//.test(target);
}

/** `:memory:` or a file path → SQLite; `postgres://…` → Postgres. Migrates to latest. */
export async function openRelayDb(target: string): Promise<RelayDb> {
  let db: RelayDb;
  if (isPostgresUrl(target)) {
    db = new Kysely<RelayDatabase>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: target }) }) });
  } else {
    if (target !== ':memory:') mkdirSync(dirname(target), { recursive: true });
    const sqlite = new Database(target);
    sqlite.pragma('journal_mode = WAL');
    db = new Kysely<RelayDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
  }
  const { error } = await new Migrator({ db, provider }).migrateToLatest();
  if (error) {
    await db.destroy();
    throw error instanceof Error ? error : new Error('relay migration failed', { cause: error });
  }
  return db;
}

export function asNumber(v: number | string | null): number | null {
  return v === null ? null : Number(v);
}
