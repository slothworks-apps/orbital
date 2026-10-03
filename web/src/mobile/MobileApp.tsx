import { Banner } from './Banner'
import { MismatchScreen } from './screens/MismatchScreen'
import { NewSessionScreen } from './screens/NewSessionScreen'
import { PairingScreen } from './screens/PairingScreen'
import { SessionListScreen } from './screens/SessionListScreen'
import { SessionScreen } from './screens/SessionScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { UnpairedScreen } from './screens/UnpairedScreen'
import { useMobile } from './state'

/** One screen at a time, chosen by in-memory state (spec § 5). */
export function MobileApp() {
  const screen = useMobile((s) => s.screen)
  return (
    <div className="h-full bg-space font-sans text-text-bright">
      <Banner />
      {screen === 'pairing' && <PairingScreen />}
      {screen === 'list' && <SessionListScreen />}
      {screen === 'session' && <SessionScreen />}
      {screen === 'settings' && <SettingsScreen />}
      {screen === 'new' && <NewSessionScreen />}
      {screen === 'unpaired' && <UnpairedScreen />}
      {screen === 'mismatch' && <MismatchScreen />}
    </div>
  )
}
