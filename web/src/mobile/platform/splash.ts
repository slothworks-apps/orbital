import { SplashScreen } from '@capacitor/splash-screen'

/**
 * Lifts the launch screen once the first screen is on the glass (Claude
 * Design, "Feature - Splash screen"): it is held with `launchAutoHide` off,
 * and fades over `launchFadeOutDuration` (mobile/capacitor.config.ts). Called
 * from an effect, after React's commit; the second frame is the one that
 * follows the commit's paint.
 */
export function hideSplashAfterPaint(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      SplashScreen.hide().catch(() => {
        // A desktop browser has no launch screen.
      })
    }),
  )
}
