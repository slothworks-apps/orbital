import { useEffect, useState } from 'react'
import { canOpenSecuritySettings, openSecuritySettings, passcodeSettingsName } from '../platform/deviceLock'
import { NoticeScreen, PrimaryButton } from '../ui'

/**
 * 9s (spec 2026-10-06-pairing-code-and-app-lock-design § 2): the device has
 * no screen lock, and the whole app waits behind this, pairing included. A
 * routine step in 9i's calm frame: grey mark, no warning, one reason and
 * one action. The pairing and the cache stay; every return to the
 * foreground checks again (`boot.ts`) and lifts it once a lock is set.
 *
 * Android opens the screen-lock settings. iOS has no link an app may use to
 * reach the passcode page, so it says where the page is instead.
 */
export function ScreenLockScreen() {
  const android = canOpenSecuritySettings()
  const [passcodePage, setPasscodePage] = useState<string | null>(null)
  useEffect(() => {
    if (android) return
    let current = true
    void passcodeSettingsName().then((name) => current && setPasscodePage(name))
    return () => {
      current = false
    }
  }, [android])

  return (
    <NoticeScreen
      inset="wide"
      actions={
        <>
          <p className="text-center font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">checked again when you come back</p>
          {android && <PrimaryButton onClick={() => void openSecuritySettings()}>Open security settings</PrimaryButton>}
        </>
      }
    >
      <h1 className="mt-3.5 text-[24px] font-bold tracking-[-0.01em] [text-wrap:balance]">Set a screen lock to use Orbital</h1>
      <p className="max-w-[290px] text-[14px] leading-[1.55] text-[rgba(200,214,235,.85)] [text-wrap:pretty]">
        A paired phone can run agents on your Mac.
      </p>
      {!android && passcodePage && (
        <p className="text-[12.5px] leading-[1.5] text-[rgba(160,190,225,.65)]">
          On this iPhone: Settings → {passcodePage} → Turn Passcode On.
        </p>
      )}
    </NoticeScreen>
  )
}
