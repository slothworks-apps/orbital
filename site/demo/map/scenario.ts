import type { ApiSession } from '../../../web/src/lib/types'
import { BILLING, BILLING_DECISION, DOCS, INFRA, MOBILE, QUIET, subagent } from '../fake/fixtures'

/** One director tick. The beats below are counted in these. */
export const TICK_MS = 1000

const MOONS = [
  subagent(MOBILE.id, 0, 'trace client refresh', 'working'),
  subagent(MOBILE.id, 1, 'read server registration', 'working'),
  subagent(MOBILE.id, 2, 'scan last week’s logs', 'working'),
]

const waiting = (moons: number[]): ApiSession => ({
  ...MOBILE,
  awaitingSubagents: true,
  subagents: moons.map((i) => MOONS[i]),
  subagentCount: MOONS.length,
})

const asking: ApiSession = { ...BILLING, status: 'needs_input', pendingDecision: BILLING_DECISION }
const working: ApiSession = { ...BILLING, status: 'working', pendingDecision: null }

interface Beat {
  /** Ticks this beat holds. */
  ticks: number
  /** The four sessions as they stand in this beat. */
  sessions: ApiSession[]
}

/**
 * The map scenario (spec § Scenarios): billing-api works and then asks for a
 * permission, docs-site is done, mobile-app waits on its subagents while they
 * finish one by one and it sends more, and a terminal session works away.
 *
 * The first beat is the one the page opens on, and it carries all four
 * states of the legend at once — NEEDS INPUT, DONE, WORKING, WAITING FOR
 * AGENTS — because it is also what the poster is taken from. Every beat
 * keeps a WAITING planet: the moons go down to one, never to none. Holds are
 * long on purpose: motion on the map shows state, slowly (docs/why-orbital.md).
 */
export const MAP_BEATS: Beat[] = [
  { ticks: 9, sessions: [asking, DOCS, waiting([0, 1, 2]), INFRA] },
  { ticks: 6, sessions: [asking, DOCS, waiting([1, 2]), INFRA] },
  { ticks: 7, sessions: [working, DOCS, waiting([2]), INFRA] },
  { ticks: 7, sessions: [working, DOCS, waiting([2, 0, 1]), INFRA] },
]

export const MAP_DURATIONS = MAP_BEATS.map((beat) => beat.ticks)

export type MapScene = 'hero' | 'states'

/**
 * `?scene=hero` (the default) shows the whole cluster: the four sessions and
 * quieter ones around them. `?scene=states` shows only the four, so the fit
 * the map does on load frames the four states of the legend close up.
 */
export function parseScene(search: string): MapScene {
  return new URLSearchParams(search).get('scene') === 'states' ? 'states' : 'hero'
}

export function sessionsFor(scene: MapScene, beat: number): ApiSession[] {
  const moving = MAP_BEATS[beat].sessions
  return scene === 'hero' ? [...moving, ...QUIET] : moving
}
