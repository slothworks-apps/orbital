import type { ApiSession, OrbitalModel, SessionStatus, Subagent } from '../lib/types'
import { matchModel } from '../lib/models'
import { loginWaitLabels } from '../lib/profileLogin'
import { compactingOf } from '../lib/compaction'
import { contextFractionFor, contextLevel, type ContextLevel } from '../lib/usage'
import { CONTEXT_GAUGE_OUTER, MOON_TICK_LENGTH, MOON_TICK_RADIUS, moonVisuals } from './visuals'
import type { OrbitalState } from '../store/store'
import { moonOrbits } from '../lib/experimental'
import { placeMoons, type MoonSlot } from './moonSlots'
import { asOfLabel, deviceOf, machineOffline } from '../lib/devices'
import {
  absorptionFor,
  mapSessions,
  matchesSidebarFilters,
  hiddenDevices,
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
 * The smallest angle two moons on one orbit may sit apart: a whole moon
 * across plus `MOON_ORBIT_CLEARANCE` as a chord — the same distance
 * `MOON_ORBIT_STEP` keeps between orbits.
 */
function moonSeparation(orbitRadius: number, planetScale: number): number {
  const chord = MOON_ORBIT_STEP * planetScale
  return 2 * Math.asin(Math.min(1, chord / (2 * orbitRadius)))
}

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
   * The device the session runs on, by name, while names show on labels
   * (`namesShown`, canvas 50e/50h) — this device's own name for a session of
   * its own. Null while they do not.
   */
  deviceName: string | null
  /**
   * The session's device is offline and dated, so its labels close with
   * `as of 2 h` (`asOfLabel`). The age itself is not here: it ticks on its
   * own clock where it is drawn (`WithAge`), so the minute passing does not
   * rebuild the scene.
   */
  dated: boolean
  /**
   * The planet's second label line, as drawn (`planetSecondLine`), short of
   * the age `dated` adds: the family in capitals, then the device name — or
   * null for none.
   */
  secondLine: string | null
  /**
   * The second line the layout measures (`planetOutline`): `secondLine` with
   * the device name in it whenever the chip row shows, drawn or not, and
   * without the age. Names come and go as chips are turned on and off, the
   * age as a device drops and as the clock ticks; measuring the one always
   * and the other never keeps the bodies where they are (canvas 50e:
   * nothing reflows).
   */
  outlineLine: string | null
  /**
   * The pill under the name while the session waits on its profile's login
   * (`loginWaitLabels`; spec 2026-10-21-log-in-from-orbital-design § 3,
   * canvas 62a): `log in · Work profile`, `logging in · Pixel 8`. Null
   * otherwise, and under a limit wait, whose own pill wins.
   */
  loginPill: string | null
  /**
   * The session's device is offline: the planet keeps its place and its last
   * state, at half opacity and without motion (canvas 50e).
   */
  offline: boolean
  /**
   * The chip of the session's device is off (`hiddenDevices`). The planet
   * stays in the layout — nothing reflows when a chip goes off — and fades
   * out where it stands; the renderer stops drawing it once it has.
   */
  deviceOff: boolean
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
  /** Which of its planet's orbits it rides, 0 the innermost (`placeMoons`). */
  orbit: number
  phase: number
  /** The first moon on its orbit draws the orbit's dashed trail; the rest share it. */
  drawTrail: boolean
  /** Its parent planet is muted by the sidebar filters — a muted planet's moons mute with it. */
  muted: boolean
  /** Its parent's device is offline: the moon holds still, at half opacity, with its planet. */
  offline: boolean
  /** Its parent's device chip is off: the moon fades out with its planet. */
  deviceOff: boolean
}

