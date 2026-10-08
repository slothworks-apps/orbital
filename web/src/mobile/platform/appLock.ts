import { Preferences } from '@capacitor/preferences'

/**
 * 9f's "Require … to open" (spec 2026-10-06-pairing-code-and-app-lock-design
 * § 3). On unless it reads `false`, so a phone paired before the setting
 * existed has it on. The native shells read the same key, and `PAIRING_KEY`,
 * to cover the app-switcher snapshot (MainActivity, SceneDelegate): rename
 * neither without them.
 */
export const APP_LOCK_KEY = 'orbital.appLock'

export async function loadAppLock(): Promise<boolean> {
  const { value } = await Preferences.get({ key: APP_LOCK_KEY })
  return value !== 'false'
}

export function saveAppLock(on: boolean): Promise<void> {
  return Preferences.set({ key: APP_LOCK_KEY, value: on ? 'true' : 'false' })
}
