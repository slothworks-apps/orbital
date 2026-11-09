import { sessionStateKey, shownStatus, type ApiSession, type SessionStateKey, type SessionStatus } from '../lib/types'

/** One `N WORD` segment of the map's aggregate readout. */
export interface ReadoutSegment {
  key: SessionStateKey
  text: string
}

/** What the readout counts a planet by: whether it is drawn as counted, and its session. */
export interface ReadoutPlanet {
  muted?: boolean
  deviceOff?: boolean
  session: ApiSession
}

/**
 * The map's aggregate readout (canvas 1a, 24b; 66b for the setup words),
 * shared by the Planets map and the Desk shell.
 *
 * `counts` is `statusCounts`, which knows the status and not the reason, so
 * the `needs_input` column splits the way the pills do (`sessionStateKey`):
 * only the planets with a question parked on them are NEEDS INPUT, an
 * interrupted one says INTERRUPTED, the rest merely finished. A worktree
 * launch not started yet is in no column of `counts` — it reads `idle` on
 * the wire — and is counted here as SETTING UP or NOT STARTED. Muted
 * planets are left out, as `statusCounts` leaves them out, and so are those
 * of a device whose chip is off.
 *
 * WORKING, IDLE and ENDED always show; every other word only when non-zero.
 * WAITING sessions stay counted in WORKING — they are still working, through
 * their moons.
 */
export function readoutSegments(counts: Record<SessionStatus, number>, planets: readonly ReadoutPlanet[]): ReadoutSegment[] {
  let asking = 0
  let interrupted = 0
  let settingUp = 0
  let notStarted = 0
  for (const p of planets) {
    if (p.muted || p.deviceOff) continue
    const key = sessionStateKey(p.session)
    if (key === 'setting_up') settingUp++
    else if (key === 'not_started') notStarted++
    else if (shownStatus(p.session) !== 'needs_input') continue
    else if (key === 'needs_input') asking++
    else if (key === 'interrupted') interrupted++
  }
  const done = counts.needs_input - asking - interrupted
  const some = (key: SessionStateKey, n: number, word: string): ReadoutSegment[] => (n > 0 ? [{ key, text: `${n} ${word}` }] : [])
  return [
    { key: 'working', text: `${counts.working} WORKING` },
    ...some('setting_up', settingUp, 'SETTING UP'),
    ...some('needs_input', asking, 'NEEDS INPUT'),
    ...some('interrupted', interrupted, 'INTERRUPTED'),
    ...some('not_started', notStarted, 'NOT STARTED'),
    ...some('done', done, 'DONE'),
    { key: 'idle', text: `${counts.idle} IDLE` },
    { key: 'ended', text: `${counts.ended} ENDED` },
  ]
}
