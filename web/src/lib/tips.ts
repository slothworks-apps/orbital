/**
 * Tips, as decisions (spec 2026-11-16-tips-design; canvas `Feature - Tips`
 * 68a–68e): which tip the card offers next, what counts as seen, and whether
 * the map's bulb carries its dot. The list itself is `tips/tipList`.
 */

/**
 * This Mac's server setting listing the tips it has shown, as a JSON array
 * of tip ids. Kept on this device (shared `PER_DEVICE_SETTING_KEYS`), beside
 * WHAT'S NEW's. Missing is a fresh install: nothing seen, so the dot shows.
 */
export const TIPS_SEEN_KEY = 'tips_seen'

/** The headings of All tips, in the order they are drawn (spec § The first tips). */
export const TIP_GROUPS = ['Sessions', 'Starting a session', 'Keyboard and input', 'Elsewhere'] as const
export type TipGroup = (typeof TIP_GROUPS)[number]

/** The Settings sections a tip can open. */
export type TipSettingsSection = 'harness' | 'devices' | 'profiles' | 'shortcuts'

/** What a tip's one button does. It only ever opens something; it never starts a session. */
export type TipAction =
  | { kind: 'settings'; section: TipSettingsSection; label: string }
  | { kind: 'new-session'; label: string }
  | { kind: 'new-session-prompt'; prompt: string; label: string }
  | { kind: 'stats'; label: string }

export interface Tip {
  /** Stable across versions: it is what `TIPS_SEEN_KEY` remembers. */
  id: string
  group: TipGroup
  text: string
  action?: TipAction
}

/** The ids `TIPS_SEEN_KEY` holds. Anything that does not read counts as nothing seen. */
export function parseSeenTips(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set()
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((id): id is string => typeof id === 'string' && id !== ''))
  } catch {
    return new Set()
  }
}

/**
 * The value to store once `ids` have been shown, or null when every one of
 * them was seen already and nothing needs writing. Ids of tips no longer in
 * the list are kept: an older build run again must not forget them.
 */
export function markedSeen(raw: string | null | undefined, ids: Iterable<string>): string | null {
  const seen = parseSeenTips(raw)
  const before = seen.size
  for (const id of ids) seen.add(id)
  if (seen.size === before) return null
  return JSON.stringify([...seen].sort())
}

/** Whether the bulb carries its dot: some tip in the list has not been shown on this Mac. */
export function hasUnseenTips(tips: readonly Tip[], seen: ReadonlySet<string>): boolean {
  return tips.some((tip) => !seen.has(tip.id))
}

/** The card's order: the tips not shown yet first, then the rest, each part in list order. */
export function tipOrder(tips: readonly Tip[], seen: ReadonlySet<string>): Tip[] {
  return [...tips.filter((tip) => !seen.has(tip.id)), ...tips.filter((tip) => seen.has(tip.id))]
}

/** The card's place after `index` in a list of `count`: Next after the last starts over. */
export function nextTipIndex(index: number, count: number): number {
  return count === 0 ? 0 : (index + 1) % count
}

/** The card's place before `index`: back from the first goes to the last. */
export function previousTipIndex(index: number, count: number): number {
  return count === 0 ? 0 : (index - 1 + count) % count
}

/** The card's counter (canvas 68c): `3 of 11`, and on the last one, that Next starts over. */
export function tipPosition(index: number, count: number): string {
  const at = `${index + 1} of ${count}`
  return index === count - 1 ? `${at} · Next starts over` : at
}

/** All tips' groups in `TIP_GROUPS` order, each with its tips in list order; an empty group is left out. */
export function groupTips(tips: readonly Tip[]): { group: TipGroup; tips: Tip[] }[] {
  return TIP_GROUPS.map((group) => ({ group, tips: tips.filter((tip) => tip.group === group) })).filter(
    (entry) => entry.tips.length > 0,
  )
}

/** All tips' header meta (canvas 68d): `11 tips · 2 new`, the count of new left out at none. */
export function allTipsMeta(total: number, unseen: number): string {
  const tips = `${total} ${total === 1 ? 'tip' : 'tips'}`
  return unseen > 0 ? `${tips} · ${unseen} new` : tips
}
