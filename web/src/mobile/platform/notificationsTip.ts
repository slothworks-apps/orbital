import { Capacitor, registerPlugin } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'

/**
 * The phone's notifications tip, as stored (spec
 * 2026-10-08-notifications-off-by-default-design § 5): `pending` from a pairing
 * until the tip has gone, then `ended` for good. Outside the cache prefix, so
 * forgetting a Mac does not offer it again; a phone that paired before this
 * existed has no row, and is never offered it.
 */
export const NOTIFICATIONS_TIP_PREF = 'orbital.notificationsTip'

export async function readPhoneTip(): Promise<string | null> {
  const { value } = await Preferences.get({ key: NOTIFICATIONS_TIP_PREF })
  return value
}

export function writePhoneTip(value: 'pending' | 'ended'): Promise<void> {
  return Preferences.set({ key: NOTIFICATIONS_TIP_PREF, value })
}

/** The Android shell's own plugin (`NotificationSettingsPlugin`, registered in MainActivity). */
const NotificationSettings = registerPlugin<{ open(): Promise<void> }>('NotificationSettings')

/**
 * The refused tip's one way out (canvas 2d): this app's notification settings
 * on Android, this app's page in Settings on iOS — `app-settings:`, the public
 * `UIApplication.openSettingsURLString`, which Capacitor hands to the system
 * because it is not the app's own URL.
 */
export async function openPhoneNotificationSettings(): Promise<void> {
  try {
    if (Capacitor.getPlatform() === 'android') await NotificationSettings.open()
    else if (Capacitor.getPlatform() === 'ios') window.location.assign('app-settings:')
  } catch (err) {
    console.warn('[mobile] could not open the notification settings', err)
  }
}
