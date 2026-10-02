import { App } from '@capacitor/app'
import { useMobile } from '../state'
import { MobileScreen, PrimaryButton, SecondaryButton } from '../ui'

/**
 * 9h (spec § 4): the Mac revoked this phone. Its pairing, identity and cache
 * are already gone; this screen comes back on every launch until a new
 * pairing. "Not now" leaves the app here.
 */
export function UnpairedScreen() {
  const macName = useMobile((s) => s.macName)
  const name = macName || 'Your Mac'
  return (
    <MobileScreen>
      <div className="flex flex-col gap-5 px-6 pt-20">
        <h1 className="text-[22px] font-semibold">This phone was unpaired</h1>
        <p className="text-[14px] text-text-soft">
          {name} removed this phone, so it can no longer see your sessions. Pair again to bring them back.
        </p>
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
