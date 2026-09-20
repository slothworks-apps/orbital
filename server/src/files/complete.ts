import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInsideCwd } from './preview.js';

/**
 * Path completion for the composer's `@` popup
 * (spec: 2026-09-20-composer-design § Path completion).
 *
 * The session's cwd is the sandbox, held by the same `resolveInsideCwd` the
 * file viewer's read uses. Anything outside it, or a directory that is not
 * there, answers an empty list rather than an error: a popup fed by keystrokes
 * asks about half-typed paths constantly, and half of them name nothing yet.
 */

/** Six rows are visible at a time; fifty is well past what anyone scrolls
 * through before typing another character, and it keeps one `readdir` of a
 * `node_modules` from becoming a megabyte of JSON. */
export const FILE_COMPLETE_MAX = 50;

export interface CompletionEntry {
  name: string;
  dir: boolean;
  /** Files only — a directory's size is a number about the inode, not about
   * what is in it, and the popup shows `DIR · N ITEMS` instead. */
  size?: number;
}

/**
 * Entries under the directory `prefix` names, whose own names start with what
 * `prefix` ends with.
 *
 * The split is the last separator: `src/comp` lists `src` for names beginning
 * `comp`, `src/` lists all of `src`, and a bare `comp` lists the project root.
 * Dotfiles appear only when the base itself starts with a dot — a directory
 * full of `.env`, `.git` and `.DS_Store` is not what someone typing `@` meant,
 * but `@.env` plainly is.
 */
export function completeFilePath(cwd: string, prefix: string): CompletionEntry[] {
  const cut = prefix.lastIndexOf('/');
  const dirPart = cut === -1 ? '' : prefix.slice(0, cut + 1);
  const base = cut === -1 ? prefix : prefix.slice(cut + 1);

  // '.' rather than '' so the root case resolves to cwd itself.
  const confined = resolveInsideCwd(cwd, dirPart || '.');
  if (confined.kind !== 'ok') return [];

  let names: string[];
  try {
    names = readdirSync(confined.path);
  } catch {
    // The prefix named a file, or something unreadable. Not an error — the
    // popup simply has nothing to offer.
    return [];
  }

  const wantDotfiles = base.startsWith('.');
  const entries: CompletionEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(base)) continue;
    if (!wantDotfiles && name.startsWith('.')) continue;
    let stat;
    try {
      stat = statSync(join(confined.path, name));
    } catch {
      // A broken symlink or a file deleted between readdir and stat.
      continue;
    }
    entries.push(
      stat.isDirectory() ? { name, dir: true } : { name, dir: false, size: stat.size },
    );
  }
  // Directories first, then alphabetical within each group — the same order
  // the popup draws, so the cap below takes the rows a person would have
  // scrolled to rather than an arbitrary slice of the readdir order.
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return entries.slice(0, FILE_COMPLETE_MAX);
}
