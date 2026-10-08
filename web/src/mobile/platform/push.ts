import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { FirebaseMessaging } from '@capacitor-firebase/messaging'
import { clientRef } from '../transport/clientRef'
import { permissionAfterAsking } from './localNotify'

/**
 * The relay's push and the phone's own notifications (spec 2026-10-02-mobile-app-design
 * § 6.5). Everything here is a no-op outside the native shell: a desktop
 * browser has neither plugin.
 *
 * Push goes through `@capacitor-firebase/messaging` on both platforms (spec
 * 2026-10-05-ios-app-design): it hands iOS an FCM token, where Capacitor's
 * own push plugin hands it an APNs token the relay cannot address.
 */

const native = (): boolean => Capacitor.isNativePlatform()

/** Whether this build carries the Firebase config for the platform it runs on (`__MOBILE_PUSH__`). */
const pushConfigured = (): boolean => {
  const platform = Capacitor.getPlatform()
  return (platform === 'android' || platform === 'ios') && __MOBILE_PUSH__[platform]
}

/** High: a heads-up notification (Android's `IMPORTANCE_HIGH`). */
const IMPORTANCE_HIGH = 4

/**
 * Android only; iOS has no channels. Both plugins create channels in the one
 * system registry (Android's `NotificationManager`), so one call per channel
 * serves the relay's pushes and the local notifications alike.
 *
 * `needs_input` is silent — the relay addresses it and does not know the
 * phone's `sound` rule. Neither plugin can create a channel without a sound
 * (an absent `sound` leaves Android's default on it), so it plays a bundled
 * clip of silence: `res/raw/silence.wav` in the Android project, which the
 * plugin resolves by its name without the extension. A channel's sound is
 * fixed once a device has created it; changing it here reaches only a fresh
 * install.
 */
const CHANNELS = [
  { id: 'needs_input', name: 'Needs input', importance: IMPORTANCE_HIGH, vibration: false, sound: 'silence.wav' },
  { id: 'needs_input_sound', name: 'Needs input · sound', importance: IMPORTANCE_HIGH, vibration: true },
] as const

export async function installNotificationChannels(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return
  try {
    await Promise.all(CHANNELS.map((channel) => FirebaseMessaging.createChannel(channel)))
  } catch (err) {
    console.warn('[mobile] could not create the notification channels', err)
  }
}

/**
 * Hands the client an FCM token when the permission is already granted; the
 * token goes to the relay on every `ok` and after `paired`. Called at launch
 * and on pairing, and it never asks: the question comes only when the user
 * turns a notification on (`askForNotifications`; spec
 * 2026-10-08-notifications-off-by-default-design § 5). A denial is not an
 * error: the app runs without notifications.
 *
 * Skipped in a build without the platform's Firebase config
 * (`google-services.json`, `GoogleService-Info.plist`; `__MOBILE_PUSH__`):
 * on Android the plugin reaches for a Firebase app that does not exist, and
 * Capacitor rethrows that on its plugin thread, which kills the app.
 */
export async function registerPush(): Promise<void> {
  if (!native()) return
  try {
    const { receive } = await FirebaseMessaging.checkPermissions()
    if (receive === 'granted') await sendToken()
  } catch (err) {
    console.warn('[mobile] could not register for push', err)
  }
}

/**
 * The tip's Turn on and a switch turned on in 9f: asks the OS (Android 13's
 * prompt, iOS's own) if it never was asked, and registers for push once
 * allowed. Resolves to whether notifications may be shown. A browser, which
 * has neither plugin, counts as allowed: it is for layout work only.
 */
export async function askForNotifications(): Promise<boolean> {
  if (!native()) return true
  try {
    const { receive: before } = await FirebaseMessaging.checkPermissions()
    const allowed = await permissionAfterAsking(before, async () => (await FirebaseMessaging.requestPermissions()).receive)
    if (allowed) await sendToken()
    return allowed
  } catch (err) {
    console.warn('[mobile] could not ask for notifications', err)
    return false
  }
}

async function sendToken(): Promise<void> {
  if (!pushConfigured()) return
  const { token } = await FirebaseMessaging.getToken()
  clientRef.pushToken(token)
}

/**
 * Where a tap lands: a relay push opens the list, a local notification the
 * session it names. Installed at boot before anything awaits — the plugins
 * hold a cold start's tap until a listener exists, and boot must not be
 * mid-way through choosing a screen of its own unaware of it.
 */
export function installPushListeners(handlers: { openList(): void; openSession(id: string): void }): void {
  if (!native()) return
  const failed = (err: unknown) => console.warn('[mobile] could not listen for notifications', err)
  // FCM replaces a token now and then; `registerPush` delivers the first one.
  FirebaseMessaging.addListener('tokenReceived', ({ token }) => clientRef.pushToken(token)).catch(failed)
  FirebaseMessaging.addListener('notificationActionPerformed', () => handlers.openList()).catch(failed)
  LocalNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
    const id: unknown = notification.extra?.sessionId
    if (typeof id === 'string' && id) handlers.openSession(id)
  }).catch(failed)
}
