import { existsSync, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';

/** How long a watch that failed waits before it is set up again. */
const REARM_DELAY_MS = 1000;

export interface DirWatch {
  close(): void;
}

export interface WatchDirOptions {
  /**
   * Watch the whole tree below `dir`. On macOS this is one FSEvents stream:
   * no file handle per file or per directory, however large the tree grows.
   */
  recursive?: boolean;
  /**
   * An event under `dir`, with the path relative to it — or null when the
   * platform did not say which entry changed. Events are raw: several per
   * write, possibly coalesced, and a name does not say whether the entry
   * still exists. Callers debounce and stat.
   */
  onEvent: (relativePath: string | null) => void;
  /**
   * `dir` did not exist when the watch started and has now appeared. Whatever
   * was written into it before the watch took over produced no event, so a
   * caller that cares scans it here.
   */
  onAppear?: () => void;
}

/**
 * A directory watch built on `fs.watch` alone (adr
 * `recursive-fs-watch-instead-of-chokidar`).
 *
 * Node watches a directory on macOS through FSEvents, which holds no file
 * descriptor for it, where a watched *file* costs a kqueue descriptor each.
 * So every watch in the server names a directory and filters by name, the
 * way `TranscriptTail` already does.
 *
 * A directory that does not exist yet is not an error: its nearest existing
 * ancestor is watched until it appears. A watch that errors (the directory
 * was removed, the stream failed) is set up again after `REARM_DELAY_MS`.
 */
export function watchDir(dir: string, opts: WatchDirOptions): DirWatch {
  let closed = false;
  let current: FSWatcher | null = null;
  let rearmTimer: ReturnType<typeof setTimeout> | null = null;
  let waited = false;

  const stop = () => {
    current?.close();
    current = null;
  };
  const rearmLater = () => {
    stop();
    if (closed || rearmTimer) return;
    rearmTimer = setTimeout(() => {
      rearmTimer = null;
      arm();
    }, REARM_DELAY_MS);
  };

  const arm = () => {
    if (closed) return;
    try {
      // Asked first, not left to `watch` to refuse: on Linux, Node 24's
      // recursive watch of a missing directory returns a watcher that never
      // fires instead of throwing ENOENT, and the wait below never starts.
      if (!existsSync(dir)) throw Object.assign(new Error(`no such directory: ${dir}`), { code: 'ENOENT' });
      current = watch(dir, { recursive: opts.recursive ?? false }, (_event, filename) => {
        // An event that names no entry can be about `dir` itself — removed,
        // which does not always surface as an error. Waiting for it to come
        // back beats watching a stream that will never fire again.
        if (!filename && !existsSync(dir)) {
          stop();
          arm();
          return;
        }
        opts.onEvent(filename ? String(filename) : null);
      });
      current.on('error', rearmLater);
      if (waited) {
        waited = false;
        opts.onAppear?.();
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        console.warn(`orbital: cannot watch ${dir}:`, err);
        rearmLater();
        return;
      }
    }
    // Not there yet. Watch the nearest ancestor that is, and look again
    // whenever it changes: that catches `dir` appearing, and an intermediate
    // directory appearing, which moves the ancestor one level closer.
    waited = true;
    const ancestor = nearestExisting(dir);
    try {
      current = watch(ancestor, () => {
        if (!existsSync(dir) && nearestExisting(dir) === ancestor) return;
        stop();
        arm();
      });
      current.on('error', rearmLater);
    } catch {
      rearmLater();
    }
  };

  arm();
  return {
    close() {
      closed = true;
      if (rearmTimer) clearTimeout(rearmTimer);
      stop();
    },
  };
}

/** The closest ancestor of `path` that exists, stopping at the root. */
function nearestExisting(path: string): string {
  let at = dirname(path);
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  return at;
}
