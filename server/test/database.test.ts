import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { openDb } from '../src/db/database.js';
import { tags, settings } from '../src/db/schema.js';
import { effectiveTagIds, regenerateRuleTags } from '../src/tags/rules.js';

// Verbatim copy of the DEFAULT_SETTINGS the pre-Drizzle database.ts used to
// seed via INSERT OR IGNORE, for the legacy-baseline fixture below.
const LEGACY_SETTINGS: Record<string, string> = {
  default_permission_mode: 'acceptEdits',
  default_project_dir: '',
  lineage_depth: '3',
  confirm_before_clear: 'true',
  inherit_tags: 'true',
  inherit_permission_mode: 'true',
  ended_after_idle_minutes: '30',
};

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

/**
 * How many migrations exist on disk, read from Drizzle's own journal rather
 * than hardcoded — the assertion below is about "applied exactly once each",
 * and a literal count turns every new migration into an unrelated test
 * failure.
 */
function migrationsOnDisk(): number {
  const journal = JSON.parse(
    readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

describe('openDb', () => {
  it('creates schema via migrations, seeds defaults, and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-db-'));
    const db = openDb(join(dir, 'index.db'));
    const tableRows = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
    );
    const tableNames = tableRows.map((r) => r.name);
    expect(tableNames).toEqual(
      expect.arrayContaining([
        'errors', 'sessions', 'session_tags', 'settings', 'tag_rules', 'tags',
      ]),
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
    // The map stops drawing ended sessions after a day by default; the web
    // client reads this key and applies the cutoff itself.
    const endedAge = db
      .select()
      .from(settings)
      .where(sql`${settings.key} = 'map_ended_max_age_days'`)
      .get();
    expect(endedAge?.value).toBe('1');
    expect(db.$client.pragma('user_version', { simple: true })).toBe(1);
    db.$client.close();
    const again = openDb(join(dir, 'index.db')); // must not throw on re-run
    const count = again.all<{ c: number }>(sql`SELECT COUNT(*) c FROM tags`)[0];
    expect(count).toMatchObject({ c: 1 });
    again.$client.close();
  });

  it('opens cleanly against a legacy (pre-Drizzle) database, keeps existing rows across all five tables, honors manual_removed on rule regeneration, does not duplicate seeds, and is idempotent on a second open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-db-legacy-'));
    const dbPath = join(dir, 'index.db');

    // Build a legacy fixture DB exactly the way the old hand-rolled
    // database.ts used to: raw better-sqlite3, old SCHEMA string, seeds via
    // INSERT OR IGNORE, WAL + user_version=1 stamp. Populate all five
    // tables so the migration's IF NOT EXISTS baseline is exercised against
    // real pre-existing data everywhere, not just `sessions`.
    const legacy = new BetterSqlite3(dbPath);
    legacy.pragma('journal_mode = WAL');
    legacy.exec(LEGACY_SCHEMA);
    const insertSetting = legacy.prepare(
      `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
    );
    for (const [k, v] of Object.entries(LEGACY_SETTINGS)) insertSetting.run(k, v);
    legacy
      .prepare(`INSERT OR IGNORE INTO tags (name, hue, is_default) VALUES ('personal', 330, 1)`)
      .run();
    // A second, non-default tag with a rule that matches by title, to
    // exercise rule regeneration below.
    legacy
      .prepare(`INSERT INTO tags (id, name, hue, is_default) VALUES (10, 'work', 210, 0)`)
      .run();
    legacy
      .prepare(
        `INSERT INTO tag_rules (id, tag_id, position, enabled, condition, pattern)
         VALUES (1, 10, 0, 1, 'title_contains', 'legacy')`,
      )
      .run();
    // Three pre-existing sessions that must survive the new openDb()
    // running its migration on top of this database:
    //  - legacy-1: title doesn't match the rule -> falls back to default tag.
    //  - legacy-2: title matches the rule, no manual removal -> gets the rule tag.
    //  - legacy-3: title matches the rule, but has a pre-existing
    //    'manual_removed' session_tags row -> the rule tag must stay suppressed.
    legacy
      .prepare(
        `INSERT INTO sessions (id, project_dir, cwd, title) VALUES
         ('legacy-1', 'p', '/x', 'pre-existing session'),
         ('legacy-2', 'p', '/x', 'legacy match'),
         ('legacy-3', 'p', '/x', 'legacy removed')`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO session_tags (session_id, tag_id, origin) VALUES ('legacy-3', 10, 'manual_removed')`,
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

    // The pre-existing default tag is untouched (seed is onConflictDoNothing,
    // so it must not have been duplicated), and the pre-existing non-default
    // tag survived too.
    const defaultTagRows = db.select().from(tags).where(eq(tags.isDefault, 1)).all();
    expect(defaultTagRows).toHaveLength(1);
    expect(defaultTagRows[0].name).toBe('personal');
    const workTag = db.select().from(tags).where(eq(tags.name, 'work')).get();
    expect(workTag).toMatchObject({ id: 10, hue: 210 });

    // Settings seeds are not duplicated: exactly the known keys, with the
    // legacy DB's pre-existing values preserved (openDb's seed is
    // onConflictDoNothing, so it must not overwrite them).
    // Settings keys added since this legacy baseline DO get seeded here —
    // that is how an existing database picks up a new default instead of
    // reading the key as missing forever.
    const settingsRows = db.select().from(settings).all();
    expect(Object.fromEntries(settingsRows.map((r) => [r.key, r.value]))).toEqual({
      ...LEGACY_SETTINGS,
      map_ended_max_age_days: '1',
      default_model: 'sonnet',
      remember_model_per_project: 'true',
      map_show_model: 'true',
      map_hide_ended: 'false',
      planet_scale: '1',
      map_scale_labels: 'false',
      detail_panel_width: '450',
      sidebar_collapsed: 'false',
    });

    // Rule regeneration works against the migrated legacy data, and honors
    // the pre-existing manual_removed row.
    regenerateRuleTags(db);
    const defaultTagId = defaultTagRows[0].id;
    expect(effectiveTagIds(db, 'legacy-1')).toEqual([defaultTagId]); // no rule match
    expect(effectiveTagIds(db, 'legacy-2')).toEqual([10]); // rule match, not removed
    expect(effectiveTagIds(db, 'legacy-3')).toEqual([defaultTagId]); // rule match, but manual_removed

    expect(db.$client.pragma('user_version', { simple: true })).toBe(1);
    db.$client.close();

    // Re-opening the same (now-migrated) database a second time must be a
    // pure no-op: no error, and Drizzle's own migration bookkeeping table
    // must still show exactly as many applied migrations as exist on disk
    // (not re-applied, not applied twice).
    const reopened = openDb(dbPath);
    const migrationCount = reopened.all<{ c: number }>(
      sql`SELECT COUNT(*) c FROM __drizzle_migrations`,
    )[0];
    expect(migrationCount.c).toBe(migrationsOnDisk());
    expect(reopened.$client.pragma('user_version', { simple: true })).toBe(1);
    reopened.$client.close();
  });
});
