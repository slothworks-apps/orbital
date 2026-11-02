import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gitTreeRoot, namedAmongInTranscript } from './preview.js';

/**
 * Where a bare file name a transcript wrote (`` `findAll.ts` ``) lies, looked
 * up when it is pressed (spec 2026-11-02-bare-file-names-and-path-menu-design
 * § The server: `GET /api/files/find`).
 *
 * Only inside the sandboxes every file route reads through, never past them:
 * a wider search would find files the viewer then refuses. The first sandbox
 * with a match answers, the rule `readInSandboxes` applies to a read, and
 * every match is confined the way `resolveForSession` confines a path.
 */

const run = promisify(execFile);

/** The most matches one answer lists; the rest are only counted, in `more`. */
export const FIND_LIST_MAX = 100;

/** How long one sandbox's listing is reused, so a press, a pick and a right-click list it once. */
export const FIND_LISTING_TTL_MS = 10_000;

/** How long `git ls-files` may take before the tree is walked instead. */
export const FIND_GIT_TIMEOUT_MS = 5_000;

/** Past this many files, a walk outside git stops: what it has found by then is the listing. */
export const FIND_WALK_MAX_FILES = 50_000;

/** The `git ls-files` output a large repository can produce, with room to spare. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Config that can run a command, switched off: the directory is one a client
 * sent, and its tree may be one the session only recorded, whose
 * `.git/config` nobody here vetted. `core.fsmonitor` names a program git
 * runs on an index refresh; hooks do not run for `ls-files`, but are off all
 * the same.
 */
const GIT_SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

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
  /** The session's transcripts name its absolute path (`namedInTranscript`). */
  touched: boolean;
}

export interface FindResult {
  matches: FoundFile[];
  /** How many matches past `FIND_LIST_MAX` were left out. */
  more: number;
}

/** Every file under `dir`, relative to it with `/` separators. */
export type DirLister = (dir: string) => Promise<string[]>;

/**
 * What went wrong while listing `dir`: `git` failed or timed out and the walk
 * stood in, or the lister itself rejected and the directory listed nothing.
 */
export type ListingFailure = (dir: string, during: 'git' | 'list', err: unknown) => void;

/**
 * The files under a directory: `git ls-files` in a git tree (tracked files and
 * untracked ones not ignored, so `node_modules` and build output stay out),
 * else a capped walk. A git that is missing, fails or times out falls back to
 * the walk, and is reported to `onFailure`. A directory that cannot be read
 * lists nothing.
 */
