import { Banner } from './Banner'
import { FileScreen } from './screens/FileScreen'
import { LockScreen } from './screens/LockScreen'
import { MismatchScreen } from './screens/MismatchScreen'
import { NewSessionScreen } from './screens/NewSessionScreen'
import { PairingScreen } from './screens/PairingScreen'
import { ScreenLockScreen } from './screens/ScreenLockScreen'
import { SessionListScreen } from './screens/SessionListScreen'
import { SessionScreen } from './screens/SessionScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { SubagentScreen } from './screens/SubagentScreen'
import { TaskScreen } from './screens/TaskScreen'
import { UnpairedScreen } from './screens/UnpairedScreen'
import { useMobile } from './state'

/**
 * One screen at a time, chosen by in-memory state (spec § 5), behind two
 * gates (spec 2026-10-06-pairing-code-and-app-lock-design § 2, § 3). 9s
 * replaces everything: nothing underneath may start, the scanner least of
 * all. 9t stands over the screen, which stays mounted and is there again
 * on unlock; the banner, which names sessions, waits with it.
 */
export function MobileApp() {
  const screen = useMobile((s) => s.screen)
  const screenLock = useMobile((s) => s.screenLock)
  const locked = useMobile((s) => s.lock !== 'open')
  if (screenLock) {
    return (
      <div className="h-full bg-space font-sans text-text-bright">
        <ScreenLockScreen />
      </div>
    )
  }
  return (
    <div className="h-full bg-space font-sans text-text-bright">
      {!locked && <Banner />}
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
      {locked && <LockScreen />}
    </div>
  )
}
