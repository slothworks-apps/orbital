import type { ApiSession, OrbitalModel, SessionStatus, Subagent } from '../lib/types'
import { contextWindowFor, matchModel } from '../lib/models'
import { contextLevel, type ContextLevel } from '../lib/usage'
import { moonVisuals } from './visuals'
import type { OrbitalState } from '../store/store'
import {
  absorptionFor,
  mapSessions,
  parseContextThresholds,
  showContext,
  statusCounts,
} from '../store/store'
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
   * How much room the body actually takes up, in layout units: its own
   * layout radius, or the outermost moon shell when the moon system reaches
   * further. This — not the bare planet radius — is what the simulation
   * separates bodies by, so a session that spawns subagents pushes its
   * neighbours out instead of growing its moon system through them.
   */
  footprint: number
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
  /**
   * How full the session's context window is, for the arc around the planet
   * (spec `context-fill-arc`) — or null when there is nothing honest to
   * draw, which `contextFillFor` below enumerates. Null is "no gauge at
   * all", never "an empty one".
   */
  contextFill: ContextFill | null
}

/** A planet's context arc: how far round it goes, and what colour it is. */
export interface ContextFill {
  /** 0–1, clamped — see `contextFillFor`. */
  fraction: number
  level: ContextLevel
}

/**
 * The context arc for one session, or null when it gets none. Null wins for
 * every one of these, in order:
 *
 * - the map's master toggle is off (`map_show_context`);
 * - the session is one Orbital only WATCHES (`source: 'terminal'`) — the
 *   indexer reads no usage from a transcript, so there is no numerator and
 *   never will be. Same ruling as the detail panel's `canShowUsage`;
 * - the session has ended (canvas 1i: "ended · no gauge");
 * - nothing has measured its context yet (`contextUsedTokens` null — a fresh
 *   session, or one whose last compaction did not report its size);
 * - its context window is unknown, per `docs/decisions/models-come-from-the-sdk.md`:
 *   a gauge against an invented denominator is worse than no gauge.
 *
 * The fraction is clamped to [0, 1]: a window learned smaller than the
 * session's actual use would otherwise sweep the arc past a full turn, and
 * "more than full" is still just full (it stays `critical`, since a clamped
 * 100 % is above any threshold, which tops out at 99).
 *
 * Pure and exported so the derivation is unit-testable without a scene.
 */
export function contextFillFor(
  session: ApiSession,
  models: OrbitalModel[],
  settings: Record<string, string>
): ContextFill | null {
  if (!showContext(settings)) return null
  if (session.source !== 'web') return null
  if (session.status === 'ended') return null
  const used = session.contextUsedTokens
  if (used == null || !Number.isFinite(used)) return null
  const window = contextWindowFor(session, models)
  if (window === null || window <= 0) return null
  const fraction = Math.min(1, Math.max(0, used / window))
  return { fraction, level: contextLevel(fraction, parseContextThresholds(settings)) }
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

      // Moons first: the planet's footprint is the outermost shell they
      // reach, and that is what the planet is then placed by.
      let footprint = pos.scale * PLANET_BASE_RADIUS
      subagents.forEach((subagent, i) => {
        const orbitRadius = pos.scale * PLANET_BASE_RADIUS + MOON_ORBIT_MARGIN + i * MOON_ORBIT_STEP
        moons.push({
          subagent,
          sessionId: session.id,
          hue: cluster.hue,
          parentX: pos.x,
          parentY: pos.y,
          orbitRadius,
          phase: i * MOON_PHASE_STEP,
        })
        // Measured to the moon's own edge, not to the dashed trail it rides.
        const shell = orbitRadius + moonVisuals(subagent.state).discRadius
        if (shell > footprint) footprint = shell
      })

      planets.push({
        session,
        x: pos.x,
        y: pos.y,
        scale: pos.scale,
        selected: session.id === selectedId,
        hue: cluster.hue,
        tagId: cluster.tagId,
        subagents,
        footprint,
        released: isReleased(session),
        modelFamily: showModel ? (matchModel(session, state.models)?.family ?? null) : null,
        contextFill: contextFillFor(session, state.models, state.settings),
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
