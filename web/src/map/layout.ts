import type { ApiSession, Tag } from '../lib/types'

/**
 * Pure map layout math. No React/three imports, no Date.now/Math.random —
 * every function here must be deterministic: the same input always produces
 * the exact same output (bit-for-bit), so the map scene never "jumps"
 * between renders.
 */

export interface Cluster {
  tagId: number
  hue: number
  label: string
  /**
   * The tag's stored home spot (the user dropped the clump there), or null
   * for the automatic circle placement. Carried off the tag by
   * `clusterSessions`; `clusterAnchors` is where it takes effect.
   */
  anchor: { x: number; y: number } | null
  sessions: ApiSession[]
}

export interface PlanetPosition {
  x: number
  y: number
  scale: number
}

export interface LayoutOptions {
  /** Visual radius of a planet at scale 1.0, in layout units. */
  planetBaseRadius?: number
  /** Minimum empty clearance kept between any two planet edges. */
  minGap?: number
  /** Extra cushion added to the golden-angle spiral's spacing constant. */
  spiralSafetyMargin?: number
  /** Minimum empty clearance kept between two clusters' bounding circles. */
  clusterGap?: number
  /** Golden angle used for the in-cluster spiral, in radians. */
  goldenAngle?: number
}

// --- Documented constants -------------------------------------------------

/** Planet scale for a working / needs-input session (canvas 1a: 96px body). */
export const ACTIVE_SCALE = 1.0
/** Planet scale for an idle session (canvas 1a: 68px body → 68/96). */
export const IDLE_SCALE = 0.71
/** Planet scale for an ended session (canvas 1a: ~42px body → 42/96). */
export const ENDED_SCALE = 0.44

/**
 * Layout units are arbitrary (the map scene, Task 9, maps them to world
 * units). PLANET_BASE_RADIUS is the visual radius of a planet at
 * scale 1.0.
 */
export const PLANET_BASE_RADIUS = 1

/**
 * Minimum empty clearance kept between any two planet edges anywhere on the
 * map — used both for the in-cluster spiral spacing and for cluster
 * bounding-circle separation.
 */
export const MIN_GAP = 0.3

/**
 * Extra cushion added on top of the tight golden-angle spiral spacing
 * constant (see spiralSpacing below). Chosen empirically: for a Vogel/Fermat
 * "sunflower" spiral (radius_i = K * sqrt(i), angle_i = i * GOLDEN_ANGLE),
 * the tightest pair of points is always (i=0, i=1) — i=0 sits exactly at
 * the spiral's center, so its distance to i=1 is exactly K, independent of
 * angle. Every other pair (i,j >= 1) is separated further by the
 * golden-angle's irrationality (no resonant close returns). Setting
 * K = 2*PLANET_BASE_RADIUS*maxScale + MIN_GAP + SPIRAL_SAFETY_MARGIN keeps
 * that worst pair (and, empirically checked, every pair) at or beyond the
 * scale-derived min-distance floor. Verified by simulation for N up to 120
 * and a range of active/ended scale mixes (see task-7 report) — this is an
 * empirically-verified conservative bound, not a closed-form proof.
 */
export const SPIRAL_SAFETY_MARGIN = 0.2

/** Golden angle, in radians (~137.5deg), per spec. */
export const GOLDEN_ANGLE = 2.39996

/** Minimum empty clearance kept between two clusters' bounding circles. */
export const CLUSTER_GAP = 1.0

/** Vertical offset of a cluster's label anchor above its topmost planet. */
export const LABEL_MARGIN = 0.5

/**
 * How far past the cluster field's bounding circle the hole sits, in world
 * units, measured along the bottom-right diagonal. Comfortably beyond the
 * simulation's hole-repulsion halo (`HOLE_REPEL_RADIUS`, ~8.8 units), so a
 * resting clump is not permanently leaning on the repulsion.
 */
export const HOLE_CLEARANCE = 10

/** The hole sits on the bottom-right diagonal (canvas 4a: corner at 1210,752 of 1440×900). */
const HOLE_ANGLE = -Math.PI / 4

// --- clusterSessions --------------------------------------------------------

/**
 * Groups sessions by their primary tag — the first entry of `tagIds` that
 * resolves to a known tag. Sessions with no tags, or whose tagIds don't
 * resolve to any known tag, fall back to the default tag (`is_default`).
 * A session whose first tagId IS the default tag also lands in that same
 * fallback cluster. Clusters are sorted by tagId ascending, with the
 * default-tag cluster always last, regardless of its numeric id.
 */
