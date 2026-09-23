import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import { headPathOf, locateGit, readGitLocation, type GitDirs, type GitLocation } from './gitState.js';

/**
 * One working tree's cached reading, plus the file that invalidates it.
 * Keyed by the working tree's root, not by session: git state belongs to a
 * directory, and several sessions can share one (spec
 * 2026-09-22-git-location-indicator-design § Where the value comes from).
 */
interface Entry {
  dirs: GitDirs;
  location: GitLocation | null;
  watcher: FSWatcher | null;
}

/**
 * The server's git readings: resolve a `cwd` once, cache by working tree,
 * and let a watch on that tree's `HEAD` invalidate it.
 *
 * Emits `change` with a working tree root when its `HEAD` moved, which
 * `index.ts` turns back into the sessions to republish. A resolution that
 * found no repository is cached too — the walk up the filesystem is the
 * expensive half, and repeating it for every shaped session is exactly what
 * the cache is for.
 */
export class GitStore extends EventEmitter {
  private byRoot = new Map<string, Entry>();
  /** `cwd` → working tree root, or null for "walked up, found nothing". */
  private rootByCwd = new Map<string, string | null>();
  /** The reverse index, so a `HEAD` change can name the sessions it touches. */
  private cwdsByRoot = new Map<string, Set<string>>();
  private watch: boolean;

  constructor(opts: { watch?: boolean } = {}) {
    super();
    this.watch = opts.watch ?? true;
  }

  /** Where this directory sits in git, or null when it is not in a repository. */
  locate(cwd: string): GitLocation | null {
    const known = this.rootByCwd.get(cwd);
    if (known !== undefined) {
      return known === null ? null : (this.entry(known)?.location ?? null);
    }

    const found = locateGit(cwd);
    if (!found) {
      this.rootByCwd.set(cwd, null);
      return null;
    }

    const root = found.dirs.root;
    this.rootByCwd.set(cwd, root);
    let cwds = this.cwdsByRoot.get(root);
    if (!cwds) this.cwdsByRoot.set(root, (cwds = new Set()));
    cwds.add(cwd);

    const existing = this.byRoot.get(root);
    if (existing) return existing.location;
    const entry: Entry = { dirs: found.dirs, location: found.location, watcher: null };
    this.byRoot.set(root, entry);
    entry.watcher = this.startWatch(root, found.dirs);
    return entry.location;
  }

  /** The `cwd`s that resolved to this working tree — its sessions' addresses. */
  cwdsFor(root: string): string[] {
    return [...(this.cwdsByRoot.get(root) ?? [])];
  }

  /** Re-reads `HEAD` for one working tree. Used by the watch, and by tests. */
  refresh(root: string): void {
    const entry = this.byRoot.get(root);
    if (!entry) return;
    entry.location = readGitLocation(entry.dirs);
  }

  close(): void {
    for (const entry of this.byRoot.values()) void entry.watcher?.close();
    this.byRoot.clear();
    this.rootByCwd.clear();
    this.cwdsByRoot.clear();
  }

  private entry(root: string): Entry | undefined {
    return this.byRoot.get(root);
  }

  /**
   * A branch switch rewrites `HEAD`, so `HEAD` is the whole watch. Losing it
   * means the worktree was removed or the repository deleted: the entry is
   * dropped rather than refreshed, and the next `locate` resolves from
   * scratch — which is how a removed worktree stops reporting a branch.
   */
  private startWatch(root: string, dirs: GitDirs): FSWatcher | null {
    if (!this.watch) return null;
    const watcher = chokidar.watch(headPathOf(dirs), { ignoreInitial: true });
    watcher.on('all', (event) => this.applyHeadEvent(root, event === 'unlink' ? 'unlink' : 'change'));
    return watcher;
  }

  /**
   * What a `HEAD` event does to the cache, separated from the watch that
   * normally raises it so it can be driven directly.
   */
  applyHeadEvent(root: string, event: 'change' | 'unlink'): void {
    // Captured before `forget`, which drops the index the listener would
    // otherwise read — the sessions still need republishing when the working
    // tree they sat in is the thing that disappeared.
    const cwds = this.cwdsFor(root);
    if (event === 'unlink') this.forget(root);
    else this.refresh(root);
    this.emit('change', root, cwds);
  }

  private forget(root: string): void {
    const entry = this.byRoot.get(root);
    if (entry) void entry.watcher?.close();
    this.byRoot.delete(root);
    for (const cwd of this.cwdsByRoot.get(root) ?? []) this.rootByCwd.delete(cwd);
    this.cwdsByRoot.delete(root);
  }
}
