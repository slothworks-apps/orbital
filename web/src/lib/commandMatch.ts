/**
 * Matching a typed fragment against the command catalog
 * (spec: 2026-09-20-composer-design § Completion popup).
 *
 * Prefix-only matching cannot find a namespaced command by the half that
 * names it: `superpowers:brainstorming` is filed under its plugin, and the
 * word the user actually remembers is the one after the colon. So the filter
 * also matches that segment, and any substring — but it RANKS, so a prefix
 * hit still sorts above a name that merely contains the fragment and `/co`
 * keeps landing on `code-review`.
 *
 * Subsequence ("fuzzy") matching stays out of scope, as in the spec: on a
 * two-character fragment it matches most of the catalog, and the order it
 * comes back in is then a scoring heuristic rather than anything the user can
 * predict.
 */

import type { SlashCommand } from './types'

/** Lower sorts first. The values are an order, not a score. */
const PREFIX = 0
const SEGMENT_PREFIX = 1
const SUBSTRING = 2

/**
 * How well `name` answers to `wanted`, or null for no match at all. `wanted`
 * is matched case-insensitively and expected without its leading slash, the
 * spelling `commandNameSet` normalises to.
 */
export function commandMatchRank(name: string, wanted: string): number | null {
  const fragment = wanted.toLowerCase()
  // An empty fragment is the bare `/`, which offers the whole catalog in the
  // order the server sent it.
  if (fragment === '') return PREFIX
  const haystack = name.toLowerCase()
  if (haystack.startsWith(fragment)) return PREFIX
  const colon = haystack.indexOf(':')
  if (colon !== -1 && haystack.slice(colon + 1).startsWith(fragment)) return SEGMENT_PREFIX
  if (haystack.includes(fragment)) return SUBSTRING
  return null
}

/**
 * The catalog filtered and ordered for the popup. Names come back without a
 * leading slash (the wire contract does not pin it down — see
 * `commandNameSet`), and ties keep the server's own order, which is what
 * makes the list stable as the fragment grows.
 */
export function matchCommands(
  commands: readonly SlashCommand[],
  prefix: string,
): SlashCommand[] {
  return commands
    .map((c) => (c.name.startsWith('/') ? { ...c, name: c.name.slice(1) } : c))
    .map((c) => ({ c, rank: commandMatchRank(c.name, prefix) }))
    .filter((r): r is { c: SlashCommand; rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.c)
}
