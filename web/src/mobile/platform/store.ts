import { Capacitor } from '@capacitor/core'

/** The app's id in the stores: `appId` in mobile/capacitor.config.ts. */
const APP_ID = 'io.slothworks.orbital.mobile'

/**
 * Where this app updates itself (9i's app cause): its Google Play listing on
 * Android; null elsewhere. The App Store id does not exist yet, so iOS gets
 * no link and the screen says where to go instead.
 */
export function storeUrl(): string | null {
  return Capacitor.getPlatform() === 'android' ? `https://play.google.com/store/apps/details?id=${APP_ID}` : null
}

/**
 * Leaves for the store. A top-level navigation off the app's own origin is
 * one the Capacitor bridge hands to the system, which opens the Play app.
 */
export function openStore(url: string): void {
  window.location.assign(url)
}
