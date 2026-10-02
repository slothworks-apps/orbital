import { App } from '@capacitor/app'
import { useMobile } from '../state'
import { MobileMark, MobileScreen, PrimaryButton, SecondaryButton } from '../ui'

/**
 * 9h (spec § 4): the Mac revoked this phone. Its pairing, identity and cache
 * are already gone; this screen comes back on every launch until a new
 * pairing. "Not now" leaves the app here. A grey mark, no red, no icon: it
 * is news, not an error.
 */
export function UnpairedScreen() {
  const macName = useMobile((s) => s.macName)
  const name = macName || 'Your Mac'
  return (
    <MobileScreen>
      <div className="flex flex-col gap-5 px-6 pt-20">
        <MobileMark muted />
        <h1 className="text-[22px] font-semibold">This phone is no longer paired</h1>
        <div className="flex flex-col gap-2 text-[14px] text-text-soft">
          <p>{name} removed this phone.</p>
          <p>Its key is gone, so are the sessions it showed. To connect again, scan a new code on the Mac.</p>
        </div>
        <PrimaryButton onClick={() => useMobile.getState().go('pairing')}>Pair again</PrimaryButton>
        <SecondaryButton onClick={() => void notNow()}>Not now</SecondaryButton>
      </div>
    </MobileScreen>
  )
}

async function notNow(): Promise<void> {
  try {
    await App.minimizeApp()
  } catch {
    // A browser cannot be minimized; the screen simply stays.
  }
}
