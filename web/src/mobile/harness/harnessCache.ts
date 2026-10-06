import { Preferences } from '@capacitor/preferences'
import { create } from 'zustand'
import type { HarnessEvent, SessionHarness } from '../../lib/types'
import { parseCached, type Cached } from '../platform/parse'

/**
 * Each session's harness and its log as last read live, kept with `asOf`
 * so the gate card and the steps sheet stay readable while the Mac sleeps
 * (spec 2026-10-05-mobile-next § 1). Stored as `harness:<id>` next to the
 * transcripts, under the same prefix, so forgetting the Mac drops it either way.
 */
export interface HarnessCacheValue {
  harness: SessionHarness | null
  removed: SessionHarness | null
  /** Newest first, as the store holds them. */
  events: HarnessEvent[]
}

// Under `platform/cache`'s `CACHE_PREFIX`, so `clearCaches` drops it too; spelled out rather than
// imported, so tests that stub that module still load this one. mobileharnesscache.test pins the match.
export const HARNESS_PREFIX = 'orbital.cache.harness:'
const harnessKey = (id: string): string => `${HARNESS_PREFIX}${id}`

const isObjectOrNull = (v: unknown): boolean => v === null || (typeof v === 'object' && !Array.isArray(v))

/** A stored value as the cache accepts it: both harnesses an object or null, the events a list. */
export function acceptHarness(value: unknown): HarnessCacheValue | null {
  if (!value || typeof value !== 'object') return null
  const { harness, removed, events } = value as Partial<Record<keyof HarnessCacheValue, unknown>>
  if (!isObjectOrNull(harness ?? null) || !isObjectOrNull(removed ?? null) || !Array.isArray(events)) return null
  const live = (harness ?? null) as SessionHarness | null
  if (live && (!Array.isArray(live.steps) || !Array.isArray(live.state))) return null
  return { harness: live, removed: (removed ?? null) as SessionHarness | null, events: events as HarnessEvent[] }
}

export async function readHarnessCache(id: string): Promise<Cached<HarnessCacheValue> | null> {
  const { value } = await Preferences.get({ key: harnessKey(id) })
  return parseCached(value, acceptHarness)
}

export function writeHarnessCache(id: string, value: HarnessCacheValue, asOf: number): Promise<void> {
  return Preferences.set({ key: harnessKey(id), value: JSON.stringify({ asOf, value }) })
}

/** Drops every cached harness; forgetting the Mac calls it. */
export async function clearHarnessCache(): Promise<void> {
  useHarnessCache.setState({ held: {} })
  const { keys } = await Preferences.keys()
  await Promise.all(keys.filter((key) => key.startsWith(HARNESS_PREFIX)).map((key) => Preferences.remove({ key })))
}

/**
 * The cached copies read so far this run, by session, for every reader of
 * one screen at once (the card, its key, the header, the rows).
 */
export const useHarnessCache = create<{ held: Record<string, Cached<HarnessCacheValue> | null> }>(() => ({ held: {} }))

const reading = new Set<string>()

/** Reads the session's cached copy into `useHarnessCache`, once per run. */
export async function loadHarnessCache(id: string): Promise<void> {
  if (id in useHarnessCache.getState().held || reading.has(id)) return
  reading.add(id)
  try {
    const cached = await readHarnessCache(id).catch(() => null)
    useHarnessCache.setState((s) => ({ held: { ...s.held, [id]: cached } }))
  } finally {
    reading.delete(id)
  }
}

/** Keeps a live read, both on disk and as this run's copy. */
export function keepHarness(id: string, value: HarnessCacheValue, asOf: number): void {
  useHarnessCache.setState((s) => ({ held: { ...s.held, [id]: { asOf, value } } }))
  void writeHarnessCache(id, value, asOf).catch(() => {
    // The cache is a convenience; the live copy is on screen.
  })
}
