import { execFile } from 'node:child_process';
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { gitTreeRoot, resolveForSession, type NamedCheck } from './preview.js';

/**
 * Where a bare file name a transcript wrote (`` `findAll.ts` ``) lies, looked
 * up when it is pressed (spec 2026-11-02-bare-file-names-and-path-menu-design
 * § The server: `GET /api/files/find`).
 *
 * Only inside the sandboxes every file route reads through, never past them:
 * a wider search would find files the viewer then refuses. The first sandbox
 * with a match answers, the rule `readInSandboxes` applies to a read, and
 * every match is confined by `resolveForSession` like any other path.
 */

const run = promisify(execFile);

/** The most matches one answer lists; the rest are only counted, in `more` (canvas 1c). */
export const FIND_BY_NAME_MAX = 6;

/** How long one sandbox's listing is reused, so a press, a pick and a right-click list it once. */
export const FIND_LISTING_TTL_MS = 10_000;

/** How long `git ls-files` may take before the tree is walked instead. */
export const FIND_GIT_TIMEOUT_MS = 5_000;

/** Past this many files, a walk outside git stops: what it has found by then is the listing. */
export const FIND_WALK_MAX_FILES = 50_000;

/**
 * How many matches are asked whether the session named them, shortest path
 * first. Each ask can scan the session's transcripts, so a name with hundreds
 * of copies (`index.ts` in a monorepo) does not cost hundreds of scans; a
 * match past it counts as untouched.
 */
export const FIND_TOUCHED_CHECKS = 50;

/** The `git ls-files` output a large repository can produce, with room to spare. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Directories a walk outside git does not enter: dependencies, VCS data and build output. */
const SKIPPED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.turbo', '.cache', '.gradle', '.venv', 'venv', '__pycache__', 'Pods', 'DerivedData',
]);

export interface FoundFile {
  /** Absolute, as the sandbox spells it. */
  path: string;
  /** Relative to the sandbox directory it was found in. */
  relative: string;
  /** The session's transcripts name its absolute path (`namedBy`). */
  touched: boolean;
}

export interface FindResult {
  matches: FoundFile[];
  /** How many matches past `FIND_BY_NAME_MAX` were left out. */
  more: number;
}

/** Every file under `dir`, relative to it with `/` separators. */
export type DirLister = (dir: string) => Promise<string[]>;

/**
 * The files under a directory: `git ls-files` in a git tree (tracked files and
 * untracked ones not ignored, so `node_modules` and build output stay out),
 * else a capped walk. A git that is missing, fails or times out falls back to
 * the walk. A directory that cannot be read lists nothing.
 */
export async function listFiles(dir: string): Promise<string[]> {
  if (gitTreeRoot(dir) !== null) {
    try {
      const { stdout } = await run(
        'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { cwd: dir, timeout: FIND_GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      );
      // `--cached` and `--others` never overlap, but a conflicted file is listed once per stage.
      return [...new Set(stdout.split('\0').filter((line) => line !== ''))];
    } catch {
      // Fall through to the walk.
    }
  }
  return walkFiles(dir);
}

/** The walk `listFiles` falls back to: symlinked directories are not entered, heavy ones are skipped. */
export function walkFiles(dir: string, max: number = FIND_WALK_MAX_FILES): string[] {
  const out: string[] = [];
  const pending = [''];
  while (pending.length > 0 && out.length < max) {
    const rel = pending.pop() as string;
    let entries;
    try {
      entries = readdirSync(rel === '' ? dir : join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) pending.push(child);
      } else {
        out.push(child);
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

/** Listings by directory, each kept for `ttlMs` from when it was asked. */
export class ListingCache {
  private entries = new Map<string, { at: number; files: Promise<string[]> }>();

  constructor(
    private readonly list: DirLister = listFiles,
    private readonly ttlMs: number = FIND_LISTING_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  files(dir: string): Promise<string[]> {
    const at = this.now();
    for (const [key, entry] of this.entries) if (at - entry.at >= this.ttlMs) this.entries.delete(key);
    const hit = this.entries.get(dir);
    if (hit) return hit.files;
    const files = this.list(dir).catch(() => [] as string[]);
    this.entries.set(dir, { at, files });
    return files;
  }
}

/** A directory's real path, or its resolved spelling when it is not there. */
function realOrResolved(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The files called `name` in the first sandbox that has one, touched ones
 * first, then by path, shortest first, then alphabetically. `name` must be a
 * bare name already (`isBareFileName`); the caller checks. A sandbox that is
 * the user's home directory is never listed.
 */
export async function findByName(
  sandboxes: string[], name: string, named: NamedCheck, listings: ListingCache,
  home: string = homedir(), max: number = FIND_BY_NAME_MAX,
): Promise<FindResult> {
  const realHome = realOrResolved(home);
  for (const sandbox of sandboxes) {
    if (!sandbox || realOrResolved(sandbox) === realHome) continue;
    const candidates = (await listings.files(sandbox))
      .filter((rel) => rel === name || rel.endsWith(`/${name}`))
      .sort(byPath);
    const found: FoundFile[] = [];
    for (const relative of candidates) {
      const path = join(sandbox, relative);
      const confined = resolveForSession(sandbox, path, named);
      if (confined.kind !== 'ok' || !isFile(confined.path)) continue;
      found.push({ path, relative, touched: found.length < FIND_TOUCHED_CHECKS && named(path) });
    }
    if (found.length === 0) continue;
    found.sort((a, b) => Number(b.touched) - Number(a.touched) || byPath(a.relative, b.relative));
    return { matches: found.slice(0, max), more: Math.max(0, found.length - max) };
  }
  return { matches: [], more: 0 };
}

/** Shortest first, then alphabetically. */
function byPath(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
