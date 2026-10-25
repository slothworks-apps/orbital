import { isSharedSetting } from '@orbital/shared/sharedSettings'
import type { GroupMember } from './types'

/**
 * Settings' marking of what the group shares (spec
 * 2026-10-24-group-shared-settings-design § What the user sees in Settings;
 * canvas `Feature - Shared settings` 63a–63d). `shared`: every row applies on
 * every Mac and server in the group. `device`: every row applies to this
 * device only. `mixed`: shared, except the rows marked THIS MAC ONLY.
 */
export type SettingsScope = 'shared' | 'device' | 'mixed'

/**
 * A section's scope from the keys its rows edit, so the label cannot drift
 * from the classification in `shared/`. Null with no keys (a section of
 * read-only rows), which carries no label.
 */
export function scopeOfKeys(keys: readonly string[]): SettingsScope | null {
  if (keys.length === 0) return null
  const shared = keys.filter(isSharedSetting).length
  if (shared === keys.length) return 'shared'
  return shared === 0 ? 'device' : 'mixed'
}

/** A row in a mixed section carries THIS MAC ONLY when none of the keys it edits is shared. */
export function rowIsDeviceOnly(keys: readonly string[]): boolean {
  return keys.length > 0 && !keys.some(isSharedSetting)
}

/** What a section heading's right end reads (canvas 63c). */
export const SCOPE_LABEL: Record<SettingsScope, string> = {
  shared: 'SHARED · ALL MACS & SERVERS',
  device: 'THIS MAC ONLY',
  mixed: 'SHARED · EXCEPT MARKED',
}

/**
 * Who the group line names. `shown`: the group holds another Mac or server
 * (old ones included), so Settings marks what is shared; alone, or with
 * phones only, nothing is marked. `names`: this device first, then every
 * other Mac and server that shares settings. `old`: the Macs and servers
 * too old to share them — too old for the group at all, or whose last hello
 * did not name `settings-sync`. A member not heard from since this server
 * started is not known to be old, so it is named.
 */
export type GroupSharing = {
  shown: boolean
  names: string[]
  old: { id: string; name: string }[]
}

export const NOT_SHARING: GroupSharing = { shown: false, names: [], old: [] }

export function groupSharing(members: readonly GroupMember[] | undefined): GroupSharing {
  if (!members) return NOT_SHARING
  const others = members.filter((m) => !m.self && m.kind !== 'phone')
  if (others.length === 0) return NOT_SHARING
  const isOld = (m: GroupMember) => m.tooOld || m.settingsSync === false
  const self = members.find((m) => m.self)
  return {
    shown: true,
    names: [...(self ? [self.name] : []), ...others.filter((m) => !isOld(m)).map((m) => m.name)],
    old: others.filter(isOld).map((m) => ({ id: m.id, name: m.name })),
  }
}

/** What goes before the `i`th of `n` names in a list read "A, B and C". */
export function listSeparator(i: number, n: number): string {
  if (i === 0) return ''
  return i === n - 1 ? ' and ' : ', '
}
