import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { expandHome } from '../paths.js';

/**
 * The pure half of more than one Claude directory (spec
 * 2026-10-04-multiple-claude-directories-design): how a typed path becomes a
 * stored one, which environment a CLI is spawned with for a directory, and
 * where that directory's `.claude.json` lives. Nothing here touches the
 * database.
 */

/**
 * Row 1 of `claude_dirs`: seeded at boot, the one `ORBITAL_CLAUDE_DIR`
 * overrides, and what `sessions.claude_dir_id` defaults to.
 */
export const FIRST_CLAUDE_DIR_ID = 1;

/**
 * The `claude_dir_id` of a session whose directory changed its path: no
 * directory has this id, so the row is hidden until a directory indexes its
 * transcript and takes it over.
 */
export const UNOWNED_CLAUDE_DIR_ID = 0;

/** The variable the CLI reads its configuration directory from, at start-up only. */
export const CLAUDE_CONFIG_DIR = 'CLAUDE_CONFIG_DIR';

/** The directory the CLI uses when `CLAUDE_CONFIG_DIR` is unset. */
export function cliDefaultDir(home: string = homedir()): string {
  return join(home, '.claude');
}

/**
 * Whether `path` is the directory the CLI uses on its own. Compared as
 * strings, after `path.resolve`, and never through `realpath`: the CLI's
 * keychain item follows the variable's string, not the directory it names.
 */
export function isCliDefaultDir(path: string, home: string = homedir()): boolean {
  return resolve(path) === cliDefaultDir(home);
}

/**
 * A typed path as it is stored: `~` expanded, then `path.resolve`d — no
 * trailing slash, no `.` segments, and no symlink resolved. Null when it is
 * empty or not absolute; the CLI rejects a relative `CLAUDE_CONFIG_DIR`.
 */
export function normalizeClaudeDirPath(input: string, home: string = homedir()): string | null {
  const expanded = expandHome(input, home);
  if (expanded === '' || !isAbsolute(expanded)) return null;
  return resolve(expanded);
}

/**
 * The environment a CLI runs under for one directory (spec § 3 The
 * environment), built from `base` — the server's own — per spawn.
 *
 * The CLI's default directory gets NO `CLAUDE_CONFIG_DIR` at all. On macOS
 * the CLI keeps its login in a keychain item whose name carries a hash of
 * the variable's string once the variable is set, so setting it to the very
 * directory the CLI would use anyway names a different item, and the login
 * is gone. Every other directory gets the stored string exactly. A value the
 * server itself inherited never leaks through: it is always removed or
 * replaced.
 */
export function claudeDirEnv(
  base: NodeJS.ProcessEnv,
  dirPath: string,
  home: string = homedir(),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && key !== CLAUDE_CONFIG_DIR) env[key] = value;
  }
  if (!isCliDefaultDir(dirPath, home)) env[CLAUDE_CONFIG_DIR] = dirPath;
  return env;
}

/**
 * Where the CLI keeps its global config for one directory: inside it when
 * `CLAUDE_CONFIG_DIR` would be set for it, the home directory's otherwise —
 * the same rule `claudeDirEnv` applies to the variable.
 */
export function claudeJsonPathFor(dirPath: string, home: string = homedir()): string {
  return isCliDefaultDir(dirPath, home) ? join(home, '.claude.json') : join(dirPath, '.claude.json');
}

/**
 * The e-mail the directory's login belongs to, from `oauthAccount.emailAddress`
 * in its `.claude.json`. The file's format is undocumented, so every failure
 * — no file, no field, a half-written file — is null and never an error.
 */
export function readAccountEmail(
  dirPath: string,
  home: string = homedir(),
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): string | null {
  try {
    const parsed = JSON.parse(readFile(claudeJsonPathFor(dirPath, home))) as unknown;
    const account = (parsed as { oauthAccount?: unknown } | null)?.oauthAccount;
    const email = (account as { emailAddress?: unknown } | null | undefined)?.emailAddress;
    return typeof email === 'string' && email.trim() !== '' ? email : null;
  } catch {
    return null;
  }
}

/** Why a path cannot be a Claude directory — the code the routes answer with. */
export type ClaudeDirPathError =
  | 'path_required'
  | 'not_absolute'
  | 'no_such_directory'
  | 'not_a_directory'
  | 'duplicate';

/** The filesystem as `validateClaudeDirPath` sees it; injected by tests. */
export interface PathProbe {
  isDirectory(path: string): boolean | null;
  realpath(path: string): string;
}

export const fsPathProbe: PathProbe = {
  isDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? null,
  realpath: (path) => realpathSync(path),
};

/**
 * A typed path checked for use as a Claude directory: expanded, absolute,
 * existing, a directory, and not one of `others` — compared both as stored
 * and after `realpath`, so a symlinked spelling of a configured directory is
 * refused too. A directory without `projects/` is fine: a fresh
 * `CLAUDE_CONFIG_DIR` only gets one with its first session.
 */
export function validateClaudeDirPath(
  input: unknown,
  others: string[],
  opts: { home?: string; probe?: PathProbe } = {},
): { ok: true; path: string } | { ok: false; error: ClaudeDirPathError } {
  const probe = opts.probe ?? fsPathProbe;
  if (typeof input !== 'string' || input.trim() === '') return { ok: false, error: 'path_required' };
  const path = normalizeClaudeDirPath(input, opts.home);
  if (path === null) return { ok: false, error: 'not_absolute' };
  const isDir = probe.isDirectory(path);
  if (isDir === null) return { ok: false, error: 'no_such_directory' };
  if (!isDir) return { ok: false, error: 'not_a_directory' };
  const real = realOrSelf(probe, path);
  for (const other of others) {
    if (other === path || realOrSelf(probe, other) === real) return { ok: false, error: 'duplicate' };
  }
  return { ok: true, path };
}

/** A configured directory that has gone from disk still compares by its own spelling. */
function realOrSelf(probe: PathProbe, path: string): string {
  try {
    return probe.realpath(path);
  } catch {
    return path;
  }
}
