import type { ApiSession, SessionStatus, Subagent } from '../lib/types'
import { matchModel } from '../lib/models'
import type { OrbitalState } from '../store/store'
import { absorptionFor, mapSessions, statusCounts } from '../store/store'
import {
  clusterAnchors,
  clusterLabelPos,
  clusterSessions,
  holePosition,
  layoutClusters,
  GOLDEN_ANGLE,
  PLANET_BASE_RADIUS,
  type Cluster,
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
  /** The cluster's tag — the sim's grouping key for springs and separation. */
  tagId: number
  /** This session's live subagents (also flattened into top-level `moons`). */
  subagents: Subagent[]
  /**
   * The session's tag bond was just cut (manual dismissal, or the release
   * delay elapsed) and the body is falling into the hole. Still in the model
   * on purpose: the simulation plays the fall from wherever the body stands,
   * and `mapSessions` drops the session outright once its fall grace runs
   * out (spec 2026-09-18-tag-clusters-design § 4-5).
   */
  released: boolean
  /**
   * Family alone (`Opus`), drawn as a second label line — or null when the
   * map toggle is off or the model is not one the catalog knows. Never the
   * version: the map shows what kind of thing is running, not which build.
   */
  modelFamily: string | null
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
  /** The cluster's tag id — the label's true identity, and the stable key `<SpaceMap>` renders it with (not `text`, which is derived/formatted and best treated as opaque display content, not an identity). */
  tagId: number
  text: string
  x: number
  y: number
  hue: number
}

/** A tag's home spot — what the simulation's home-anchor spring pulls toward. */
export interface SceneAnchor {
  tagId: number
  hue: number
  x: number
  y: number
}

/** The corner hole: world-space position plus its label's session count. */
export interface SceneHole {
  x: number
  y: number
  /** Sessions in the index that are not drawn as bonded bodies — the "N sessions" of the label. */
  count: number
}

export interface SceneModel {
  planets: ScenePlanet[]
  moons: SceneMoon[]
  labels: SceneLabel[]
  counts: Record<SessionStatus, number>
  /** One per drawn cluster, keyed by tag — the sim's home anchors. */
  anchors: SceneAnchor[]
  hole: SceneHole
}

/**
 * Sorts each cluster's sessions by stable id (not the recency order
 * `visibleSessions` returns them in) before layout. `layoutClusters`
 * places a cluster's sessions on a golden-angle spiral purely by each
 * session's INDEX within `cluster.sessions` — so if that array's order
 * depends on `lastAt` (recency), a new message bumping one session's
 * `lastAt` reshuffles the index of every OTHER session in its cluster too,
 * making already-placed planets visibly "teleport" on the map even though
 * they themselves didn't change. Sorting by id first makes each session's
 * spiral index depend only on which sessions exist, never on their
 * recency — recency ordering still drives the sidebar list (via
 * `visibleSessions`) and `cluster.sessions` as returned to any other
 * caller; only the `positions` lookup below is computed from this
 * re-sorted copy.
 */
function withStableSessionOrder(clusters: Cluster[]): Cluster[] {
  return clusters.map((cluster) => ({
    ...cluster,
    sessions: [...cluster.sessions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }))
}

/**
 * Builds the render model for the space map: visible sessions laid out into
 * clusters, their moons (only for LIVE subagents — an `ended` subagent is
 * dropped from the model entirely; its `Moon` fade-out is a
 * component-level nicety this v1 scene model doesn't attempt), cluster
 * labels (`NAME · count`, uppercase), and status counts.
 *
 * Pure: same `state` and `nowMs` in, same model out, every time — no
 * Date.now, no Math.random, no mutation of `state`. The clock arrives as
 * `nowMs` precisely to keep that true; `useSceneModel` is what reads a real
 * clock and re-reads it on a slow tick.
 */
export function buildSceneModel(state: OrbitalState, nowMs: number): SceneModel {
  const sessions = mapSessions(state, nowMs)
  const clusters = clusterSessions(sessions, state.tags)
  const stable = withStableSessionOrder(clusters)
  const positions = layoutClusters(stable)
  const anchorByTag = clusterAnchors(stable)
  const counts = statusCounts(state, nowMs)
  const selectedId = state.ui.selectedId
  const isReleased = (session: ApiSession) =>
    absorptionFor(session, state.settings, nowMs) === 'releasing'
  const showModel = state.settings.map_show_model !== 'false'

  const planets: ScenePlanet[] = []
  const moons: SceneMoon[] = []

  for (const cluster of clusters) {
    for (const session of cluster.sessions) {
      const pos = positions.get(session.id)
      if (!pos) continue

      // Straight off the session: the server keeps this current for every
      // live session, so a moon no longer depends on the session being open.
      const subagents = session.subagents.filter((a) => a.state !== 'ended')

      planets.push({
        session,
        x: pos.x,
        y: pos.y,
        scale: pos.scale,
        selected: session.id === selectedId,
        hue: cluster.hue,
        tagId: cluster.tagId,
        subagents,
        released: isReleased(session),
        modelFamily: showModel ? (matchModel(session, state.models)?.family ?? null) : null,
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

  const labels: SceneLabel[] = []
  for (const cluster of clusters) {
    // Counts the bonded bodies, not everything the cluster holds — a
    // released body's bond is cut, so the chip stops claiming it (canvas
    // 4a's chips count what holds together). A cluster whose every body has
    // been released drops its label with them: `NAME · 0` hanging over
    // emptying space is clutter.
    const bonded = cluster.sessions.filter((s) => !isReleased(s))
    if (bonded.length === 0) continue
    // Anchored above the topmost planet still bonded, not above a falling
    // one — otherwise the label chases the fall.
    const pos = clusterLabelPos({ ...cluster, sessions: bonded }, positions)
    labels.push({
      tagId: cluster.tagId,
      text: `${cluster.label.toUpperCase()} · ${bonded.length}`,
      x: pos.x,
      y: pos.y,
      hue: cluster.hue,
    })
  }

  const anchors: SceneAnchor[] = []
  for (const cluster of clusters) {
    const anchor = anchorByTag.get(cluster.tagId)
    if (anchor) anchors.push({ tagId: cluster.tagId, hue: cluster.hue, ...anchor })
  }

  // The hole's label subtracts the bonded bodies from the index total: a
  // falling body is already the hole's, and a stale total must never read
  // negative.
  const bondedCount = planets.filter((p) => !p.released).length
  const holePos = holePosition(stable)
  const hole: SceneHole = {
    x: holePos.x,
    y: holePos.y,
    count: Math.max(0, state.sessionsTotal - bondedCount),
  }

  return { planets, moons, labels, counts, anchors, hole }
}
