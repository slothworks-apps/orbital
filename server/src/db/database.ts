import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
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
  confirm_before_clear: 'true',
  inherit_tags: 'true',
  inherit_permission_mode: 'true',
  /** Pre-selected in the New session dialog and used by Clear (canvas 4c). A
   * value the catalog does not offer falls back to its first row, client-side. */
  default_model: 'sonnet',
  remember_model_per_project: 'true',
  map_show_model: 'true',
  /**
   * Appearance → whether the map draws the trash, the corner target a
   * dragged body is dropped on to end its session (spec
   * 2026-09-24-sessions-end-only-by-hand-design § 3). Off takes the drag
   * gesture with it; the detail header's End session button stays.
   * Default-on convention: read client-side as `!== 'false'`.
   */
  map_show_trash: 'true',
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
   * Sidebar width in CSS px, dragged via the panel's inner-edge handle — the
   * mirror of `detail_panel_width`. The export's 300px is the default and the
   * double-click reset. Clamped client-side ([280, 45% of the viewport]) —
   * the server just stores it.
   */
  sidebar_width: '300',
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
  /**
   * Settings → Appearance → TRANSCRIPT → "Edit diffs" (canvas
   * `Feature - Transcript blocks` 20f). `collapsed` or `expanded`: how an
   * `Edit` or `Write` row arrives in the transcript. An expanded row arrives
   * showing a preview rather than the whole change; opening one by hand is
   * still what shows all of it.
   *
   * In Appearance rather than Sessions because it changes only what is drawn
   * and no session's fate (adr `settings-sections-split-by-kind`). Ships
   * `collapsed`, which is how every tool row has always arrived.
   */
  transcript_edit_diffs: 'collapsed',
  /**
   * Whether an edit the session is blocked on shows its diff without being
   * asked, whatever `transcript_edit_diffs` says. Default-on convention: being
   * asked to approve a change and not being shown it is the case this exists
   * to prevent (spec `2026-09-23-permission-and-plan-decisions-design`).
   */
  transcript_expand_diff_on_permission: 'true',
  /**
   * Settings → Permissions → how a guarded approval is given (canvas
   * `Feature - Transcript blocks` 20b C). Only asks the CLI flags
   * `defaultToNo` are affected; every other ask approves on one click
   * whatever this says.
   *
   * `hold` is the canvas's own gesture and the default. `confirm` is its
   * documented alternative and the one that behaves identically from the
   * keyboard, a mouse and a trackpad. `single` removes the brake entirely —
   * offered because how much friction is worth it is the user's call, not
   * Orbital's.
   */
  permission_guard_gesture: 'hold',
  /**
   * Settings → Appearance → "Session stats in the header" (canvas
   * `Feature - Header gauges` 11c). `bar` draws the stats strip under the
   * context gauge; `button` drops the strip and folds stats into the header's
   * icon row instead, where it opens the same dialog.
   *
   * Per install rather than per session: it is a density preference about how
   * a header is drawn, not a property of any one conversation. Read
   * client-side as `=== 'button'`, so anything unrecognised draws the bar.
   */
  header_session_stats: 'bar',
  /**
   * Settings → Appearance → the PR in the header (canvas `Feature - Branch
   * status` 1g, spec 2026-09-30-branch-pr-and-line-changes-design § Settings).
   * On, the header shows the pull request of the session's branch, looked up
   * with the user's own `gh`. Read as `=== 'true'`, so it is off unless
   * turned on: it spawns `gh`, which goes to the network. When `gh` cannot
   * be used the switch draws off, but the stored choice stays.
   */
  header_pull_request: 'false',
  /**
   * Settings → Appearance → line changes in the header (canvas `Feature -
   * Branch status` 1g, same spec). `branch` shows one total against the
   * parent branch; `split` also shows the uncommitted part on its own. For
   * the server the two are the same reading, drawn differently. Anything
   * else reads as off — the default, since it spawns `git`.
   */
  header_line_changes: 'off',
  /**
   * Settings → Appearance → MAP → "State on the map" (canvas `Feature - State
   * colours` 24a / 24e, ADR state-labels-are-dots-first-on-the-map). `dot`
   * draws each planet's state pill as a small coloured disc that spells the
   * word out on hover; `label` spells it out always. Read client-side as
   * `=== 'label'`, so anything unrecognised draws dots — the default.
   */
  map_state_pills: 'dot',
  /**
   * Absolute path to the Claude Code CLI the runner should spawn. Empty means
   * autodetect: the SDK's bundled binary in dev, the first `claude` on PATH in
   * the packaged app (spec 2026-09-16-electron-wrapper-design §3).
   */
  claude_executable_path: '',
  /**
   * The `~/.claude` tree the watcher and the registry read (Settings →
   * General, spec 2026-09-21-settings-sections-design § 4). Empty means
   * `~/.claude`. `ORBITAL_CLAUDE_DIR` still wins over whatever is stored
   * here — see `resolveClaudeDir` for the full order. Read once at boot,
   * which is why the row says a change needs a restart.
   */
  claude_directory: '',
  /**
   * Settings → Notifications (spec 2026-09-21-settings-sections-design § 5).
   * Seeded 'true' across the board, and that is not a preference: it is what
   * the desktop app did before the section existed — all three events fired,
   * the focus check was unconditional, and `silent` was never set. The
   * desktop side reads them the same way (`!== 'false'`), so a database that
   * predates these rows behaves identically to one that has them.
   */
  notify_needs_input: 'true',
  notify_session_ended: 'true',
  notify_session_failed: 'true',
  notify_only_when_background: 'true',
  notify_sound: 'true',
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
  // Seeded only while no default exists, never by name: the default can be
  // renamed, and a name-keyed seed re-created it on every boot after that.
  const hasDefault = db.select({ id: tags.id }).from(tags).where(eq(tags.isDefault, 1)).get();
  if (!hasDefault) {
    db.insert(tags)
      .values({ name: 'default', hue: 330, isDefault: 1 })
      .onConflictDoUpdate({ target: tags.name, set: { isDefault: 1 } })
      .run();
  }
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
