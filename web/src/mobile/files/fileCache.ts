import { FILE_CACHE_MAX_BYTES } from '../constants'
import { cacheDirIO } from '../platform/cacheDir'

/**
 * The phone's one bounded cache of what it has shown (spec
 * 2026-10-05-mobile-next § 2, Cache): transcript images by ref, image files
 * and text previews by session and path. At most `FILE_CACHE_MAX_BYTES` in
 * total; past it the least recently opened entries go first.
 *
 * A ref entry never goes stale — its name is its content hash. A path entry
 * can: the file on disk may change under the same path, so the resolver
 * (`fileResolver.ts`) reads it again whenever the Mac is there and keeps the
 * entry for when it is not, with `readAt` as its age.
 *
 * The index is one JSON file beside the entries; the bytes are files named by
 * a counter. Every operation runs in turn, so a read never sees half a write.
 */

export interface CacheEntry {
  key: string
  /** The entry's file in the cache directory: a counter, never anything a transcript wrote. */
  name: string
  bytes: number
  /** When it was last shown — the eviction order. */
  lastOpened: number
  /** When the bytes came from the Mac — the "as of" of an entry shown while it sleeps. */
  readAt: number
  w: number | null
  h: number | null
  mediaType: string | null
}

export type EntryMeta = Pick<CacheEntry, 'w' | 'h' | 'mediaType'>

/** What the cache needs from a disk; `platform/cacheDir.ts` is the phone's. */
export interface CacheIO {
  readIndex(): Promise<string | null>
  writeIndex(json: string): Promise<void>
  read(name: string): Promise<Uint8Array | null>
  write(name: string, bytes: Uint8Array): Promise<void>
  remove(name: string): Promise<void>
  /** Every entry, the index, and the unbounded ref cache this one replaced. */
  wipe(): Promise<void>
}

export function refKey(ref: string): string {
  return `ref:${ref}`
}

export function pathKey(sessionId: string, path: string): string {
  return `path:${sessionId}:${path}`
}

/**
 * The entries to drop so the rest fit `max`: least recently opened first.
 * `keep` (the entry just written) goes last of all — and goes too only when
 * it alone is larger than the whole cache.
 */
export function evictionVictims(entries: readonly CacheEntry[], max: number, keep?: string): CacheEntry[] {
  let total = entries.reduce((sum, e) => sum + e.bytes, 0)
  if (total <= max) return []
  const order = [...entries].sort((a, b) => {
    if (a.key === keep) return 1
    if (b.key === keep) return -1
    return a.lastOpened - b.lastOpened
  })
  const victims: CacheEntry[] = []
  for (const entry of order) {
    if (total <= max) break
    victims.push(entry)
    total -= entry.bytes
  }
  return victims
}

interface Index {
  next: number
  entries: CacheEntry[]
}

function parseIndex(json: string | null): Index | null {
  if (!json) return null
  try {
    const raw = JSON.parse(json) as Partial<Index>
    if (typeof raw.next !== 'number' || !Array.isArray(raw.entries)) return null
    return { next: raw.next, entries: raw.entries }
  } catch {
    return null
  }
}

export class FileCache {
  private index: Index | null = null
  private queue: Promise<unknown> = Promise.resolve()

  private readonly io: CacheIO
  private readonly max: number
  private readonly now: () => number

  constructor(io: CacheIO, max = FILE_CACHE_MAX_BYTES, now: () => number = Date.now) {
    this.io = io
    this.max = max
    this.now = now
  }

  /** The bytes and the entry, marking it opened now; null when absent or its file is gone. */
  get(key: string): Promise<{ bytes: Uint8Array; entry: CacheEntry } | null> {
    return this.run(async (index) => {
      const entry = index.entries.find((e) => e.key === key)
      if (!entry) return null
      const bytes = await this.io.read(entry.name).catch(() => null)
      if (!bytes) {
        index.entries = index.entries.filter((e) => e !== entry)
        await this.save(index)
        return null
      }
      entry.lastOpened = this.now()
      await this.save(index)
      return { bytes, entry: { ...entry } }
    })
  }

  /** The entry alone, untouched — what the phone last knew of a file, e.g. its w×h. */
  peek(key: string): Promise<CacheEntry | null> {
    return this.run((index) => {
      const entry = index.entries.find((e) => e.key === key)
      return Promise.resolve(entry ? { ...entry } : null)
    })
  }

  /** Stores the bytes as read now, replacing what the key held, then trims to the bound. */
  put(key: string, bytes: Uint8Array, meta: EntryMeta): Promise<void> {
    return this.run(async (index) => {
      const at = this.now()
      const existing = index.entries.find((e) => e.key === key)
      const name = existing?.name ?? String(index.next++)
      await this.io.write(name, bytes)
      const entry: CacheEntry = { key, name, bytes: bytes.length, lastOpened: at, readAt: at, ...meta }
      index.entries = [...index.entries.filter((e) => e.key !== key), entry]
      const victims = evictionVictims(index.entries, this.max, key)
      if (victims.length > 0) {
        const gone = new Set(victims)
        index.entries = index.entries.filter((e) => !gone.has(e))
        await Promise.all(victims.map((v) => this.io.remove(v.name).catch(() => undefined)))
      }
      await this.save(index)
    })
  }

  /** Everything goes — forgetting the Mac calls it. */
  clear(): Promise<void> {
    return this.run(async (index) => {
      index.entries = []
      index.next = 0
      await this.io.wipe()
    })
  }

  private run<T>(op: (index: Index) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => op(await this.load()))
    // One failed operation must not stall the ones queued behind it.
    this.queue = next.catch(() => undefined)
    return next
  }

  private async load(): Promise<Index> {
    if (this.index) return this.index
    const read = parseIndex(await this.io.readIndex().catch(() => null))
    if (!read) {
      // No index — a first run, or the unbounded cache this replaced: what
      // is on disk is not accounted for, so it goes.
      await this.io.wipe().catch(() => undefined)
    }
    this.index = read ?? { next: 0, entries: [] }
    return this.index
  }

  private async save(index: Index): Promise<void> {
    await this.io.writeIndex(JSON.stringify(index)).catch(() => undefined)
  }
}

/** The phone's cache, in its Cache directory. */
export const fileCache = new FileCache(cacheDirIO)

/** Drops everything the cache holds; forgetting the Mac calls it. */
export async function clearFileCache(): Promise<void> {
  await fileCache.clear()
}
