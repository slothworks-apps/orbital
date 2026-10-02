import { PairingScreen } from './screens/PairingScreen'
import { SessionListScreen } from './screens/SessionListScreen'
import { ScreenPending } from './screens/ScreenPending'
import { useMobile } from './state'

/** One screen at a time, chosen by in-memory state (spec § 5). */
export function MobileApp() {
  const screen = useMobile((s) => s.screen)
  return (
    <div className="h-full bg-space font-sans text-text-bright">
      {screen === 'pairing' && <PairingScreen />}
      {screen === 'list' && <SessionListScreen />}
      {screen === 'session' && <ScreenPending name="session" />}
      {screen === 'settings' && <ScreenPending name="settings" />}
      {screen === 'unpaired' && <ScreenPending name="unpaired" />}
      {screen === 'mismatch' && <ScreenPending name="mismatch" />}
    </div>
  )
}
