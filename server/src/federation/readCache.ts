/**
 * What a member last answered to a read of one of its sessions, so the
 * session stays readable while the member is offline (spec
 * 2026-10-16-device-group-design § 7, canvas 50f). In memory only: a
 * restart forgets it, and the member's snapshot keeps just the list.
 */

/** All kept answers together; the least recently used go first. */
export const READ_CACHE_MAX_BYTES = 32 * 1024 * 1024;
/** An answer bigger than this is not kept: it would push out too many others. */
export const READ_CACHE_ENTRY_MAX_BYTES = 4 * 1024 * 1024;

type Entry = { memberId: string; sessionId: string; json: string; bytes: number; at: number };

export type KeptAnswer = { body: unknown; at: number };

export class ReadCache {
  /** By `memberId` and url; a Map keeps insertion order, so the first is the least recently used. */
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(
    private readonly maxBytes = READ_CACHE_MAX_BYTES,
    private readonly entryMaxBytes = READ_CACHE_ENTRY_MAX_BYTES,
  ) {}

  /** Keeps `body`, the member's 200 to `url`, as of `at`. Kept as JSON: the bound is on its bytes, and nobody can change it. */
  put(memberId: string, sessionId: string, url: string, body: unknown, at: number): void {
    const key = keyOf(memberId, url);
    this.delete(key);
    const json = JSON.stringify(body ?? null);
    const bytes = Buffer.byteLength(json);
    if (bytes > this.entryMaxBytes) return;
    this.entries.set(key, { memberId, sessionId, json, bytes, at });
    this.bytes += bytes;
    for (const [oldest] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.delete(oldest);
    }
  }

  get(memberId: string, url: string): KeptAnswer | null {
    const key = keyOf(memberId, url);
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Used now: to the back of the line.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { body: JSON.parse(entry.json), at: entry.at };
  }

  dropSession(memberId: string, sessionId: string): void {
    for (const [key, e] of this.entries) if (e.memberId === memberId && e.sessionId === sessionId) this.delete(key);
  }

  dropMember(memberId: string): void {
    for (const [key, e] of this.entries) if (e.memberId === memberId) this.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  /** What every kept answer takes together. */
  size(): number {
    return this.bytes;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }
}

function keyOf(memberId: string, url: string): string {
  return `${memberId}\n${url}`;
}
