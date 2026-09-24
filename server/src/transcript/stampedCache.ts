import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A small LRU of values derived from files, each held under a stamp of the
 * files it was built from.
 *
 * Built for transcripts, which the CLI only ever appends to: a transcript
 * whose size and mtime have not moved has not changed, so what was parsed
 * out of it last time is still the answer. Paging back through a large
 * session used to parse the whole file once per page (audit
 * resource-usage-pass-2026-09-24, finding 5).
 *
 * Bounded by count, not by bytes, and the count has to stay small: the
 * parsed form of one large transcript is several times the file's size.
 *
 * Values are shared between callers, so nothing may mutate what `get`
 * returns.
 */
export class StampedCache<V> {
  private entries = new Map<string, { stamp: string; value: V }>();

  constructor(private readonly max: number) {}

  /** The value for `key` built at `stamp`, building it when there is none. */
  get(key: string, stamp: string, build: () => V): V {
    const hit = this.entries.get(key);
    if (hit) {
      // Re-inserted either way, so the Map's order stays most-recent-last.
      this.entries.delete(key);
      if (hit.stamp === stamp) {
        this.entries.set(key, hit);
        return hit.value;
      }
    }
    const value = build();
    this.entries.set(key, { stamp, value });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return value;
  }
}

/** A file's size and mtime as a stamp, or null when it cannot be stat'ed. */
export function fileStamp(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * The stamps of every file in a directory, as one stamp — empty when the
 * directory does not exist. A file added, removed or appended to changes it.
 */
export function dirStamp(dir: string): string {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return '';
  }
  return names.map((name) => `${name}=${fileStamp(join(dir, name)) ?? '-'}`).join('|');
}
