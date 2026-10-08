import {
  NOTIFICATION_SETTING_KEYS, NOTIFICATIONS_TIP_ENDED, NOTIFICATIONS_TIP_KEY, NOTIFICATIONS_TIP_PENDING,
  NOTIFICATIONS_TURN_ON, notificationsAllOff, parseNotificationSettings,
} from '@orbital/shared/notifications'
import type { NotificationPermissionAnswer } from './desktop'

/**
 * The desktop's notifications tip, as decisions (spec
 * 2026-10-08-notifications-off-by-default-design § 3, canvas `Feature -
 * Notifications off` 1a, 1b, 1d).
 */

type Settings = Record<string, string | undefined>

/**
 * Offered once a session is on the map — never on an empty first launch —
 * while the tip is still pending and nothing notifies. The server ends the
 * tip when a notification row changes, so `pending` already means "never
 * changed"; all-off is checked too, for a database edited by hand.
 */
export function shouldOfferNotificationsTip(settings: Settings, sessions: Iterable<{ status: string }>): boolean {
  if (settings[NOTIFICATIONS_TIP_KEY] !== NOTIFICATIONS_TIP_PENDING) return false
  if (!notificationsAllOff(parseNotificationSettings(settings))) return false
  for (const session of sessions) if (session.status !== 'ended') return true
  return false
}

/** What ends the tip without switching anything: ×, Settings →, a refusal. */
export const END_TIP_PATCH: Record<string, string> = { [NOTIFICATIONS_TIP_KEY]: NOTIFICATIONS_TIP_ENDED }

/**
 * What Turn on saves once macOS has answered. A refusal switches nothing on;
 * no answer yet counts as yes — the user asked for notifications, and macOS
 * holds them until its own question is answered. Either way the tip ends.
 */
export function turnOnPatch(answer: NotificationPermissionAnswer): Record<string, string> {
  if (answer === 'denied') return END_TIP_PATCH
  const patch: Record<string, string> = { ...END_TIP_PATCH }
  for (const key of Object.keys(NOTIFICATIONS_TURN_ON) as (keyof typeof NOTIFICATIONS_TURN_ON)[]) {
    patch[NOTIFICATION_SETTING_KEYS[key]] = 'true'
  }
  return patch
}

/**
 * One Settings → Notifications switch, saved. It ends the tip in the same
 * write so the open window drops it at once; the server would end it anyway.
 */
export function notificationRowPatch(key: keyof typeof NOTIFICATION_SETTING_KEYS, on: boolean): Record<string, string> {
  return { [NOTIFICATION_SETTING_KEYS[key]]: on ? 'true' : 'false', ...END_TIP_PATCH }
}
