import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '../demo.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { useOrbital } from '../../../web/src/store/store'
import type { ApiSession } from '../../../web/src/lib/types'
import { runDirector } from '../fake/director'
import { MESSAGES, MODELS, SETTINGS, TAGS } from '../fake/fixtures'
import { announceReady, capDevicePixelRatio, installFakeServer } from '../fake/install'
import { MapDemo } from './MapDemo'
import { MAP_DURATIONS, TICK_MS, parseScene, sessionsFor } from './scenario'

/**
 * The cap on the map canvas's pixel ratio. The website draws this page at its
 * virtual viewport and scales it down, so a denser canvas buys nothing on
 * screen.
 */
const MAX_DPR = 1.5

capDevicePixelRatio(MAX_DPR)

const scene = parseScene(window.location.search)
const opening = sessionsFor(scene, 0)
const server = installFakeServer({
  sessions: opening,
  tags: TAGS,
  models: MODELS,
  settings: SETTINGS,
  messages: MESSAGES,
})

/**
 * The store is seeded directly, as `web/src/sandbox/ClusterSandboxPage.tsx`
 * does, rather than through `loadInitial`: the map fits itself to the first
 * frame that has sessions, so they must be there before it renders.
 * `urlRestored` is the flag that fit waits for; nothing here restores a URL.
 */
const sessions: Record<string, ApiSession> = {}
for (const s of opening) sessions[s.id] = s
useOrbital.setState((state) => ({
  sessions,
  order: opening.map((s) => s.id),
  tags: TAGS,
  models: MODELS,
  settings: SETTINGS,
  sessionsTotal: opening.length,
  ui: { ...state.ui, selectedId: null, sidebarCollapsed: true, urlRestored: true },
}))

// A beat publishes only the sessions it changed: the beats share their
// unchanged session objects, so a changed one is a different object.
let shown = new Map(opening.map((s) => [s.id, s]))
runDirector({
  durations: MAP_DURATIONS,
  tickMs: TICK_MS,
  onBeat: (beat) => {
    const next = sessionsFor(scene, beat)
    for (const s of next) {
      if (shown.get(s.id) !== s) server.upsert({ ...s, lastAt: Date.now() })
    }
    shown = new Map(next.map((s) => [s.id, s]))
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MapDemo />
  </StrictMode>,
)

/**
 * Ready once the map's canvas exists and two frames have passed — the first
 * is where `SpaceMap` fits the camera, the second is drawn with it.
 */
function whenCanvasDrawn(then: () => void) {
  const canvas = document.querySelector('canvas')
  if (!canvas) {
    requestAnimationFrame(() => whenCanvasDrawn(then))
    return
  }
  requestAnimationFrame(() => requestAnimationFrame(then))
}
whenCanvasDrawn(announceReady)
