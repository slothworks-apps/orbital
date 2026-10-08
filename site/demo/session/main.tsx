import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '../demo.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { useOrbital } from '../../../web/src/store/store'
import { runDirector } from '../fake/director'
import { BILLING, MODELS, SETTINGS, TAGS } from '../fake/fixtures'
import { announceReady, installFakeServer } from '../fake/install'
import { afterTwoFrames, isPosterRun } from '../page'
import { SESSION_DURATIONS, TICK_MS, frameFor, transcriptChange } from './scenario'
import { SessionDemo } from './SessionDemo'

const id = BILLING.id
const opening = frameFor(0, 0)
const server = installFakeServer({
  sessions: [opening.session],
  tags: TAGS,
  models: MODELS,
  settings: SETTINGS,
  messages: { [id]: opening.messages },
})

// The website is the window this panel sits in, and a detached window dims
// its glint while it is not the focused one; an iframe never is until it is
// clicked. The demo reads as the window in front.
document.hasFocus = () => true

/**
 * A beat changes the session the way the server would: the transcript's new
 * rows on the session's topic (or, when the loop starts over, word that it
 * must be read again), then the row itself, whose question appearing or going
 * `upsert` announces.
 */
let round = 0
let shown = opening
if (!isPosterRun()) {
  runDirector({
    durations: SESSION_DURATIONS,
    tickMs: TICK_MS,
    onBeat: (beat) => {
      if (beat === 0) round += 1
      const next = frameFor(beat, round)
      server.world.messages[id] = next.messages
      const change = transcriptChange(shown.messages, next.messages)
      if (change.kind === 'reset') server.hub.publish(`session:${id}`, { event: 'transcript_reset' })
      else for (const message of change.rows) server.hub.publish(`session:${id}`, { event: 'message', message })
      server.upsert({ ...next.session, lastAt: Date.now() })
      shown = next
    },
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionDemo id={id} />
  </StrictMode>,
)

// As `SessionWindow` seats its session: the snapshot first, then the selection.
void useOrbital
  .getState()
  .loadInitial()
  .then(() => useOrbital.getState().select(id))
  .finally(() => afterTwoFrames(announceReady))
