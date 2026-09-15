import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { settings, tags } from './schema.js';

// Resolved relative to this module (not process.cwd()) so `openDb` works
// regardless of where the process is launched from.
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

const DEFAULT_SETTINGS: Record<string, string> = {
  default_permission_mode: 'acceptEdits',
  default_project_dir: '',
  lineage_depth: '3',
  confirm_before_clear: 'true',
  inherit_tags: 'true',
  inherit_permission_mode: 'true',
  ended_after_idle_minutes: '30',
};

export type OrbitalDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function openDb(dbPath: string): OrbitalDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.insert(settings).values({ key, value }).onConflictDoNothing().run();
  }
  db.insert(tags).values({ name: 'personal', hue: 330, isDefault: 1 }).onConflictDoNothing().run();
  // Migration baseline (M12): a fresh or pre-Drizzle database has
  // user_version 0. Drizzle itself tracks applied migrations in its own
  // `__drizzle_migrations` table and never reads/writes this pragma — this
  // stamp exists purely for legacy/rollback compatibility (older orbital
  // builds, or any external tooling, that key off `PRAGMA user_version`),
  // and is never overwritten once a real migration has advanced it past 0.
  const userVersion = sqlite.pragma('user_version', { simple: true }) as number;
  if (userVersion === 0) sqlite.pragma('user_version = 1');
  return db;
}