export interface SceneLabel {
  /** The cluster's tag id — the label's true identity, and the stable key `<SpaceMap>` renders it with (not `text`, which is derived/formatted and best treated as opaque display content, not an identity). */
  tagId: number
  text: string
  x: number
  y: number
  hue: number
  /**
   * Every body the label counts is on a device whose chip is off: the label
   * fades out with them, and Desk keeps the mat, empty (canvas 50h).
   */
  empty: boolean
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
 * The device names a scene draws, while the chip row shows (`showDeviceRow`):
 * this device's own name, and whether labels carry names now (`namesShown`).
 */
export interface DeviceNames {
  self: string
  shown: boolean
}

/**
 * A planet's second label line (canvas 50e `p(dev, model)`): the family in
 * capitals, then the device name while names show; `WithAge` closes it with
 * `as of 2 h` while the device is offline. With the model line off the device
 * name stands alone; null when there is nothing to say.
 */
export function planetSecondLine(modelFamily: string | null, deviceName: string | null): string | null {
  const parts = [modelFamily?.toUpperCase(), deviceName].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * A Desk card's meta line (canvas 50h `card(o)`): the device name leads it
 * while names show, then the branch and the family; `WithAge` closes it with
 * `as of 2 h` while the device is offline. Null when there is nothing to say.
 */
export function deskCardMeta(
  gitRef: string | null | undefined,
  modelFamily: string | null,
  deviceName: string | null,
): string | null {
  const parts = [deviceName, gitRef, modelFamily].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' · ') : null
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
 * clock and re-reads it on a slow tick. `hidden` (the devices whose chip is
 * off, `hiddenDevices`) and `names` (`DeviceNames`, null while the chip row
 * does not show) are passed in for the same reason.
 *
 * A hidden device's sessions stay in the layout, marked `deviceOff`, so
 * turning a chip off moves nothing else (canvas 50e); the counts and the
 * cluster labels leave them out.
 */
export function buildSceneModel(
  state: OrbitalState,
  nowMs: number,
  hidden: readonly string[] = hiddenDevices(state),
  names: DeviceNames | null = null,
  previousMoons: readonly SceneMoon[] = [],
): SceneModel {
  const sessions = mapSessions(state, nowMs, [])
  const clusters = clusterSessions(sessions, state.tags)
  const stable = withStableSessionOrder(clusters)
  const positions = layoutClusters(stable)
  const anchorByTag = clusterAnchors(stable)
  const counts = statusCounts(state, nowMs, hidden)
  const selectedId = state.ui.selectedId
  const isLeaving = (session: ApiSession) =>
    absorptionFor(session, nowMs, state.leavingSince[session.id]) === 'leaving'
  const isDeviceOff = (session: ApiSession) => hidden.length > 0 && hidden.includes(deviceOf(session))
  const showModel = state.settings.map_show_model !== 'false'
  const planets: ScenePlanet[] = []
  const moons: SceneMoon[] = []
  const planetScale = parsePlanetScale(state.settings)
  const maxOrbits = moonOrbits(state.settings)
  const previousSlots = new Map<string, Map<string, MoonSlot>>()
  for (const moon of previousMoons) {
    let slots = previousSlots.get(moon.sessionId)
    if (!slots) previousSlots.set(moon.sessionId, (slots = new Map()))
    slots.set(moon.subagent.id, { orbit: moon.orbit, phase: moon.phase })
  }

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
      const offline = machineOffline(session)
      const deviceOff = isDeviceOff(session)

      // Moons first: the planet's footprint is the outermost shell they
      // reach, and that is what the planet is then placed by.
      const contextFill = contextFillFor(session, state.models, state.settings, state.contextWindows)
      let footprint = pos.scale * PLANET_BASE_RADIUS
      const radiusOf = (orbit: number) =>
        moonOrbitRadius(pos.scale, orbit, contextFill !== null, planetScale)
      const slots = placeMoons(
        subagents.map((a) => a.id),
        previousSlots.get(session.id) ?? new Map(),
        maxOrbits,
        (orbit) => moonSeparation(radiusOf(orbit), planetScale)
      )
      const trailed = new Set<number>()
      subagents.forEach((subagent) => {
        const { orbit, phase } = slots.get(subagent.id)!
        const orbitRadius = radiusOf(orbit)
        const drawTrail = !trailed.has(orbit)
        trailed.add(orbit)
        moons.push({
          subagent,
          sessionId: session.id,
          hue: cluster.hue,
          parentX: pos.x,
          parentY: pos.y,
          orbitRadius,
          orbit,
          phase,
          drawTrail,
          muted,
          offline,
          deviceOff,
        })
        // Measured to the moon's own edge, not to the dashed trail it rides,
        // and at the size the body is drawn.
        const shell = orbitRadius + moonVisuals(subagent.state).discRadius * planetScale
        if (shell > footprint) footprint = shell
      })

      const modelFamily = showModel ? (matchModel(session, state.models)?.family ?? null) : null
      const rowName = names === null ? null : (session.machine?.name ?? names.self)
      const deviceName = names?.shown ? rowName : null
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
        modelFamily,
        deviceName,
        dated: asOfLabel(session.machine, nowMs) !== null,
        secondLine: planetSecondLine(modelFamily, deviceName),
        // No age: going offline and the minute tick must not move a body.
        outlineLine: planetSecondLine(modelFamily, rowName),
        loginPill: loginPillOf(session, state.claudeDirs),
        offline,
        deviceOff,
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
    // A body whose device chip is off is not counted either, but a cluster
    // left with only such bodies keeps its label, `empty`, so it can fade
    // with them and Desk keeps the mat in its place.
    const on = bonded.filter((s) => !isDeviceOff(s))
    // Anchored above the topmost planet that stays, not above a fading one
    // — otherwise the label would jump when the fade ends.
    const pos = clusterLabelPos({ ...cluster, sessions: on.length > 0 ? on : bonded }, positions)
    labels.push({
      tagId: cluster.tagId,
      text: `${cluster.label.toUpperCase()} · ${on.length}`,
      x: pos.x,
      y: pos.y,
      hue: cluster.hue,
      empty: on.length === 0,
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
  // A body whose device chip is off is not drawn either.
  const bondedCount = planets.filter((p) => !p.leaving && !p.deviceOff).length
  const holePos = holePosition(stable)
  const hole: SceneHole = {
    x: holePos.x,
    y: holePos.y,
    count: Math.max(0, state.sessionsTotal - bondedCount),
  }

  return { planets, moons, labels, counts, anchors, hole }
}

/**
 * The model without the bodies whose device chip is off, for a renderer that
 * draws no fade for them (Archipelago): they simply leave, and the labels
 * of the clusters they emptied with them.
 */
export function withoutDeviceOff(model: SceneModel): SceneModel {
  if (!model.planets.some((p) => p.deviceOff)) return model
  return {
    ...model,
    planets: model.planets.filter((p) => !p.deviceOff),
    moons: model.moons.filter((m) => !m.deviceOff),
    labels: model.labels.filter((l) => !l.empty),
  }
}

/**
 * A waiting session's login pill (`ScenePlanet.loginPill`). The profile is
 * named only for this device's own sessions: another device's profile ids
 * are its own and would name one of this device's by accident.
 */
function loginPillOf(session: ApiSession, dirs: OrbitalState['claudeDirs']): string | null {
  const wait = session.loginWait
  if (!wait || session.limitWait) return null
  const name = session.machine ? null : (dirs.find((d) => d.id === wait.claudeDirId)?.name ?? null)
  return loginWaitLabels(wait, name).pill
}
