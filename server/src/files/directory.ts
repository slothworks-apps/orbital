import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
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
