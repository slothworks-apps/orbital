import { describe, it, expect } from 'vitest'
import type { ApiSession, Tag } from '../lib/types'
import {
  clusterSessions,
  layoutClusters,
  clusterLabelPos,
  ACTIVE_SCALE,
  IDLE_SCALE,
  ENDED_SCALE,
  PLANET_BASE_RADIUS,
  MIN_GAP,
} from '../map/layout'

function makeSession(overrides: Partial<ApiSession> & { id: string }): ApiSession {
  return {
    cwd: '/home/a',
    title: 'Session',
    firstAt: 1,
    lastAt: 100,
    messageCount: 1,
    source: 'web',
    permissionMode: null,
    parentId: null,
    tagIds: [],
    status: 'idle',
    subagents: [],
    ...overrides,
  }
}

const workTag: Tag = { id: 1, name: 'WORK', hue: 210, is_default: 0 }
const personalTag: Tag = { id: 2, name: 'PERSONAL', hue: 330, is_default: 0 }
const defaultTag: Tag = { id: 3, name: 'UNTAGGED', hue: 0, is_default: 1 }
const tags: Tag[] = [workTag, personalTag, defaultTag]

describe('clusterSessions', () => {
  it('groups sessions by primary (first) tag', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1] }),
      makeSession({ id: 'b', tagIds: [1, 2] }),
      makeSession({ id: 'c', tagIds: [2] }),
    ]
    const clusters = clusterSessions(sessions, tags)
    const work = clusters.find((c) => c.tagId === 1)
    const personal = clusters.find((c) => c.tagId === 2)
    expect(work?.sessions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(personal?.sessions.map((s) => s.id)).toEqual(['c'])
  })

  it('falls back untagged sessions to the default tag cluster', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [] }),
      makeSession({ id: 'b', tagIds: [1] }),
    ]
    const clusters = clusterSessions(sessions, tags)
    const fallback = clusters.find((c) => c.tagId === defaultTag.id)
    expect(fallback?.sessions.map((s) => s.id)).toEqual(['a'])
  })

  it('sorts the default tag cluster last, others by tagId ascending', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [] }),
      makeSession({ id: 'b', tagIds: [2] }),
      makeSession({ id: 'c', tagIds: [1] }),
    ]
    const clusters = clusterSessions(sessions, tags)
    expect(clusters.map((c) => c.tagId)).toEqual([1, 2, 3])
  })

  it('sets cluster hue and label from the tag', () => {
    const sessions = [makeSession({ id: 'a', tagIds: [1] })]
    const clusters = clusterSessions(sessions, tags)
    const work = clusters.find((c) => c.tagId === 1)
    expect(work?.hue).toBe(210)
    expect(work?.label).toBe('WORK')
  })

  it('excludes empty clusters (no sessions map to that tag)', () => {
    const sessions = [makeSession({ id: 'a', tagIds: [1] })]
    const clusters = clusterSessions(sessions, tags)
    expect(clusters.find((c) => c.tagId === 2)).toBeUndefined()
  })

  it('treats a session whose first tagId IS the default tag as the fallback cluster', () => {
    const sessions = [makeSession({ id: 'a', tagIds: [3] })]
    const clusters = clusterSessions(sessions, tags)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].tagId).toBe(defaultTag.id)
    expect(clusters[0].sessions.map((s) => s.id)).toEqual(['a'])
  })
})