export function clusterSessions(sessions: ApiSession[], tags: Tag[]): Cluster[] {
  const tagById = new Map(tags.map((t) => [t.id, t]))
  const defaultTag = tags.find((t) => t.is_default === 1)

  const groups = new Map<number, ApiSession[]>()
  for (const session of sessions) {
    const primaryTagId = session.tagIds.find((id) => tagById.has(id))
    const resolvedId = primaryTagId !== undefined ? primaryTagId : defaultTag?.id
    if (resolvedId === undefined) continue // no valid tag, and no default tag configured

    const existing = groups.get(resolvedId)
    if (existing) existing.push(session)
    else groups.set(resolvedId, [session])
  }

  const clusters: Cluster[] = []
  for (const [tagId, groupSessions] of groups) {
    const tag = tagById.get(tagId)
    if (!tag) continue
    clusters.push({
      tagId,
      hue: tag.hue,
      label: tag.name,
      // Both coordinates or nothing: a half-set pair (which the client never
      // writes) reads as no stored home rather than as a home at 0.
      anchor:
        tag.anchor_x != null && tag.anchor_y != null
          ? { x: tag.anchor_x, y: tag.anchor_y }
          : null,
      sessions: groupSessions,
    })
  }

  clusters.sort((a, b) => {
    const aIsDefault = a.tagId === defaultTag?.id
    const bIsDefault = b.tagId === defaultTag?.id
    if (aIsDefault !== bIsDefault) return aIsDefault ? 1 : -1
    return a.tagId - b.tagId
  })

  return clusters
}

// --- layoutClusters ---------------------------------------------------------

/** Exported for the `/sandbox` workbench, which replays the tier change on a lone planet. */
export function scaleFor(session: ApiSession): number {
  if (session.status === 'ended') return ENDED_SCALE
  if (session.status === 'idle') return IDLE_SCALE
  return ACTIVE_SCALE
}

function resolveOptions(opts?: LayoutOptions) {
  return {
    planetBaseRadius: opts?.planetBaseRadius ?? PLANET_BASE_RADIUS,
    minGap: opts?.minGap ?? MIN_GAP,
    spiralSafetyMargin: opts?.spiralSafetyMargin ?? SPIRAL_SAFETY_MARGIN,
    clusterGap: opts?.clusterGap ?? CLUSTER_GAP,
    goldenAngle: opts?.goldenAngle ?? GOLDEN_ANGLE,
  }
}

/** The golden-angle spiral's spacing constant K, for a given cluster. */
function spiralSpacing(cluster: Cluster, resolved: ReturnType<typeof resolveOptions>): number {
  const scales = cluster.sessions.map(scaleFor)
  const maxScale = scales.length > 0 ? Math.max(...scales) : ACTIVE_SCALE
  return 2 * resolved.planetBaseRadius * maxScale + resolved.minGap + resolved.spiralSafetyMargin
}

/** Lays a cluster's sessions out on a golden-angle spiral around `center`. */
function spiralPositions(
  cluster: Cluster,
  center: { x: number; y: number },
  resolved: ReturnType<typeof resolveOptions>
): Map<string, PlanetPosition> {
  const positions = new Map<string, PlanetPosition>()
  const spacing = spiralSpacing(cluster, resolved)

  cluster.sessions.forEach((session, i) => {
    const r = spacing * Math.sqrt(i)
    const theta = i * resolved.goldenAngle
    positions.set(session.id, {
      x: center.x + r * Math.cos(theta),
      y: center.y + r * Math.sin(theta),
      scale: scaleFor(session),
    })
  })

  return positions
}

/** Radius of the smallest circle, centered on `center`, containing every planet in the cluster. */
function boundingRadius(
  cluster: Cluster,
  positions: Map<string, PlanetPosition>,
  center: { x: number; y: number },
  planetBaseRadius: number
): number {
  let max = 0
  for (const session of cluster.sessions) {
    const p = positions.get(session.id)
    if (!p) continue
    const r = Math.hypot(p.x - center.x, p.y - center.y) + planetBaseRadius * p.scale
    if (r > max) max = r
  }
  return max
}

/**
 * Places clusters on a large circle around the origin, evenly spaced by
 * index (deterministic: `clusters` order in == placement order, and
 * `clusterSessions` already sorts that order by tagId ascending with the
 * default-tag cluster last). Within each cluster, sessions are placed on a
 * golden-angle spiral (`i * GOLDEN_ANGLE` radians, radius `∝ √i`),
 * with spacing derived from the cluster's planet scales so no two planet
 * centers land closer than their scale-derived min distance. The orbit
 * radius for cluster centers is derived from clusters' bounding-circle radii
 * so that no two clusters' bounding circles overlap.
 *
 * Pure: same `clusters` + `opts` in, same Map out, every time.
 */
