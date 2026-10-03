import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { PushNotifications } from '@capacitor/push-notifications'
import { clientRef } from '../transport/clientRef'

/**
 * The relay's push and the phone's own notifications (spec 2026-10-02-mobile-app-design
 * § 6.5). Everything here is a no-op outside the native shell: a desktop
 * browser has neither plugin.
 */

const native = (): boolean => Capacitor.isNativePlatform()

/** High: a heads-up notification (Android's `IMPORTANCE_HIGH`). */
const IMPORTANCE_HIGH = 4

/**
 * Both plugins create channels in the one system registry (Android's
 * `NotificationManager`), so one call per channel serves the relay's pushes
 * and the local notifications alike.
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
  if (!native()) return
  try {
    await Promise.all(CHANNELS.map((channel) => PushNotifications.createChannel(channel)))
  } catch (err) {
    console.warn('[mobile] could not create the notification channels', err)
  }
}

/**
 * Asks for the permission (Android 13's prompt) and a token; the token goes
 * to the client, which re-sends it on every relay `ok` and after `paired`.
 * A denial is not an error: the app runs without notifications.
 *
 * Skipped in a build without `google-services.json` (`__MOBILE_PUSH__`):
 * the plugin's `register` reaches for a Firebase app that does not exist,
 * and Capacitor rethrows that on its plugin thread, which kills the app.
 */
export async function registerPush(): Promise<void> {
  if (!native()) return
  try {
    const { receive } = await PushNotifications.requestPermissions()
    if (receive !== 'granted' || !__MOBILE_PUSH__) return
    await PushNotifications.register()
  } catch (err) {
    console.warn('[mobile] could not register for push', err)
  }
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
  PushNotifications.addListener('registration', ({ value }) => clientRef.pushToken(value)).catch(failed)
  PushNotifications.addListener('registrationError', ({ error }) => {
    console.warn('[mobile] push registration failed', error)
  }).catch(failed)
  PushNotifications.addListener('pushNotificationActionPerformed', () => handlers.openList()).catch(failed)
  LocalNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
    const id: unknown = notification.extra?.sessionId
    if (typeof id === 'string' && id) handlers.openSession(id)
  }).catch(failed)
}
