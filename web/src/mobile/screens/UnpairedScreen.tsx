import { App } from '@capacitor/app'
import { useMobile } from '../state'
import { NoticeScreen, PrimaryButton, SecondaryButton } from '../ui'

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
    <NoticeScreen
      actions={
        <>
          <PrimaryButton onClick={() => useMobile.getState().go('pairing')}>Pair again</PrimaryButton>
          <SecondaryButton onClick={() => void notNow()}>Not now</SecondaryButton>
        </>
      }
    >
      <h1 className="mt-3.5 text-[24px] font-bold tracking-[-0.01em] [text-wrap:balance]">This phone is no longer paired</h1>
      <p className="text-[15px] leading-[1.5] text-[rgba(220,232,248,.88)]">{name} removed this phone.</p>
      <p className="max-w-[290px] text-[13px] leading-[1.55] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
        Its key is gone, so are the sessions it showed. To connect again, scan a new code on the Mac.
      </p>
    </NoticeScreen>
  )
}

async function notNow(): Promise<void> {
  try {
    await App.minimizeApp()
  } catch {
    // A browser cannot be minimized; the screen simply stays.
  }
}