export function layoutClusters(
  clusters: Cluster[],
  opts?: LayoutOptions
): Map<string, PlanetPosition> {
  const resolved = resolveOptions(opts)
  const result = new Map<string, PlanetPosition>()
  if (clusters.length === 0) return result

  const anchors = clusterAnchors(clusters, opts)
  for (const cluster of clusters) {
    const center = anchors.get(cluster.tagId)
    if (!center) continue
    const positions = spiralPositions(cluster, center, resolved)
    for (const [id, pos] of positions) result.set(id, pos)
  }

  return result
}

// --- clusterAnchors ---------------------------------------------------------

/**
 * Each tag's home spot: cluster centers evenly spaced on a circle around the
 * origin, exactly as `layoutClusters` has always placed them (deterministic:
 * `clusterSessions` sorts the input by tagId ascending, default last). These
 * are what the tag-cluster simulation's home-anchor springs pull toward, and
 * what the golden-angle spiral seeds new bodies around.
 *
 * Pure: same `clusters` + `opts` in, same Map out, every time.
 */
export function clusterAnchors(
  clusters: Cluster[],
  opts?: LayoutOptions
): Map<number, { x: number; y: number }> {
  const resolved = resolveOptions(opts)
  const anchors = new Map<number, { x: number; y: number }>()
  if (clusters.length === 0) return anchors

  const n = clusters.length
  const angleStep = n > 1 ? (2 * Math.PI) / n : 0

  // Lay each cluster out around its own local origin so we can measure its
  // bounding radius, then derive how far apart cluster centers need to be on
  // the shared orbit circle.
  const localPositions = clusters.map((cluster) => spiralPositions(cluster, { x: 0, y: 0 }, resolved))
  const localRadii = clusters.map((cluster, idx) =>
    boundingRadius(cluster, localPositions[idx], { x: 0, y: 0 }, resolved.planetBaseRadius)
  )

  let orbitRadius = 0
  if (n > 1) {
    const maxBoundingRadius = Math.max(...localRadii)
    // Adjacent cluster centers, angleStep apart on a circle of orbitRadius,
    // are `2 * orbitRadius * sin(angleStep / 2)` apart (chord length). That
    // must be at least the sum of the two (worst-case, both
    // maxBoundingRadius) bounding radii plus a clearance gap.
    orbitRadius = (2 * maxBoundingRadius + resolved.clusterGap) / (2 * Math.sin(angleStep / 2))
  }

  clusters.forEach((cluster, idx) => {
    // A stored home (the user dropped the clump there) beats the circle; the
    // circle position is still computed for everyone else, off the same
    // index, so moving one tag never reshuffles its neighbours.
    if (cluster.anchor) {
      anchors.set(cluster.tagId, { x: cluster.anchor.x, y: cluster.anchor.y })
      return
    }
    const theta = idx * angleStep
    anchors.set(cluster.tagId, {
      x: orbitRadius * Math.cos(theta),
      y: orbitRadius * Math.sin(theta),
    })
  })

  return anchors
}

// --- holePosition -----------------------------------------------------------

/**
 * Where the corner hole sits: on the bottom-right diagonal, `HOLE_CLEARANCE`
 * beyond the circle that bounds every cluster (anchor distance + that
 * cluster's own bounding radius). World-space and deterministic, so the hole
 * pans, zooms and fits with the map rather than floating over it.
 */
export function holePosition(
  clusters: Cluster[],
  opts?: LayoutOptions
): { x: number; y: number } {
  const resolved = resolveOptions(opts)
  const anchors = clusterAnchors(clusters, opts)

  let fieldRadius = 0
  for (const cluster of clusters) {
    const anchor = anchors.get(cluster.tagId)
    if (!anchor) continue
    const positions = spiralPositions(cluster, anchor, resolved)
    const r =
      Math.hypot(anchor.x, anchor.y) +
      boundingRadius(cluster, positions, anchor, resolved.planetBaseRadius)
    if (r > fieldRadius) fieldRadius = r
  }

  const distance = fieldRadius + HOLE_CLEARANCE
  return { x: distance * Math.cos(HOLE_ANGLE), y: distance * Math.sin(HOLE_ANGLE) }
}

// --- clusterLabelPos --------------------------------------------------------

/**
 * Anchor point for a cluster's label: directly above the cluster's topmost
 * (largest y) planet, offset by that planet's radius plus LABEL_MARGIN.
 */
export function clusterLabelPos(
  cluster: Cluster,
  positions: Map<string, PlanetPosition>,
  opts?: LayoutOptions
): { x: number; y: number } {
  const resolved = resolveOptions(opts)

  let topmost: PlanetPosition | null = null
  for (const session of cluster.sessions) {
    const p = positions.get(session.id)
    if (!p) continue
    if (!topmost || p.y > topmost.y) topmost = p
  }
  if (!topmost) return { x: 0, y: 0 }

  return {
    x: topmost.x,
    y: topmost.y + resolved.planetBaseRadius * topmost.scale + LABEL_MARGIN,
  }
}
