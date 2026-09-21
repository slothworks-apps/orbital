import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { settings, tags } from './schema.js';

// Resolved relative to this module (not process.cwd()) so `openDb` works
// regardless of where the process is launched from. Only correct while the
// server runs from source: a bundled build puts `import.meta.url` somewhere
// else entirely, so the packaged app passes its own path to `openDb`
// (spec 2026-09-16-electron-wrapper-design § 2).
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

const DEFAULT_SETTINGS: Record<string, string> = {
  default_permission_mode: 'acceptEdits',
  default_project_dir: '',
  lineage_depth: '3',
  confirm_before_clear: 'true',
  inherit_tags: 'true',
  inherit_permission_mode: 'true',
  ended_after_idle_minutes: '30',
  /**
   * How long an `ended` session keeps its tag bond on the space map, in
   * minutes, or `never` — after that it is released and falls into the
   * corner hole (tag clusters, spec 2026-09-18-tag-clusters-design § 6).
   * Replaces `map_ended_max_age_days` AND `map_hide_ended`: the hole is now
   * the one answer to "where did my ended session go". Stored here but
   * applied client-side (see `mapSessions` in `web/src/store/store.ts`):
   * the map is a view, and keeping the cutoff out of `GET /api/sessions` is
   * what leaves the sidebar's HISTORY list complete and its paging intact.
   */
  map_release_ended_after_minutes: '120',
  /** Pre-selected in the New session dialog and used by Clear (canvas 4c). A
   * value the catalog does not offer falls back to its first row, client-side. */
  default_model: 'sonnet',
  remember_model_per_project: 'true',
  map_show_model: 'true',
  /**
   * Naming a session from its own contents while it runs
   * (`docs/superpowers/specs/2026-09-18-auto-title-design.md`). Off by
   * default: it spends a model in the background, so it should be a decision
   * rather than a surprise.
   */
  auto_title_sessions: 'false',
  /**
   * Appearance → default planet size (canvas 5a, `Feature - Planet
   * size.dc.html`). Stored as the normalized multiplier ('0.7'–'1.6', slider
   * step 0.05), not the slider's percent value. Applied client-side in
   * `SpaceMap` — layout and orbits never see it, only drawn body scale.
   */
  planet_scale: '1',
  /** Appearance → scale labels with bodies (canvas 5a). Off keeps session
   * names at their fixed 11px mono regardless of `planet_scale`. */
  map_scale_labels: 'false',
  /**
   * Detail panel width in CSS px, dragged via the panel's inner-edge handle.
   * The export's 450px is the default and the double-click reset. Clamped
   * client-side ([360, 60% of the viewport]) — the server just stores it.
   */
  detail_panel_width: '450',
  /** The sidebar's collapsed-to-rail state. Sticky for the same reason as
   * `map_hide_ended`: a rail that springs back open on every reload makes
   * the collapse feel broken. */
  sidebar_collapsed: 'false',
  /**
   * Master switch for the map's context-fill arc (spec `context-fill-arc`,
   * canvas 1h Sessions → MAP). Off hides the arc, its ticks and the
   * `/compact` badge; the detail panel's context readout is unaffected.
   * Default-on convention: read client-side as `!== 'false'`.
   */
  map_show_context: 'true',
  /** First context-fill threshold, percent [1, 99]. Fill above it turns the
   * arc amber. Parsed and clamped client-side (`store.ts`); a `warn >=
   * critical` pair falls back to both defaults there. */
  context_threshold_warn: '50',
  /** Second context-fill threshold, percent [1, 99]. Fill above it turns the
   * arc red (with a pulse) and is when the `/compact` badge can appear. */
  context_threshold_critical: '80',
  /** Whether the `/compact` badge shows past the second threshold, subject
   * to `map_show_context` also being on. Default-on convention. */
  map_show_compact_badge: 'true',
};

export type OrbitalDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export function openDb(
  dbPath: string,
  migrationsFolder: string = DEFAULT_MIGRATIONS_FOLDER,
): OrbitalDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  // Throws on a missing folder or a failed migration, and must keep throwing:
  // a database that skipped its migrations is worse than one that won't open.
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
