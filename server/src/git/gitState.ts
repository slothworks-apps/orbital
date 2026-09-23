import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Where a session's `cwd` sits in git right now (spec
 * 2026-09-22-git-location-indicator-design). Live state of a directory, not a
 * record of a session — see adr `git-location-is-ambient-not-recorded`.
 *
 * The three fields are facts, not the mark the panel draws: the browser picks
 * trunk, fork or tree from them, so the vocabulary can change on the canvas
 * without the wire moving.
 */
export interface GitLocation {
  /** Branch name, or the abbreviated sha when `detached`. */
  ref: string;
  /** HEAD points at a commit, not at a branch. */
  detached: boolean;
  /** The directory is a linked worktree, not the main working tree. */
  worktree: boolean;
  /**
   * `ref` is the repository's default branch. Always false for a worktree or
   * a detached HEAD: both draw a mark of their own, so the question does not
   * arise and answering it would cost a lookup nobody reads.
   */
  defaultBranch: boolean;
}

/** The directories a reading is made from, resolved once per working tree. */
export interface GitDirs {
  /** The working tree's root — the directory that holds `.git`. */
  root: string;
  /** This working tree's git dir, where its own `HEAD` lives. */
  gitDir: string;
  /**
   * The shared git dir holding `refs/` and `packed-refs`. Same as `gitDir`
   * for the main working tree; the repository's own for a linked worktree.
   */
  commonDir: string;
  /** `.git` was a file pointing elsewhere, which only a worktree's is. */
  worktree: boolean;
}

/** How many characters of a detached HEAD's object id the panel shows. */
const SHA_CHARS = 7;

/** Branch names tried, in order, when the repository has no `origin/HEAD`. */
const ASSUMED_DEFAULT_BRANCHES = ['main', 'master'];

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Walks up from `cwd` to the first directory holding a `.git`, and works out
 * which kind of working tree that makes it.
 *
 * A linked worktree's `.git` is a *file* reading `gitdir: <path>`, which is
 * the same signal `git rev-parse --git-dir` against `--git-common-dir` gives
 * (canvas `Feature - Git worktree` 1f) without spawning anything. The walk
 * needs no special case for a worktree living inside its own repository: from
 * `<repo>/.worktrees/tray` the first `.git` found is the worktree's file, not
 * the repository's directory further up.
 */
export function resolveGitDirs(cwd: string): GitDirs | null {
  let dir = resolve(cwd);
  for (;;) {
    const dotGit = join(dir, '.git');
    let kind: 'dir' | 'file' | null;
    try {
      kind = statSync(dotGit).isDirectory() ? 'dir' : 'file';
    } catch {
      kind = null;
    }

    if (kind === 'dir') {
      return { root: dir, gitDir: dotGit, commonDir: dotGit, worktree: false };
    }
    if (kind === 'file') {
      const gitDir = parseGitdirFile(readText(dotGit), dir);
      // A `.git` file we cannot follow is not a working tree we can report on.
      if (gitDir) return { root: dir, gitDir, commonDir: commonDirOf(gitDir), worktree: true };
      return null;
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `gitdir: <path>` — absolute as git writes it, relative if a human did. */
function parseGitdirFile(content: string | null, base: string): string | null {
  const match = content?.match(/^\s*gitdir:\s*(.+?)\s*$/m);
  if (!match) return null;
  const target = match[1];
  return isAbsolute(target) ? target : resolve(base, target);
}

/**
 * The shared git dir behind a worktree's own. Git writes a `commondir` file
 * beside `HEAD` holding the relative way back; the layout
 * `<common>/worktrees/<name>` is the fallback when it is missing.
 */
function commonDirOf(gitDir: string): string {
  const relative = readText(join(gitDir, 'commondir'))?.trim();
  if (relative) return isAbsolute(relative) ? relative : resolve(gitDir, relative);
  return dirname(dirname(gitDir));
}

/**
 * `HEAD` as the indicator reads it: a branch, or an abbreviated object id
 * when it points straight at a commit. Null for a `HEAD` in neither shape —
 * a half-written file during a checkout, say — which the panel treats the
 * same as no repository at all rather than guessing.
 */
export function parseHead(content: string | null): { ref: string; detached: boolean } | null {
  const line = content?.trim();
  if (!line) return null;
  const symbolic = line.match(/^ref:\s*(.+)$/);
  if (symbolic) {
    const ref = symbolic[1].trim().replace(/^refs\/heads\//, '');
    return ref ? { ref, detached: false } : null;
  }
  if (/^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(line)) {
    return { ref: line.slice(0, SHA_CHARS), detached: true };
  }
  return null;
}

/** `<sha> <refname>` per line; git packs refs here once there are enough. */
function readPackedRefs(commonDir: string): Map<string, string> {
  const refs = new Map<string, string>();
  const content = readText(join(commonDir, 'packed-refs'));
  if (!content) return refs;
  for (const line of content.split('\n')) {
    const match = line.match(/^([0-9a-f]+)\s+(\S+)$/i);
    if (match) refs.set(match[2], match[1]);
  }
  return refs;
}

/**
 * The repository's default branch — the one thing separating the trunk mark
 * from the fork mark (canvas 1e, M1).
 *
 * `origin/HEAD` is the only place git records it, and plenty of repositories
 * have no origin at all, so the last resort is a guess by name. A repository
 * with no remote whose trunk is called something else therefore draws a fork
 * where a trunk belongs; the mark still says "main checkout", which is the
 * distinction the indicator exists for (spec § The default branch).
 */
export function defaultBranchOf(commonDir: string): string | null {
  const symbolic = readText(join(commonDir, 'refs/remotes/origin/HEAD'))?.match(
    /^\s*ref:\s*refs\/remotes\/origin\/(.+?)\s*$/m,
  );
  if (symbolic) return symbolic[1];

  // Packed, where the symref survives only as a sha shared with the branch
  // it pointed at — so the name has to be recovered from that sha.
  const packed = readPackedRefs(commonDir);
  const headSha = packed.get('refs/remotes/origin/HEAD');
  if (headSha) {
    for (const [name, sha] of packed) {
      if (sha === headSha && name.startsWith('refs/remotes/origin/') && !name.endsWith('/HEAD')) {
        return name.slice('refs/remotes/origin/'.length);
      }
    }
  }

  for (const name of ASSUMED_DEFAULT_BRANCHES) {
    if (existsSync(join(commonDir, 'refs/heads', name)) || packed.has(`refs/heads/${name}`)) {
      return name;
    }
  }
  return null;
}

/** Where this working tree's `HEAD` lives — also the file to watch. */
export function headPathOf(dirs: GitDirs): string {
  return join(dirs.gitDir, 'HEAD');
}

/** The reading itself, from directories already resolved. */
export function readGitLocation(dirs: GitDirs): GitLocation | null {
  const head = parseHead(readText(headPathOf(dirs)));
  if (!head) return null;
  const defaultBranch =
    !dirs.worktree && !head.detached && head.ref === defaultBranchOf(dirs.commonDir);
  return { ref: head.ref, detached: head.detached, worktree: dirs.worktree, defaultBranch };
}

/** Resolve and read in one go — the uncached path `GitStore` is built on. */
export function locateGit(cwd: string): { dirs: GitDirs; location: GitLocation } | null {
  const dirs = resolveGitDirs(cwd);
  if (!dirs) return null;
  const location = readGitLocation(dirs);
  return location ? { dirs, location } : null;
}
