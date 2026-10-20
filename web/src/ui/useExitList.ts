import { useEffect, useReducer, useRef } from 'react'
import { prefersReducedMotion } from './usePresence'

export interface ExitEntry<T, K> {
  item: T
  key: K
  /** Gone from the source list; still rendered while it animates out. */
  leaving: boolean
}

/**
 * The list to render: `next` in its own order, with every entry of `prev`
 * that `next` no longer has kept in place as `leaving` — after the entry that
 * preceded it, so it fades where it was rather than jumping to an end. Keys
 * in `expired` have finished leaving and are dropped.
 */
export function mergeExiting<T, K>(
  prev: readonly ExitEntry<T, K>[],
  next: readonly T[],
  keyOf: (item: T) => K,
  expired: ReadonlySet<K>,
): ExitEntry<T, K>[] {
  const result: ExitEntry<T, K>[] = next.map((item) => ({ item, key: keyOf(item), leaving: false }))
  const present = new Set(result.map((entry) => entry.key))
  let anchor: K | null = null
  for (const entry of prev) {
    if (present.has(entry.key)) {
      anchor = entry.key
      continue
    }
    if (expired.has(entry.key)) continue
    const at = anchor === null ? 0 : result.findIndex((r) => r.key === anchor) + 1
    result.splice(at, 0, { ...entry, leaving: true })
    anchor = entry.key
  }
  return result
}

/**
 * Keeps an item that left `items` rendered for `exitMs` more, marked
 * `leaving`, so its row can animate out (`ui/Collapse` with `stagger`) and the
 * rows below glide up instead of jumping. Under `prefers-reduced-motion` a
 * leaving item is dropped at once.
 */
export function useExitList<T, K>(items: readonly T[], keyOf: (item: T) => K, exitMs: number): ExitEntry<T, K>[] {
  const last = useRef<ExitEntry<T, K>[]>([])
  const expired = useRef(new Set<K>())
  const timers = useRef(new Map<K, ReturnType<typeof setTimeout>>())
  const [, rerender] = useReducer((n: number) => n + 1, 0)

  const reduced = prefersReducedMotion() || exitMs <= 0
  // Idempotent on a second render of the same props: merging the merged list
  // with the same `items` yields it again.
  const merged = mergeExiting(reduced ? [] : last.current, items, keyOf, expired.current)
  last.current = merged

  useEffect(() => {
    const live = new Set(merged.map((entry) => entry.key))
    for (const entry of merged) {
      if (entry.leaving) {
        if (timers.current.has(entry.key)) continue
        timers.current.set(
          entry.key,
          setTimeout(() => {
            timers.current.delete(entry.key)
            expired.current.add(entry.key)
            rerender()
          }, exitMs),
        )
      } else {
        // Back in the list before it finished leaving: it stays.
        const timer = timers.current.get(entry.key)
        if (timer !== undefined) {
          clearTimeout(timer)
          timers.current.delete(entry.key)
        }
        expired.current.delete(entry.key)
      }
    }
    for (const key of expired.current) if (!live.has(key)) expired.current.delete(key)
  })

  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach(clearTimeout)
  }, [])

  return merged
}
