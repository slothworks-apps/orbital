import type { OpenTabs } from './complete.js';

/**
 * How long one reading of the editor's tab list is reused for.
 *
 * The `@` popup asks on every settled keystroke, and the composer's mention
 * probe asks again for every path already in the field, so a completion burst
 * is several requests inside a second — each of which would otherwise be a
 * round trip over the editor's socket. A tab list does not change inside a
 * window this short, and the cost of being one window behind is that a tab
 * opened a moment ago ranks normally for a moment longer (spec
 * 2026-09-23-ide-bridge-design § Open files, for `@` completion).
 */
export const IDE_OPEN_TABS_TTL_MS = 1_000;

/**
 * The part of `IdeStore` this reader needs, as a structural type rather than
 * the class: it keeps the completion route testable without an editor, and it
 * keeps `files/` from depending on `ide/`'s shape beyond these two answers.
 */
export interface OpenTabsSource {
  locate(cwd: string): { selection: { filePath: string; lineStart: number } | null } | null;
  openFiles(cwd: string): Promise<string[] | null>;
}

interface Cached {
  at: number;
  paths: readonly string[];
}

/**
 * The editor's open tabs for a `cwd`, cached for `IDE_OPEN_TABS_TTL_MS`.
 *
 * Every kind of "no editor" answers null and nothing else: no lock, a lock on
 * another project, a connection that never came up, an extension without the
 * tool, a socket that dropped mid-call. The ranking then falls back to the walk
 * of the working tree, which is what the composer did before the bridge existed
 * (spec § When there is no editor).
 *
 * The ACTIVE tab is never cached — it comes off the store's current selection,
 * which is already coalesced, and reading it is free.
 */
export class OpenTabsReader {
  private source: OpenTabsSource;
  private ttlMs: number;
  private now: () => number;
  private cache = new Map<string, Cached>();
  /** In-flight reads per `cwd`, so a burst of keystrokes makes one call. */
  private inFlight = new Map<string, Promise<readonly string[] | null>>();

  constructor(
    source: OpenTabsSource,
    opts: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.source = source;
    this.ttlMs = opts.ttlMs ?? IDE_OPEN_TABS_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  async read(cwd: string): Promise<OpenTabs | null> {
    let active: { filePath: string; lineStart: number } | null;
    try {
      active = this.source.locate(cwd)?.selection ?? null;
    } catch {
      // A store that threw is a store with no editor, as far as a popup goes.
      return null;
    }
    const activePath = active?.filePath ?? null;
    const activeLine = active?.lineStart ?? null;

    const paths = await this.paths(cwd);
    if (paths === null) return null;
    return { activePath, activeLine, paths };
  }

  private paths(cwd: string): Promise<readonly string[] | null> {
    const hit = this.cache.get(cwd);
    if (hit && this.now() - hit.at < this.ttlMs) return Promise.resolve(hit.paths);

    const pending = this.inFlight.get(cwd);
    if (pending) return pending;

    const read = this.source
      .openFiles(cwd)
      .then((paths) => {
        // A null is not cached: it usually means no editor, and the next
        // keystroke should find one the moment the editor connects.
        if (paths !== null) this.cache.set(cwd, { at: this.now(), paths });
        else this.cache.delete(cwd);
        return paths;
      })
      .catch(() => {
        this.cache.delete(cwd);
        return null;
      })
      .finally(() => {
        this.inFlight.delete(cwd);
      });

    this.inFlight.set(cwd, read);
    return read;
  }
}
