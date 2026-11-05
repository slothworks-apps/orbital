/** Small texts the popup derives: the shortcut's key cap, how long ago it checked. */

/** The order the key cap shows macOS modifiers in, as Orbital writes ⌘⇧S. */
const MAC_MODIFIERS = ['⌃', '⌥', '⌘', '⇧']

/**
 * The key cap for a shortcut as `chrome.commands` reports it: "⇧⌘S" on a
 * Mac comes back as "⌘⇧S"; "Ctrl+Shift+S" elsewhere stays as it is. An
 * empty string means the browser assigned none.
 */
export function formatShortcut(shortcut: string): string {
  const chars = [...shortcut.trim()]
  if (!chars.some((c) => MAC_MODIFIERS.includes(c))) return shortcut.trim()
  const mods = MAC_MODIFIERS.filter((m) => chars.includes(m))
  const key = chars.filter((c) => !MAC_MODIFIERS.includes(c)).join('')
  return mods.join('') + key
}

/** "checked just now", then minutes, then the clock time. */
export function checkedText(at: number, now: number, clock: (at: number) => string): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'checked just now'
  if (minutes < 60) return `checked ${minutes} min ago`
  return `checked at ${clock(at)}`
}
