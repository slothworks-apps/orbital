import { mkdirSync, opendirSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { expandHome } from '../paths.js';

/**
 * What a typed project directory is on disk, for the New Session form's line
 * under its field (spec 2026-10-12-new-session-missing-directory-design).
 */
export type DirectoryState = 'directory' | 'missing' | 'not_a_directory' | 'not_absolute';

/**
 * Reads `raw` as `POST /api/sessions` will: `~` expanded, then a relative
 * path refused outright, because nothing downstream resolves it against a
 * directory the user chose.
 */
export function directoryState(raw: string, home?: string): { path: string; state: DirectoryState } {
  const path = expandHome(raw, home);
  if (!isAbsolute(path)) return { path, state: 'not_absolute' };
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return { path, state: 'missing' };
  return { path, state: stat.isDirectory() ? 'directory' : 'not_a_directory' };
}

export type CreateDirectoryResult =
  | { ok: true; path: string }
  | { ok: false; error: 'not_absolute' | 'not_a_directory' | 'not_permitted' };

/**
 * Creates `raw` and every missing parent. A directory already there is a
 * success: the form's question can be answered twice, or the folder made
 * meanwhile in Finder. A file anywhere on the way is not.
 */
export function createDirectory(raw: string, home?: string): CreateDirectoryResult {
  const path = expandHome(raw, home);
  if (!isAbsolute(path)) return { ok: false, error: 'not_absolute' };
  try {
    mkdirSync(path, { recursive: true });
    return { ok: true, path };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTDIR') return { ok: false, error: 'not_a_directory' };
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return { ok: false, error: 'not_permitted' };
    throw err;
  }
}

/** The most sub-directories `listDirs` answers with; past it, `truncated`. */
export const DIRS_MAX = 500;

export type DirListing = {
  path: string;
  dirs: { name: string; hasChildren: boolean }[];
  truncated: boolean;
};

export type ListDirsResult =
  | { ok: true; listing: DirListing }
  | { ok: false; error: 'not_absolute' | 'not_found' | 'unreadable' };

/**
 * One level of a device's folders, for the folder chooser that browses
 * another device (canvas 50g). Empty means home; `~` expands as in
 * `directoryState`; a relative path is refused for the same reason. Hidden
 * folders and files are left out.
 */
export function listDirs(raw: string | undefined, home: string = homedir()): ListDirsResult {
  const expanded = raw?.trim() ? expandHome(raw, home) : home;
  if (!isAbsolute(expanded)) return { ok: false, error: 'not_absolute' };
  const path = resolve(expanded);
  let entries: Dirent[];
  try {
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) return { ok: false, error: 'not_found' };
    entries = readdirSync(path, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'unreadable' };
    // A path `statSync` refuses outright (a NUL byte) names no folder either.
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ERR_INVALID_ARG_VALUE') return { ok: false, error: 'not_found' };
    throw err;
  }
  const names = entries
    .filter((e) => !e.name.startsWith('.') && isDirEntry(path, e))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return {
    ok: true,
    listing: {
      path,
      dirs: names.slice(0, DIRS_MAX).map((name) => ({ name, hasChildren: hasSubDir(join(path, name)) })),
      truncated: names.length > DIRS_MAX,
    },
  };
}

/**
 * A directory, or a symlink that points at one. An entry of no known type
 * (`DT_UNKNOWN`, on some network and FUSE filesystems) is asked of `statSync`.
 */
function isDirEntry(parent: string, e: Dirent): boolean {
  if (e.isDirectory()) return true;
  if (e.isFile()) return false;
  try {
    return statSync(join(parent, e.name), { throwIfNoEntry: false })?.isDirectory() ?? false;
  } catch {
    return false; // a loop, or a target this user cannot reach
  }
}

/** Whether `path` holds a non-hidden sub-directory; stops at the first. Unreadable is false. */
function hasSubDir(path: string): boolean {
  let dir;
  try {
    dir = opendirSync(path);
  } catch {
    return false;
  }
  try {
    for (let e = dir.readSync(); e !== null; e = dir.readSync()) {
      if (!e.name.startsWith('.') && isDirEntry(path, e)) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    dir.closeSync();
  }
}
