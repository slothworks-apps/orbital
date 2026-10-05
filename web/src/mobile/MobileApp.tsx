import { Banner } from './Banner'
import { FileScreen } from './screens/FileScreen'
import { MismatchScreen } from './screens/MismatchScreen'
import { NewSessionScreen } from './screens/NewSessionScreen'
import { PairingScreen } from './screens/PairingScreen'
import { SessionListScreen } from './screens/SessionListScreen'
import { SessionScreen } from './screens/SessionScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { SubagentScreen } from './screens/SubagentScreen'
import { TaskScreen } from './screens/TaskScreen'
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
      {screen === 'subagent' && <SubagentScreen />}
      {screen === 'task' && <TaskScreen />}
      {screen === 'file' && <FileScreen />}
      {screen === 'settings' && <SettingsScreen />}
      {screen === 'new' && <NewSessionScreen />}
      {screen === 'unpaired' && <UnpairedScreen />}
      {screen === 'mismatch' && <MismatchScreen />}
    </div>
  )
}
