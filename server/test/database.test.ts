import { describe, it, expect } from 'vitest';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_MIGRATIONS_FOLDER, openDb } from '../src/db/database.js';
import { tags, settings } from '../src/db/schema.js';
import { effectiveTagIds, regenerateRuleTags } from '../src/tags/rules.js';
import { makeTmpDir, openTmpDb } from './tmp.js';

// Verbatim copy of the DEFAULT_SETTINGS the pre-Drizzle database.ts used to
// seed via INSERT OR IGNORE, for the legacy-baseline fixture below.
const LEGACY_SETTINGS: Record<string, string> = {
  default_permission_mode: 'acceptEdits',
  default_project_dir: '',
  lineage_depth: '3',
  confirm_before_clear: 'true',
  inherit_tags: 'true',
  inherit_permission_mode: 'true',
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
    const dir = makeTmpDir('db');
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
    expect(def?.name).toBe('default');
    expect(def?.hue).toBe(330);
    const mode = db
      .select()
      .from(settings)
      .where(sql`${settings.key} = 'default_permission_mode'`)
      .get();
    expect(mode?.value).toBe('acceptEdits');
    // Naming sessions from their contents spends a model in the background,
    // so it is off until someone turns it on.
    const autoTitle = db
      .select()
      .from(settings)
      .where(sql`${settings.key} = 'auto_title_sessions'`)
      .get();
    expect(autoTitle?.value).toBe('false');
    expect(db.$client.pragma('user_version', { simple: true })).toBe(1);
    db.$client.close();
    const again = openDb(join(dir, 'index.db')); // must not throw on re-run
    const count = again.all<{ c: number }>(sql`SELECT COUNT(*) c FROM tags`)[0];
    expect(count).toMatchObject({ c: 1 });
    again.$client.close();
  });

  it('opens cleanly against a legacy (pre-Drizzle) database, keeps existing rows across all five tables, honors manual_removed on rule regeneration, does not duplicate seeds, and is idempotent on a second open', () => {
    const dir = makeTmpDir('db-legacy');
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
      default_model: 'sonnet',
      remember_model_per_project: 'true',
      map_show_model: 'true',
      map_show_trash: 'true',
      planet_scale: '1',
      map_scale_labels: 'false',
      detail_panel_width: '450',
      sidebar_collapsed: 'false',
      sidebar_width: '300',
      auto_title_sessions: 'false',
      map_show_context: 'true',
      context_threshold_warn: '50',
      context_threshold_critical: '80',
      map_show_compact_badge: 'true',
      transcript_edit_diffs: 'collapsed',
      transcript_expand_diff_on_permission: 'true',
      permission_guard_gesture: 'hold',
      header_session_stats: 'bar',
      header_pull_request: 'false',
      header_line_changes: 'off',
      map_state_pills: 'dot',
      claude_executable_path: '',
      claude_directory: '',
      notify_needs_input: 'true',
      notify_session_ended: 'true',
      notify_session_failed: 'true',
      notify_only_when_background: 'true',
      notify_sound: 'true',
      session_instructions_tips: 'true',
      session_instructions_custom: 'true',
      session_instructions_custom_text: '',
      remote_enabled: 'false',
      remote_relay_url: '',
      remote_relay_secret: '',
      remote_mac_name: '',
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

// The packaged app runs from a bundle where `import.meta.url` no longer sits
// next to `drizzle/`, so it passes its own unpacked path in (spec
// 2026-09-16-electron-wrapper-design § 2).
describe('openDb migrations folder', () => {
  it('accepts an explicit folder', () => {
    const dir = makeTmpDir('db-migrations');
    const db = openDb(join(dir, 'index.db'), DEFAULT_MIGRATIONS_FOLDER);
    const count = db.all<{ c: number }>(sql`SELECT COUNT(*) c FROM __drizzle_migrations`)[0];
    expect(count.c).toBe(migrationsOnDisk());
    db.$client.close();
  });

  it('throws when the folder does not exist, rather than opening an unmigrated database', () => {
    const dir = makeTmpDir('db-migrations-missing');
    expect(() => openDb(join(dir, 'index.db'), join(dir, 'no-such-drizzle'))).toThrow();
  });
});

// Spec 2026-09-24-sessions-end-only-by-hand-design § 3–4: the trash replaces
// the timed release, and lineage is gone. Old databases keep the retired
// rows; a fresh one never gets them.
describe('map settings defaults', () => {
  it('seeds map_show_trash and none of the retired map and lineage keys', () => {
    const db = openTmpDb('defaults');
    const rows = Object.fromEntries(db.select().from(settings).all().map((r) => [r.key, r.value]));
    expect(rows.map_show_trash).toBe('true');
    for (const retired of [
      'map_release_ended_after_minutes', 'lineage_depth', 'map_hide_ended', 'map_ended_max_age_days',
    ]) {
      expect(rows[retired]).toBeUndefined();
    }
    db.$client.close();
  });
});

/**
 * A copy of the migrations folder cut off just before the migration whose tag
 * ends in `suffix` — the database an older build would have left behind.
 * Truncated rather than filtered: Drizzle applies only migrations newer than
 * the last one it recorded, so leaving a later one in would make it skip the
 * one under test.
 */
function migrationsBefore(dir: string, suffix: string): string {
  const before = join(dir, 'drizzle-before');
  cpSync(DEFAULT_MIGRATIONS_FOLDER, before, { recursive: true });
  const journalPath = join(before, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((e) => e.tag.endsWith(suffix));
  expect(cut).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, cut);
  writeFileSync(journalPath, JSON.stringify(journal));
  return before;
}

// Spec 2026-09-24-sessions-end-only-by-hand-design § 6: without the backfill
// every historical Orbital session would come back onto the map as idle.
describe('ended_at migration', () => {
  it('stamps unowned Orbital sessions and leaves owned and terminal ones alone', () => {
    const dir = makeTmpDir('db-ended');
    const dbPath = join(dir, 'index.db');
    const old = openDb(dbPath, migrationsBefore(dir, '_sessions_end_only_by_hand'));
    old.$client.exec(`
      INSERT INTO sessions (id, project_dir, source, last_at, runner_status, parent_id) VALUES
        ('web-old', 'p', 'web', 500, NULL, NULL),
        ('web-never', 'p', 'web', NULL, NULL, 'web-old'),
        ('web-owned', 'p', 'web', 700, 'working', NULL),
        ('cli', 'p', 'terminal', 900, NULL, NULL);
    `);
    old.$client.close();

    const before = Date.now();
    const db = openDb(dbPath);
    const endedAt = Object.fromEntries(
      db.$client.prepare('SELECT id, ended_at FROM sessions').all()
        .map((r: any) => [r.id, r.ended_at]),
    );
    expect(endedAt['web-old']).toBe(500);
    // No activity to date it by: stamped with the moment of the migration.
    expect(endedAt['web-never']).toBeGreaterThanOrEqual(before);
    expect(endedAt['web-never']).toBeLessThanOrEqual(Date.now());
    expect(endedAt['web-owned']).toBeNull();
    expect(endedAt['cli']).toBeNull();
    const columns = db.$client.prepare('PRAGMA table_info(sessions)').all().map((c: any) => c.name);
    expect(columns).not.toContain('parent_id');
    expect(columns).not.toContain('map_dismissed_at');
    db.$client.close();
  });
});

// The boot seed used to key on the name 'personal', so renaming the default
// tag made the next boot seed another one — each undeletable, and only the
// lowest id ever used as the fallback.
describe('default tag', () => {
  it('survives a rename without a second default being seeded', () => {
    const dir = makeTmpDir('db-default');
    const dbPath = join(dir, 'index.db');
    const first = openDb(dbPath);
    first.update(tags).set({ name: 'orbital' }).where(eq(tags.isDefault, 1)).run();
    first.$client.close();

    const db = openDb(dbPath);
    const defaults = db.select().from(tags).where(eq(tags.isDefault, 1)).all();
    expect(defaults.map((t) => t.name)).toEqual(['orbital']);
    db.$client.close();
  });

  it('takes over a plain tag already named default rather than failing the seed', () => {
    const dir = makeTmpDir('db-default');
    const dbPath = join(dir, 'index.db');
    const first = openDb(dbPath);
    first.update(tags).set({ name: 'orbital', isDefault: 0 }).run();
    first.insert(tags).values({ name: 'default', hue: 110 }).run();
    first.$client.close();

    const db = openDb(dbPath);
    const defaults = db.select().from(tags).where(eq(tags.isDefault, 1)).all();
    expect(defaults).toMatchObject([{ name: 'default', hue: 110 }]);
    db.$client.close();
  });

  it('migration keeps only the lowest-id default of several', () => {
    const dir = makeTmpDir('db-default');
    const dbPath = join(dir, 'index.db');
    // Every migration before the one that adds the unique index.
    const old = openDb(dbPath, migrationsBefore(dir, '_one_default_tag'));
    old.insert(tags).values([
      { name: 'atlas', hue: 150, isDefault: 1 },
      { name: 'personal-again', hue: 330, isDefault: 1 },
    ]).run();
    const firstDefault = old.select().from(tags).where(eq(tags.isDefault, 1)).orderBy(tags.id).get();
    old.$client.close();

    const db = openDb(dbPath);
    const defaults = db.select().from(tags).where(eq(tags.isDefault, 1)).all();
    expect(defaults.map((t) => t.id)).toEqual([firstDefault!.id]);
    expect(() => db.update(tags).set({ isDefault: 1 }).where(eq(tags.name, 'atlas')).run()).toThrow();
    db.$client.close();
  });
});
