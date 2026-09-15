import type { ApiSession, SessionStatus, Subagent } from '../lib/types'
import type { OrbitalState } from '../store/store'
import { statusCounts, visibleSessions } from '../store/store'
import {
  clusterLabelPos,
  clusterSessions,
  layoutClusters,
  GOLDEN_ANGLE,
  PLANET_BASE_RADIUS,
} from './layout'

/**
 * Pure derivation of everything `<SpaceMap>` needs to render, from store
 * state. No React/three/WebGL imports here — this is what makes the scene
 * testable in jsdom (which has no WebGL): tests call `buildSceneModel`
 * directly and assert on plain data, never on the Canvas.
 */

/** Extra clearance kept between a planet's own edge and its innermost moon orbit. */
const MOON_ORBIT_MARGIN = 0.35
/** Radial gap between successive moons orbiting the same planet. */
const MOON_ORBIT_STEP = 0.28
/**
 * Angular spacing between successive moons' starting phase, reusing the
 * layout's golden angle so multiple moons around one planet start spread
 * out rather than stacked, deterministically (no Math.random).
 */
const MOON_PHASE_STEP = GOLDEN_ANGLE

export interface ScenePlanet {
  session: ApiSession
  x: number
  y: number
  scale: number
  selected: boolean
  hue: number
  /** This session's live subagents (also flattened into top-level `moons`). */
  subagents: Subagent[]
}

export interface SceneMoon {
  subagent: Subagent
  sessionId: string
  hue: number
  parentX: number
  parentY: number
  orbitRadius: number
  phase: number
}

export interface SceneLabel {
  text: string
  x: number
  y: number
  hue: number
}

export interface SceneModel {
  planets: ScenePlanet[]
  moons: SceneMoon[]
  labels: SceneLabel[]
  counts: Record<SessionStatus, number>
}

/**
 * Builds the render model for the space map: visible sessions laid out into
 * clusters, their moons (only for sessions with at least one live
 * subagent), cluster labels (`NAME · count`, uppercase), and status counts.
 *
 * Pure: same `state` in, same model out, every time — no Date.now, no
 * Math.random, no mutation of `state`.
 */
export function buildSceneModel(state: OrbitalState): SceneModel {
  const sessions = visibleSessions(state)
  const clusters = clusterSessions(sessions, state.tags)
  const positions = layoutClusters(clusters)
  const counts = statusCounts(state)
  const selectedId = state.ui.selectedId

  const planets: ScenePlanet[] = []
  const moons: SceneMoon[] = []

  for (const cluster of clusters) {
    for (const session of cluster.sessions) {
      const pos = positions.get(session.id)
      if (!pos) continue

      const subagents = state.subagents[session.id] ?? []

      planets.push({
        session,
        x: pos.x,
        y: pos.y,
        scale: pos.scale,
        selected: session.id === selectedId,
        hue: cluster.hue,
        subagents,
      })

      subagents.forEach((subagent, i) => {
        moons.push({
          subagent,
          sessionId: session.id,
          hue: cluster.hue,
          parentX: pos.x,
          parentY: pos.y,
          orbitRadius: pos.scale * PLANET_BASE_RADIUS + MOON_ORBIT_MARGIN + i * MOON_ORBIT_STEP,
          phase: i * MOON_PHASE_STEP,
        })
      })
    }
  }

  const labels: SceneLabel[] = clusters.map((cluster) => {
    const pos = clusterLabelPos(cluster, positions)
    return {
      text: `${cluster.label.toUpperCase()} · ${cluster.sessions.length}`,
      x: pos.x,
      y: pos.y,
      hue: cluster.hue,
    }
  })

  return { planets, moons, labels, counts }
}
