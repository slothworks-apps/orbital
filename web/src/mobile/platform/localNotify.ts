import { Capacitor, type PermissionState } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { FirebaseMessaging } from '@capacitor-firebase/messaging'

export interface LocalNotice {
  /** One per session (`notificationId`): a later transition replaces the earlier one. */
  id: number
  title: string
  body: string
  /** Android: the channel, which carries the sound. */
  channelId: string
  /** iOS, which has no channels: whether this one notification makes a sound. */
  sound: boolean
  sessionId: string | null
}

/**
 * Whether the notification permission may be asked for: only when it never
 * was. Android reports a first denial as `prompt-with-rationale`, not
 * `denied`, and a request there shows the system prompt a second time. A
 * refusal stands; the system settings undo it. One rule for both plugins,
 * which share the one permission: `registerPush` and the post below.
 */
export function mayAskForNotifications(state: PermissionState): boolean {
  return state === 'prompt'
}

/**
 * Whether notifications may be shown once the user has asked for them (the
 * tip's Turn on, a switch in 9f): yes if already allowed, the OS's answer if
 * it was never asked, and no without asking after a refusal (spec
 * 2026-10-08-notifications-off-by-default-design § 5, canvas 2d: "It never
 * asks the OS again").
 */
export async function permissionAfterAsking(before: PermissionState, ask: () => Promise<PermissionState>): Promise<boolean> {
  if (before === 'granted') return true
  if (!mayAskForNotifications(before)) return false
  return (await ask()) === 'granted'
}

/**
 * Posts one system notification now (spec § 6.5); a tap on it opens
 * `sessionId`. The plugin's `schedule` asks for a permission it lacks, so a
 * refused one is checked first and nothing is posted — otherwise every
 * notification would ask again.
 */
export async function postLocalNotification({ id, title, body, channelId, sound, sessionId }: LocalNotice): Promise<void> {
  try {
    const { display } = await LocalNotifications.checkPermissions()
    if (display !== 'granted' && !mayAskForNotifications(display)) return
    await LocalNotifications.schedule({
      notifications: [{
        id, title, body, channelId, extra: { sessionId },
        // Nothing is scheduled for later. Left at its default, the plugin
        // wants an exact alarm on Android 12+ and, without the permission,
        // opens the "Alarms & reminders" settings screen instead of posting.
        isExactNotification: false,
        // iOS plays no sound unless one is named, and plays its default sound
        // for a name it cannot find, so a name nothing carries is the default.
        ...(sound && Capacitor.getPlatform() === 'ios' ? { sound: 'default' } : {}),
      }],
    })
  } catch (err) {
    // A desktop browser has no plugin; a phone with notifications denied refuses.
    console.warn('[mobile] could not post a notification', err)
  }
}

/** Takes one delivered notification off the shade — its session is open now. Best-effort. */
export async function removeDeliveredNotification(id: number): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    await LocalNotifications.removeDeliveredNotificationsById({ ids: [id] })
  } catch (err) {
    console.warn('[mobile] could not remove a delivered notification', err)
  }
}

/** Takes every notification off the shade, the phone's own and the relay's pushes alike. Best-effort. */
export async function clearDeliveredNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  const cleared = await Promise.allSettled([
    LocalNotifications.removeAllDeliveredNotifications(),
    FirebaseMessaging.removeAllDeliveredNotifications(),
  ])
  for (const result of cleared) {
    if (result.status === 'rejected') console.warn('[mobile] could not clear delivered notifications', result.reason)
  }
}