describe('layoutClusters', () => {
  it('is pure and deterministic: two calls on the same input produce identical output', () => {
    const sessions = Array.from({ length: 12 }, (_, i) =>
      makeSession({
        id: `s${i}`,
        tagIds: [i % 2 === 0 ? 1 : 2],
        status: i % 3 === 0 ? 'ended' : 'working',
      })
    )
    const clusters = clusterSessions(sessions, tags)
    const first = layoutClusters(clusters)
    const second = layoutClusters(clusterSessions(sessions, tags))
    expect(Array.from(second.entries())).toEqual(Array.from(first.entries()))
  })

  it('assigns canvas size tiers: working/needs_input 1.0, idle 0.71, ended 0.44', () => {
    const sessions = [
      makeSession({ id: 'active', tagIds: [1], status: 'working' }),
      makeSession({ id: 'idle', tagIds: [1], status: 'idle' }),
      makeSession({ id: 'needs', tagIds: [1], status: 'needs_input' }),
      makeSession({ id: 'ended', tagIds: [1], status: 'ended' }),
    ]
    const clusters = clusterSessions(sessions, tags)
    const positions = layoutClusters(clusters)
    expect(positions.get('active')?.scale).toBe(ACTIVE_SCALE)
    expect(positions.get('idle')?.scale).toBe(IDLE_SCALE)
    expect(positions.get('needs')?.scale).toBe(ACTIVE_SCALE)
    expect(positions.get('ended')?.scale).toBe(ENDED_SCALE)
    expect(ACTIVE_SCALE).toBe(1.0)
    expect(IDLE_SCALE).toBe(0.71)
    expect(ENDED_SCALE).toBe(0.44)
  })

  it('places sessions within a cluster on a golden-angle spiral (radius grows with sqrt(i))', () => {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      makeSession({ id: `s${i}`, tagIds: [1], status: 'working' })
    )
    const clusters = clusterSessions(sessions, tags)
    const positions = layoutClusters(clusters)

    // First session sits at the cluster center (i=0 -> r=0); radius grows
    // monotonically with i since all sessions here share the same scale
    // (so the spiral's spacing constant is fixed).
    const p0 = positions.get('s0')!
    const radii = sessions.map((s) => {
      const p = positions.get(s.id)!
      return Math.hypot(p.x - p0.x, p.y - p0.y)
    })
    expect(radii[0]).toBe(0)
    let prevR = -1
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThan(prevR)
      prevR = radii[i]
    }
  })

  it('never places two planet centers within scale-derived min distance (N=30 mixed fixture)', () => {
    // 30 sessions in one cluster, alternating active/ended and a couple of extra
    // patterns mixed in, to stress the golden-angle spiral packing.
    const sessions = Array.from({ length: 30 }, (_, i) =>
      makeSession({
        id: `s${i}`,
        tagIds: [1],
        status: i % 3 === 0 ? 'ended' : i % 7 === 0 ? 'needs_input' : 'working',
      })
    )
    const clusters = clusterSessions(sessions, tags)
    const positions = layoutClusters(clusters)
    const entries = sessions.map((s) => ({ id: s.id, ...positions.get(s.id)! }))

    // Minimum-distance floor: two planet edges (radius = PLANET_BASE_RADIUS * scale)
    // must never overlap, plus a fixed clearance gap (MIN_GAP), both documented
    // constants exported from layout.ts.
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]
        const b = entries[j]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const floor = PLANET_BASE_RADIUS * (a.scale + b.scale) + MIN_GAP
        expect(dist).toBeGreaterThanOrEqual(floor - 1e-9)
      }
    }
  })

  it('separates clusters so their bounding circles never overlap', () => {
    const sessions = [
      ...Array.from({ length: 10 }, (_, i) =>
        makeSession({ id: `w${i}`, tagIds: [1], status: 'working' })
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeSession({ id: `p${i}`, tagIds: [2], status: 'working' })
      ),
    ]
    const clusters = clusterSessions(sessions, tags)
    const positions = layoutClusters(clusters)

    function boundingCircle(clusterSessionIds: string[]) {
      const pts = clusterSessionIds.map((id) => positions.get(id)!)
      const cx = pts.reduce((sum, p) => sum + p.x, 0) / pts.length
      const cy = pts.reduce((sum, p) => sum + p.y, 0) / pts.length
      const radius = Math.max(
        ...pts.map((p) => Math.hypot(p.x - cx, p.y - cy) + PLANET_BASE_RADIUS * p.scale)
      )
      return { cx, cy, radius }
    }

    const workCircle = boundingCircle(clusters.find((c) => c.tagId === 1)!.sessions.map((s) => s.id))
    const personalCircle = boundingCircle(
      clusters.find((c) => c.tagId === 2)!.sessions.map((s) => s.id)
    )
    const centerDist = Math.hypot(workCircle.cx - personalCircle.cx, workCircle.cy - personalCircle.cy)
    expect(centerDist).toBeGreaterThan(workCircle.radius + personalCircle.radius)
  })

  it('places clusters deterministically by tagId order (default tag cluster last)', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [] }),
      makeSession({ id: 'b', tagIds: [2] }),
      makeSession({ id: 'c', tagIds: [1] }),
    ]
    const clusters = clusterSessions(sessions, tags)
    expect(clusters.map((c) => c.tagId)).toEqual([1, 2, 3])
    // layout is a pure function of clusters' order; re-running with the same
    // (already sorted) clusters array yields the same map every time.
    const p1 = layoutClusters(clusters)
    const p2 = layoutClusters(clusters)
    expect(Array.from(p1.entries())).toEqual(Array.from(p2.entries()))
  })
})

describe('clusterLabelPos', () => {
  it('anchors above the cluster topmost planet', () => {
    const sessions = Array.from({ length: 6 }, (_, i) =>
      makeSession({ id: `s${i}`, tagIds: [1], status: 'working' })
    )
    const clusters = clusterSessions(sessions, tags)
    const positions = layoutClusters(clusters)
    const cluster = clusters[0]

    const clusterPositions = cluster.sessions.map((s) => positions.get(s.id)!)
    const topmostY = Math.max(...clusterPositions.map((p) => p.y))

    const label = clusterLabelPos(cluster, positions)
    expect(label.y).toBeGreaterThan(topmostY)
  })

  it('is deterministic for the same input', () => {
    const sessions = Array.from({ length: 6 }, (_, i) =>
      makeSession({ id: `s${i}`, tagIds: [1], status: 'working' })
    )
    const clusters = clusterSessions(sessions, tags)
    const positions = layoutClusters(clusters)
    const cluster = clusters[0]
    expect(clusterLabelPos(cluster, positions)).toEqual(clusterLabelPos(cluster, positions))
  })
})
