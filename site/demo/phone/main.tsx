import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import './phone.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getSocket } from '../../../web/src/lib/socket'
import { TRANSCRIPT_PAGE_SIZE } from '../../../web/src/mobile/constants'
import { MobileApp } from '../../../web/src/mobile/MobileApp'
import { useMobile } from '../../../web/src/mobile/state'
import { ComposerLockContext } from '../../../web/src/panels/Composer'
import { configureTranscriptPages, useOrbital, type SessionsEvent } from '../../../web/src/store/store'
import { ErrorBoundary } from '../../../web/src/ui/ErrorBoundary'
import { BILLING } from '../fake/fixtures'
import { announceReady, installFakeServer } from '../fake/install'
import { COMPOSER_LOCKED, afterTwoFrames } from '../page'
import { PHONE_WORLD } from './world'

/**
 * The phone demo: `web/src/mobile`'s screens as the phone app runs them, on
 * the fake server instead of the relay.
 *
 * The phone's own start-up (`web/src/mobile/boot.ts`) is not run: it points
 * the transports at the relay tunnel, reads the pairing and the cache from
 * the device and wires notifications and the app lifecycle — none of which a
 * web page has. What it leaves for the screens is done here instead: the
 * fake server behind `configureApi` / `configureSocket` (where boot puts the
 * tunnel), the same page size and `sessions` subscription, and the phone's
 * state as a paired phone with its Mac online would hold it.
 *
 * `?screen=answer` opens a session that asks for a permission; `?screen=new`
 * the new-session screen (9d).
 */
type PhoneScreen = 'answer' | 'new'
const screen: PhoneScreen = new URLSearchParams(window.location.search).get('screen') === 'new' ? 'new' : 'answer'

installFakeServer(PHONE_WORLD)

configureTranscriptPages(TRANSCRIPT_PAGE_SIZE)
getSocket().subscribe('sessions', (msg: SessionsEvent) => useOrbital.getState().queueSessionsEvent(msg))

const now = Date.now()
useMobile.setState({
  link: 'online',
  macOnline: true,
  ready: true,
  macName: 'MacBook Pro',
  asOf: now,
  listedAt: now,
  // Every session is in the list already: there is no ENDED fold to read.
  endedLoaded: true,
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Orbital">
      <ComposerLockContext.Provider value={COMPOSER_LOCKED}>
        <MobileApp />
      </ComposerLockContext.Provider>
    </ErrorBoundary>
  </StrictMode>,
)

/** Calls `then` on the first frame `ready()` holds. */
function whenTrue(ready: () => boolean, then: () => void): void {
  if (ready()) then()
  else requestAnimationFrame(() => whenTrue(ready, then))
}

// The list is read first, as `resync` reads it, so back from either screen
// lands on a full one. `previous` is where 9d's × returns: the list.
void useOrbital
  .getState()
  .loadSessions()
  .then(() => {
    if (screen === 'answer') {
      useMobile.getState().openSession(BILLING.id)
      whenTrue(() => Boolean(useOrbital.getState().historyLoaded[BILLING.id]), () => afterTwoFrames(announceReady))
    } else {
      useMobile.setState({ screen: 'new', previous: 'list' })
      // 9d draws its mode and model only once the Mac's defaults are in.
      whenTrue(() => document.querySelector('[aria-label="Model"]') !== null, () => afterTwoFrames(announceReady))
    }
  })
