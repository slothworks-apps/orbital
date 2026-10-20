import { Preferences } from '@capacitor/preferences'

/**
 * What the phone remembers for WHAT'S NEW (spec 2026-10-19-whats-new-design;
 * `lib/whatsNew` `SeenVersion`, serialized): the last app version it ran.
 * Outside the cache prefix, like the notifications tip, so forgetting a Mac
 * does not show it again.
 */
export const WHATS_NEW_PREF = 'orbital.whatsNew'

export async function readWhatsNew(): Promise<string | null> {
  const { value } = await Preferences.get({ key: WHATS_NEW_PREF })
  return value
}

export function writeWhatsNew(value: string): Promise<void> {
  return Preferences.set({ key: WHATS_NEW_PREF, value })
}
