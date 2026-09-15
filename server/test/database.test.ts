import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { openDb } from '../src/db/database.js';
import { tags, settings } from '../src/db/schema.js';

// The pre-Drizzle hand-rolled schema (verbatim, as it existed before Task
// 12) used to seed a legacy-baseline fixture DB below.
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  first_at INTEGER,
  last_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'terminal',
  permission_mode TEXT,
  parent_id TEXT,
  indexed_mtime INTEGER NOT NULL DEFAULT 0,
  indexed_size INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_at ON sessions(last_at DESC);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  hue INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_tags (
  session_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('rule','manual','manual_removed')),
  PRIMARY KEY (session_id, tag_id, origin)
);
CREATE TABLE IF NOT EXISTS tag_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  condition TEXT NOT NULL CHECK (condition IN ('path_matches','title_contains','permission_is')),
  pattern TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

describe('openDb', () => {
  it('creates schema via migrations, seeds defaults, and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-db-'));
    const db = openDb(join(dir, 'index.db'));
    const tableRows = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    );
    const tableNames = tableRows.map((r) => r.name);
    expect(tableNames).toEqual(
      expect.arrayContaining(['sessions', 'session_tags', 'settings', 'tag_rules', 'tags']),
    );
    const def = db.select().from(tags).where(sql`${tags.isDefault} = 1`).get();
    expect(def?.name).toBe('personal');
    expect(def?.hue).toBe(330);
    const mode = db
      .select()
      .from(settings)
      .where(sql`${settings.key} = 'default_permission_mode'`)
      .get();
    expect(mode?.value).toBe('acceptEdits');
    expect(db.$client.pragma('user_version', { simple: true })).toBe(1);
    db.$client.close();
    const again = openDb(join(dir, 'index.db')); // must not throw on re-run
    const count = again.all<{ c: number }>(sql`SELECT COUNT(*) c FROM tags`)[0];
    expect(count).toMatchObject({ c: 1 });
    again.$client.close();
  });

  it('opens cleanly against a legacy (pre-Drizzle) database, keeps existing rows, and drizzle queries work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-db-legacy-'));
    const dbPath = join(dir, 'index.db');

    // Build a legacy fixture DB exactly the way the old hand-rolled
    // database.ts used to: raw better-sqlite3, old SCHEMA string, seeds via
    // INSERT OR IGNORE, WAL + user_version=1 stamp.
    const legacy = new BetterSqlite3(dbPath);
    legacy.pragma('journal_mode = WAL');
    legacy.exec(LEGACY_SCHEMA);
    legacy
      .prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`)
      .run('default_permission_mode', 'acceptEdits');
    legacy
      .prepare(`INSERT OR IGNORE INTO tags (name, hue, is_default) VALUES ('personal', 330, 1)`)
      .run();
    // A pre-existing row that must survive the new openDb() running its
    // migration on top of this database.
    legacy
      .prepare(
        `INSERT INTO sessions (id, project_dir, cwd, title) VALUES ('legacy-1', 'p', '/x', 'pre-existing session')`,
      )
      .run();
    legacy.pragma('user_version = 1');
    legacy.close();

    // Must not throw: the initial Drizzle migration has to be a no-op
    // against a database that already has this schema.
    const db = openDb(dbPath);

    const session = db.all<{ id: string; title: string }>(
      sql`SELECT id, title FROM sessions WHERE id='legacy-1'`,
    )[0];
    expect(session).toMatchObject({ id: 'legacy-1', title: 'pre-existing session' });

    // The pre-existing default tag is untouched (seed is INSERT OR IGNORE,
    // so it must not have been duplicated).
    const tagRows = db.select().from(tags).where(sql`${tags.isDefault} = 1`).all();
    expect(tagRows).toHaveLength(1);
    expect(tagRows[0].name).toBe('personal');

    expect(db.$client.pragma('user_version', { simple: true })).toBe(1);
    db.$client.close();
  });
});