export async function listFiles(dir: string, onFailure?: ListingFailure): Promise<string[]> {
  if (gitTreeRoot(dir) !== null) {
    try {
      const { stdout } = await run(
        'git', [...GIT_SAFE_CONFIG, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        {
          cwd: dir,
          // A read beside an agent that may be committing must never take the index lock from under it.
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
          timeout: FIND_GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
          encoding: 'utf8',
        },
      );
      // `--cached` and `--others` never overlap, but a conflicted file is listed once per stage.
      return [...new Set(stdout.split('\0').filter((line) => line !== ''))];
    } catch (err) {
      onFailure?.(dir, 'git', err);
    }
  }
  return walkFiles(dir);
}

/**
 * The walk `listFiles` falls back to: symlinked directories are not entered,
 * heavy ones are skipped. Each directory is its own read, so a large tree
 * does not hold the server up while it is walked.
 */
export async function walkFiles(dir: string, max: number = FIND_WALK_MAX_FILES): Promise<string[]> {
  const out: string[] = [];
  const pending = [''];
  while (pending.length > 0 && out.length < max) {
    const rel = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(rel === '' ? dir : join(dir, rel), { withFileTypes: true });
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

export interface ListingCacheOptions {
  /** How a directory is listed; `listFiles` reporting to `onFailure` without one. */
  list?: DirLister;
  ttlMs?: number;
  onFailure?: ListingFailure;
}

/**
 * Listings by directory, each kept for `ttlMs` from when it was asked and
 * dropped when that ends. A lister that rejects is reported and lists
 * nothing, and nothing is kept: the next lookup lists again.
 */
export class ListingCache {
  private entries = new Map<string, Promise<string[]>>();
  private readonly list: DirLister;
  private readonly ttlMs: number;
  private readonly onFailure: ListingFailure | undefined;

  constructor(opts: ListingCacheOptions = {}) {
    this.onFailure = opts.onFailure;
    this.list = opts.list ?? ((dir) => listFiles(dir, this.onFailure));
    this.ttlMs = opts.ttlMs ?? FIND_LISTING_TTL_MS;
  }

  /** Whether `dir`'s listing is held from an earlier lookup. */
  has(dir: string): boolean {
    return this.entries.has(dir);
  }

  /** Drops `dir`'s listing, so the next ask lists it afresh. */
  forget(dir: string): void {
    this.entries.delete(dir);
  }

  files(dir: string): Promise<string[]> {
    const hit = this.entries.get(dir);
    if (hit) return hit;
    const files: Promise<string[]> = this.list(dir).catch((err: unknown) => {
      if (this.entries.get(dir) === files) this.entries.delete(dir);
      this.onFailure?.(dir, 'list', err);
      return [];
    });
    this.entries.set(dir, files);
    const expiry = setTimeout(() => {
      if (this.entries.get(dir) === files) this.entries.delete(dir);
    }, this.ttlMs);
    expiry.unref?.();
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

/** A candidate's real path and whether it is a file, or null when it names nothing. */
async function realFile(path: string): Promise<{ real: string; file: boolean } | null> {
  try {
    const real = await realpath(path);
    return { real, file: (await stat(real)).isFile() };
  } catch {
    return null;
  }
}

/**
 * The files called `name` in the first sandbox that has one, touched ones
 * first, then by path, shortest first, then alphabetically. `name` must be a
 * bare name already (`isBareFileName`); the caller checks. A sandbox that is
 * the user's home directory is never listed.
 *
 * `transcripts` are the session's transcript files. They are read once per
 * sandbox searched, for every candidate together (`namedAmongInTranscript`):
 * that one pass says which matches are touched, and which matches that are
 * symlinks out of the sandbox are kept — those the transcripts name, as
 * `resolveForSession` keeps them.
 *
 * A sandbox whose listing was held from an earlier lookup may predate a file
 * the agent has just written. So when no sandbox has a match and some answered
 * from a held listing, those are listed afresh and the search runs once more.
 */
export async function findByName(
  sandboxes: string[], name: string, transcripts: () => string[], listings: ListingCache,
  home: string = homedir(), max: number = FIND_LIST_MAX,
): Promise<FindResult> {
  const realHome = realOrResolved(home);
  const searched = sandboxes.filter((sandbox) => sandbox && realOrResolved(sandbox) !== realHome);
  const held = searched.filter((sandbox) => listings.has(sandbox));
  const first = await findInFirst(searched, name, transcripts, listings, max);
  if (first.matches.length > 0 || held.length === 0) return first;
  for (const sandbox of held) listings.forget(sandbox);
  return findInFirst(searched, name, transcripts, listings, max);
}

async function findInFirst(
  sandboxes: string[], name: string, transcripts: () => string[], listings: ListingCache, max: number,
): Promise<FindResult> {
  for (const sandbox of sandboxes) {
    const found = await findIn(sandbox, name, transcripts, listings);
    if (found.length === 0) continue;
    found.sort((a, b) => Number(b.touched) - Number(a.touched) || byPath(a.relative, b.relative));
    return { matches: found.slice(0, max), more: Math.max(0, found.length - max) };
  }
  return { matches: [], more: 0 };
}

/** Every file called `name` in one sandbox, confined to it and marked touched. */
async function findIn(
  sandbox: string, name: string, transcripts: () => string[], listings: ListingCache,
): Promise<FoundFile[]> {
  const relatives = (await listings.files(sandbox)).filter((rel) => rel === name || rel.endsWith(`/${name}`));
  if (relatives.length === 0) return [];
  let realSandbox: string;
  try {
    realSandbox = await realpath(sandbox);
  } catch {
    // A sandbox that itself is gone confines nothing.
    return [];
  }
  const candidates = await Promise.all(relatives.map(async (relative) => {
    const path = join(sandbox, relative);
    const real = await realFile(path);
    if (!real?.file) return null;
    // The separator matters: without it, `/w/x-evil` would pass for `/w/x`.
    const inside = real.real.startsWith(realSandbox + sep);
    return { path, relative, inside };
  }));
  const files = candidates.filter((c): c is NonNullable<typeof c> => c !== null);
  if (files.length === 0) return [];
  const named = await namedAmongInTranscript(transcripts(), files.map((f) => f.path));
  return files
    .filter((f) => f.inside || named.has(f.path))
    .map(({ path, relative }) => ({ path, relative, touched: named.has(path) }));
}

/** Shortest first, then alphabetically. */
function byPath(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
