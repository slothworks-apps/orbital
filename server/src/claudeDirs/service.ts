import { asc, eq } from 'drizzle-orm';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import type { OrbitalDb } from '../db/database.js';
import { claudeDirs, sessions, settings as settingsTable } from '../db/schema.js';
import { resolveClaudeDir } from '../paths.js';
import {
  FIRST_CLAUDE_DIR_ID,
  UNOWNED_CLAUDE_DIR_ID,
  claudeDirEnv,
  cliDefaultDir,
  fsPathProbe,
  readAccountEmail,
  validateClaudeDirPath,
  type ClaudeDirPathError,
  type PathProbe,
} from './paths.js';

import { DEFAULT_CLAUDE_DIR_KEY, RETIRED_CLAUDE_DIRECTORY_KEY } from './keys.js';

export { DEFAULT_CLAUDE_DIR_KEY, LAST_CLAUDE_DIR_KEY, RETIRED_CLAUDE_DIRECTORY_KEY } from './keys.js';

/** The name row 1 is seeded with. */
export const FIRST_CLAUDE_DIR_NAME = 'Personal';

/** A configured directory as the server uses it. */
export interface ClaudeDir {
  id: number;
  name: string;
  /** The path in effect — `ORBITAL_CLAUDE_DIR` for row 1 when it is set. */
  path: string;
  /** Row 1's path comes from the environment, not from the row. */
  overriddenByEnv: boolean;
}

/** One row of `GET /api/claude-dirs`. */
export interface ClaudeDirInfo extends ClaudeDir {
  isDefault: boolean;
  /** The directory is there on disk now. */
  exists: boolean;
  /** The login's e-mail from the directory's `.claude.json`, or null — never an error. */
  account: string | null;
}

/** What runs for one directory while it is configured; stopped when it is removed. */
export interface ClaudeDirContext {
  stop(): void;
}

export type ClaudeDirError = ClaudeDirPathError | 'name_required' | 'not_found' | 'last_directory';

export type ClaudeDirResult = { ok: true; dir: ClaudeDir } | { ok: false; error: ClaudeDirError };

/**
 * Seeds row 1 when the table is empty, from what the single-directory
 * server watched (the retired `claude_directory` setting, else `~/.claude`),
 * and drops the retired setting. At boot, not in the migration: a migration
 * cannot know the home directory (spec
 * 2026-10-04-multiple-claude-directories-design § 1).
 */
export function seedClaudeDirs(db: OrbitalDb, opts: { home?: string; now?: number } = {}): void {
  const home = opts.home ?? homedir();
  const any = db.select({ id: claudeDirs.id }).from(claudeDirs).limit(1).get();
  if (!any) {
    const stored = db.select({ value: settingsTable.value }).from(settingsTable)
      .where(eq(settingsTable.key, RETIRED_CLAUDE_DIRECTORY_KEY)).get()?.value;
    const resolved = resolveClaudeDir({ stored, home });
    db.insert(claudeDirs).values({
      id: FIRST_CLAUDE_DIR_ID,
      name: FIRST_CLAUDE_DIR_NAME,
      // A relative value never worked as a directory; it gives way to the default.
      path: isAbsolute(resolved) ? resolved : cliDefaultDir(home),
      createdAt: opts.now ?? Date.now(),
    }).run();
  }
  db.delete(settingsTable).where(eq(settingsTable.key, RETIRED_CLAUDE_DIRECTORY_KEY)).run();
}

/**
 * The configured Claude directories, and one running context per directory
 * (adr claude-directories-are-contexts-in-one-server). Adding a directory
 * starts its context at once; removing one stops it; changing a path is a
 * stop and a start. `startContext` is the server's: it builds the watcher,
 * the registry and the rest for one directory.
 */
export class ClaudeDirsService<C extends ClaudeDirContext = ClaudeDirContext> {
  private contexts = new Map<number, C>();
  private home: string;
  private probe: PathProbe;

  constructor(private deps: {
    db: OrbitalDb;
    settings: { get(key: string): string; set(key: string, value: string): void };
    /** Row 1's path at runtime: `buildServer({ claudeDir })`, else `ORBITAL_CLAUDE_DIR`. Blank is unset. */
    override?: string;
    startContext: (dir: ClaudeDir) => C;
    /** A directory was removed or moved, and these of its sessions are hidden now. */
    onHidden?: (sessionIds: string[]) => void;
    /** The process environment each directory's env is built from. */
    baseEnv?: NodeJS.ProcessEnv;
    home?: string;
    probe?: PathProbe;
  }) {
    this.home = deps.home ?? homedir();
    this.probe = deps.probe ?? fsPathProbe;
  }

  /** Every configured directory, by id. */
  list(): ClaudeDir[] {
    return this.deps.db.select().from(claudeDirs).orderBy(asc(claudeDirs.id)).all().map((row) => this.shape(row));
  }

  get(id: number): ClaudeDir | undefined {
    const row = this.deps.db.select().from(claudeDirs).where(eq(claudeDirs.id, id)).get();
    return row ? this.shape(row) : undefined;
  }

  has(id: number): boolean {
    return this.get(id) !== undefined;
  }

  /** `default_claude_dir` while it names a configured directory, else the first one. */
  defaultId(): number {
    const stored = Number(this.deps.settings.get(DEFAULT_CLAUDE_DIR_KEY));
    if (Number.isInteger(stored) && this.has(stored)) return stored;
    return this.list()[0]?.id ?? FIRST_CLAUDE_DIR_ID;
  }

