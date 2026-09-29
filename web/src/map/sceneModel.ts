import type { ApiSession, OrbitalModel, SessionStatus, Subagent } from '../lib/types'
import { matchModel } from '../lib/models'
import { compactingOf } from '../lib/compaction'
import { contextFractionFor, contextLevel, type ContextLevel } from '../lib/usage'
import { CONTEXT_GAUGE_OUTER, MOON_TICK_LENGTH, MOON_TICK_RADIUS, moonVisuals } from './visuals'
import type { OrbitalState } from '../store/store'
import {
  absorptionFor,
  mapSessions,
  matchesSidebarFilters,
  parseContextThresholds,
  parsePlanetScale,
  PLANET_SCALE_MAX,
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
/**
 * The edge moon orbits clear on a planet that draws a context gauge. The
 * gauge lives inside the planet's render group, which the planet-size
 * slider scales — while orbit radii deliberately never see the slider
 * (spec 2026-09-18-planet-size-design). So the clearance is taken against
 * the gauge at PLANET_SCALE_MAX, the largest the slider can draw it, and
 * the innermost trail stays outside the ring at every slider setting.
 */
const GAUGED_PLANET_EDGE = Math.max(PLANET_BASE_RADIUS, CONTEXT_GAUGE_OUTER * PLANET_SCALE_MAX)

/**
 * World-space orbit radius of a planet's `index`-th moon. Exported for the
 * sandbox, which draws moons without a scene model — one formula, no drift.
 *
 * `planetScale` is the Appearance multiplier the moon's body is drawn at.
 * It widens the step between orbits only; the innermost orbit keeps its
 * place (adr: orbit-step-clears-the-moon-at-any-planet-size).
 */
export function moonOrbitRadius(
  scale: number,
  index: number,
  gauged: boolean,
  planetScale = 1
): number {
  const edge = gauged ? GAUGED_PLANET_EDGE : PLANET_BASE_RADIUS
  return scale * edge + MOON_ORBIT_MARGIN + index * MOON_ORBIT_STEP * planetScale
}
/** How far a moon reaches from its centre at planet size 1: its working tick ring. */
export const MOON_EXTENT_RADIUS = MOON_TICK_RADIUS + MOON_TICK_LENGTH / 2
/** Empty space left between two moons on neighbouring orbits when they pass. */
const MOON_ORBIT_CLEARANCE = 0.08
/**
 * Radial gap between successive moons orbiting the same planet, at planet
 * size 1. Neighbouring orbits run at different angular speeds, so their
 * moons pass each other; the step is a whole moon across plus
 * `MOON_ORBIT_CLEARANCE`, or they overlap as they do.
 */
const MOON_ORBIT_STEP = 2 * MOON_EXTENT_RADIUS + MOON_ORBIT_CLEARANCE
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
   * The session just stopped holding its place on the map (it ended, or an
   * ended one lost its pin) and the planet is fading out where it stands.
   * Still in the model on purpose, so the fade can play; `mapSessions` drops
   * the session outright once its grace runs out (spec
   * 2026-09-24-sessions-end-only-by-hand-design § 3).
   */
  leaving: boolean
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
  /**
   * The session does not match the sidebar's tag filter or search
   * (`matchesSidebarFilters`). It stays on the map in its place — the layout
   * never sees either, so narrowing moves nothing — and is drawn muted
   * instead (ADR `search-mutes-planets-instead-of-hiding-them`). Always
   * false with no tag chosen and no query.
   */
  muted: boolean
  contextFill: ContextFill | null
  /**
   * When the session's running compaction started (epoch ms), or null when
   * the planet is not in the compacting state — `compactingOf` decides:
   * Orbital sessions only, over working and waiting, under needs-input (spec
   * 2026-09-28-context-compaction-design § Planet). A number rather than the
   * session's object, so the memoised planet compares it by value.
   */
  compactingSince: number | null
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
 *   never will be. Same ruling as the detail panel's `canShowContext`;
 * - the session has ended (canvas 1i: "ended · no gauge"). The detail panel
 *   deliberately differs here and keeps the last known fill: a crowded map
 *   is the reason to drop it, and the panel is not crowded;
 * - `contextFractionFor` has no honest fraction — nothing measured yet, or
 *   an unknown window. That half is shared with the panel, so the arc and
 *   the bar cannot read different numbers (clamping included; a clamped
 *   100 % stays `critical`, being above any threshold, which tops out at 99).
 *
 * Pure and exported so the derivation is unit-testable without a scene.
 */
export function contextFillFor(
  session: ApiSession,
  models: OrbitalModel[],
  settings: Record<string, string>,
  contextWindows: Record<string, number> = {}
): ContextFill | null {
  if (!showContext(settings)) return null
  if (session.source !== 'web') return null
  if (session.status === 'ended') return null
  const fraction = contextFractionFor(session, models, contextWindows)
  if (fraction === null) return null
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
  /** Its parent planet is muted by the sidebar filters — a muted planet's moons mute with it. */
  muted: boolean
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

/** The corner trash: world-space position plus its label's session count. */
export interface SceneHole {
  x: number
  y: number
  /** Sessions in the index the map does not draw (a leaving body counts already) — the "N sessions" of the label. */
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
 * Hands each planet of a freshly built `model` the `contextFill` object the
 * `previous` model gave it, wherever the two say the same thing. `Planet` is
 * memoised on shallow props, and `buildSceneModel` allocates a new fill for
 * every gauged planet on every build — so without this one session's event
 * re-rendered every gauged planet on the map. Writes into `model`, which the
 * caller has only just built and nobody else holds yet.
 */
export function reuseContextFills(model: SceneModel, previous: SceneModel | null): SceneModel {
  if (!previous) return model
  const held = new Map<string, ContextFill>()
  for (const p of previous.planets) if (p.contextFill) held.set(p.session.id, p.contextFill)
  for (const p of model.planets) {
    const before = held.get(p.session.id)
    if (before && p.contextFill && before.fraction === p.contextFill.fraction && before.level === p.contextFill.level) {
      p.contextFill = before
    }
  }
  return model
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
 * Builds the render model for the space map: the map's sessions
 * (`mapSessions` — the tag filter and search do not narrow them, they only
 * mute planets) laid out into clusters, their moons, cluster labels
 * (`NAME · count`, uppercase, counting the layout — muted planets included),
 * and status counts (filter matches only — `statusCounts`).
 *
 * Moons are drawn for RUNNING subagents only: a moon leaves the map the
 * moment its agent ends (spec 2026-09-24-subagent-list-design.md § 5). The
 * map shows what is running; the finished record lives in the detail
 * panel's subagent list and the parent transcript's `OPEN →` row, both of
 * which read the session's full `subagents` — so this filter is the map's
 * alone and must not move upstream. The planet's footprint and orbit
 * spacing follow the running count, because they are built from the same
 * filtered list.
 *
 * `awaitingSubagentCount` (`lib/types.ts`) carries a `state !== 'ended'`
 * filter of its own, for its own reason — it answers "is the parent still
 * waiting", not "what is drawn" — so neither filter stands in for the other.
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
  const isLeaving = (session: ApiSession) =>
    absorptionFor(session, nowMs, state.leavingSince[session.id]) === 'leaving'
  const showModel = state.settings.map_show_model !== 'false'
  const planets: ScenePlanet[] = []
  const moons: SceneMoon[] = []
  const planetScale = parsePlanetScale(state.settings)

  for (const cluster of clusters) {
    for (const session of cluster.sessions) {
      const pos = positions.get(session.id)
      if (!pos) continue

      // Straight off the session: the server keeps this current for every
      // live session, so a moon no longer depends on the session being open.
      // Running agents only — finished moons leave the map (see this
      // function's own doc).
      const subagents = session.subagents.filter((a) => a.state !== 'ended')
      const muted = !matchesSidebarFilters(session, state.ui)

      // Moons first: the planet's footprint is the outermost shell they
      // reach, and that is what the planet is then placed by.
      const contextFill = contextFillFor(session, state.models, state.settings, state.contextWindows)
      let footprint = pos.scale * PLANET_BASE_RADIUS
      subagents.forEach((subagent, i) => {
        const orbitRadius = moonOrbitRadius(pos.scale, i, contextFill !== null, planetScale)
        moons.push({
          subagent,
          sessionId: session.id,
          hue: cluster.hue,
          parentX: pos.x,
          parentY: pos.y,
          orbitRadius,
          phase: i * MOON_PHASE_STEP,
          muted,
        })
        // Measured to the moon's own edge, not to the dashed trail it rides,
        // and at the size the body is drawn.
        const shell = orbitRadius + moonVisuals(subagent.state).discRadius * planetScale
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
        leaving: isLeaving(session),
        modelFamily: showModel ? (matchModel(session, state.models)?.family ?? null) : null,
        contextFill,
        muted,
        compactingSince: compactingOf(session)?.startedAt ?? null,
      })
    }
  }

  const labels: SceneLabel[] = []
  for (const cluster of clusters) {
    // Counts the bodies that stay, not everything the cluster holds — a
    // leaving body is already gone as far as the chip is concerned (canvas
    // 4a's chips count what holds together). A cluster whose every body is
    // leaving drops its label with them: `NAME · 0` hanging over emptying
    // space is clutter.
    const bonded = cluster.sessions.filter((s) => !isLeaving(s))
    if (bonded.length === 0) continue
    // Anchored above the topmost planet that stays, not above a fading one
    // — otherwise the label would jump when the fade ends.
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

  // The trash's label subtracts the bodies that stay from the index total: a
  // leaving body already counts as not drawn, and a stale total must never
  // read negative.
  const bondedCount = planets.filter((p) => !p.leaving).length
  const holePos = holePosition(stable)
  const hole: SceneHole = {
    x: holePos.x,
    y: holePos.y,
    count: Math.max(0, state.sessionsTotal - bondedCount),
  }

  return { planets, moons, labels, counts, anchors, hole }
}
