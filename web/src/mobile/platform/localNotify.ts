import { Capacitor } from '@capacitor/core'
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

/** Posts one system notification now (spec § 6.5); a tap on it opens `sessionId`. */
export async function postLocalNotification({ id, title, body, channelId, sound, sessionId }: LocalNotice): Promise<void> {
  try {
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