  /**
   * A `claudeDirId` from a request: the default when absent, the id when it
   * is a configured directory, and null for anything else — the caller's 400.
   */
  resolveId(input: unknown): number | null {
    if (input === undefined || input === null || input === '') return this.defaultId();
    const id = typeof input === 'string' ? Number(input) : input;
    return typeof id === 'number' && Number.isInteger(id) && this.has(id) ? id : null;
  }

  /** The environment a CLI runs under for this directory (`claudeDirEnv`); undefined for an unknown id. */
  envFor(id: number): Record<string, string> | undefined {
    const dir = this.get(id);
    return dir ? claudeDirEnv(this.deps.baseEnv ?? process.env, dir.path, this.home) : undefined;
  }

  /** The running context of a directory, while it is configured. */
  context(id: number): C | undefined {
    return this.contexts.get(id);
  }

  /** The list `GET /api/claude-dirs` answers, with what is read off disk now. */
  info(): ClaudeDirInfo[] {
    const defaultId = this.defaultId();
    return this.list().map((dir) => ({
      ...dir,
      isDefault: dir.id === defaultId,
      exists: this.probe.isDirectory(dir.path) === true,
      account: readAccountEmail(dir.path, this.home),
    }));
  }

  /**
   * Starts every directory's context, the default one first: at boot the
   * first to index a session id owns it (adr
   * a-session-belongs-to-the-first-directory-that-indexed-it).
   */
  start(): void {
    const defaultId = this.defaultId();
    const dirs = this.list().sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
    for (const dir of dirs) this.startOne(dir);
  }

  close(): void {
    for (const context of this.contexts.values()) context.stop();
    this.contexts.clear();
  }

  add(input: { name?: unknown; path?: unknown }): ClaudeDirResult {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) return { ok: false, error: 'name_required' };
    const valid = validateClaudeDirPath(input.path, this.list().map((d) => d.path), { home: this.home, probe: this.probe });
    if (!valid.ok) return valid;
    const row = this.deps.db.insert(claudeDirs)
      .values({ name, path: valid.path, createdAt: Date.now() })
      .returning().get();
    const dir = this.shape(row);
    this.startOne(dir);
    return { ok: true, dir };
  }

  /**
   * A rename changes the label only. A new path is the directory removed and
   * added again under the same id: its context restarts on the new path, and
   * its sessions so far become unowned until a directory indexes them.
   */
  update(id: number, input: { name?: unknown; path?: unknown }): ClaudeDirResult {
    const current = this.get(id);
    if (!current) return { ok: false, error: 'not_found' };
    const patch: { name?: string; path?: string } = {};
    if (input.name !== undefined) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) return { ok: false, error: 'name_required' };
      patch.name = name;
    }
    let moved = false;
    if (input.path !== undefined) {
      const stored = this.storedPath(id);
      const others = this.list().filter((d) => d.id !== id).map((d) => d.path);
      const valid = validateClaudeDirPath(input.path, others, { home: this.home, probe: this.probe });
      if (!valid.ok) return valid;
      moved = valid.path !== stored;
      patch.path = valid.path;
    }
    if (Object.keys(patch).length > 0) {
      this.deps.db.update(claudeDirs).set(patch).where(eq(claudeDirs.id, id)).run();
    }
    if (moved) {
      this.stopOne(id);
      const hidden = this.sessionsOf(id);
      this.deps.db.update(sessions).set({ claudeDirId: UNOWNED_CLAUDE_DIR_ID })
        .where(eq(sessions.claudeDirId, id)).run();
      this.deps.onHidden?.(hidden);
      this.startOne(this.get(id)!);
    }
    return { ok: true, dir: this.get(id)! };
  }

  /**
   * Stops the directory's context and hides its sessions; their rows stay,
   * so adding the same path back brings them back. The last directory stays.
   */
  remove(id: number): { ok: true } | { ok: false; error: ClaudeDirError } {
    if (!this.has(id)) return { ok: false, error: 'not_found' };
    if (this.list().length <= 1) return { ok: false, error: 'last_directory' };
    const wasDefault = this.defaultId() === id;
    this.stopOne(id);
    this.deps.db.delete(claudeDirs).where(eq(claudeDirs.id, id)).run();
    if (wasDefault) this.deps.settings.set(DEFAULT_CLAUDE_DIR_KEY, String(this.defaultId()));
    this.deps.onHidden?.(this.sessionsOf(id));
    return { ok: true };
  }

  private sessionsOf(id: number): string[] {
    return this.deps.db.select({ id: sessions.id }).from(sessions).where(eq(sessions.claudeDirId, id)).all()
      .map((row) => row.id);
  }

  private startOne(dir: ClaudeDir): void {
    this.stopOne(dir.id);
    this.contexts.set(dir.id, this.deps.startContext(dir));
  }

  private stopOne(id: number): void {
    this.contexts.get(id)?.stop();
    this.contexts.delete(id);
  }

  private storedPath(id: number): string | undefined {
    return this.deps.db.select({ path: claudeDirs.path }).from(claudeDirs).where(eq(claudeDirs.id, id)).get()?.path;
  }

  private shape(row: { id: number; name: string; path: string }): ClaudeDir {
    const override = row.id === FIRST_CLAUDE_DIR_ID ? this.deps.override?.trim() : undefined;
    if (override) {
      return { id: row.id, name: row.name, path: resolveClaudeDir({ override, home: this.home }), overriddenByEnv: true };
    }
    return { id: row.id, name: row.name, path: row.path, overriddenByEnv: false };
  }
}
