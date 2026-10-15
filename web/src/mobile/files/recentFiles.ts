import { RECENT_FILES_MAX } from '../constants'
import type { ReadyOutcome } from './fileResolver'

/**
 * The last few files the screen showed, held in memory by `useFile`'s key,
 * so a page swiped back to is there on the first paint. Least recently shown
 * goes first. Cleared with the pairing, like the cache on disk.
 */
const recent = new Map<string, ReadyOutcome>()

export function recentFile(key: string): ReadyOutcome | null {
  const hit = recent.get(key)
  if (!hit) return null
  // A Map iterates in insertion order, so re-inserting on a hit keeps the oldest first.
  recent.delete(key)
  recent.set(key, hit)
  return hit
}

export function rememberFile(key: string, outcome: ReadyOutcome, max = RECENT_FILES_MAX): void {
  recent.delete(key)
  recent.set(key, outcome)
  while (recent.size > max) recent.delete(recent.keys().next().value as string)
}

export function clearRecentFiles(): void {
  recent.clear()
}
