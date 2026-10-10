import type { TerminalInfo } from './types'

/**
 * The names the tab strip shows: the server's labels, with the second and
 * later of equal ones numbered from 2 (`orbital`, `orbital 2`), in tab order
 * (canvas 48e, THE TAB · LABEL RULE). Recomputed from the live labels, so a
 * tab that `cd`s away gives its number up.
 */
export function tabLabels(tabs: readonly Pick<TerminalInfo, 'label'>[]): string[] {
  const seen = new Map<string, number>()
  return tabs.map(({ label }) => {
    const count = (seen.get(label) ?? 0) + 1
    seen.set(label, count)
    return count > 1 ? `${label} ${count}` : label
  })
}

/** Whether something runs in the tab: its shell is alive and not at a prompt. */
export function tabRunning(tab: Pick<TerminalInfo, 'busy' | 'exitCode'>): boolean {
  return tab.exitCode === null && tab.busy
}

/**
 * The `›_ N` chip's hover title (48e): how many tabs, what runs in them, and
 * the key. Names only what runs — never output — so it cannot become an
 * unread mark.
 */
export function terminalChipTitle(
  tabs: readonly Pick<TerminalInfo, 'label' | 'busy' | 'exitCode'>[],
  shortcut: string,
): string {
  const labels = tabLabels(tabs)
  const running = labels.filter((_, i) => tabRunning(tabs[i]))
  const count = `${tabs.length} ${tabs.length === 1 ? 'terminal' : 'terminals'}`
  return [count, ...(running.length > 0 ? [`${running.join(', ')} running`] : []), shortcut].join(' · ')
}

/**
 * The tab that becomes active when `closedId` goes: the one after it, or the
 * one before when it was the last; null when no tab is left. A tab that was
 * not the active one leaves the active tab where it is.
 */
export function activeAfterClose(
  tabIds: readonly string[],
  activeId: string | null,
  closedId: string,
): string | null {
  const rest = tabIds.filter((id) => id !== closedId)
  if (rest.length === 0) return null
  if (activeId !== closedId && activeId !== null && rest.includes(activeId)) return activeId
  const at = tabIds.indexOf(closedId)
  return rest[Math.min(Math.max(at, 0), rest.length - 1)]
}
