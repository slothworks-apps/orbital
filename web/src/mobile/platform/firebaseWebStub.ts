/**
 * Stands in for `firebase/messaging` in the phone's build (vite.mobile.config.ts).
 * `@capacitor-firebase/messaging` imports it for its web implementation, which
 * the native shell never loads; the Firebase web SDK is not installed. A
 * desktop browser running the mobile entry reports push as unsupported.
 */
const unsupported = (): never => {
  throw new Error('Firebase web messaging is not part of the phone build')
}

export const isSupported = (): Promise<boolean> => Promise.resolve(false)
export const getMessaging = unsupported
export const getToken = unsupported
export const deleteToken = unsupported
export const onMessage = unsupported
