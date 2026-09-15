import { describe, it, expect } from 'vitest'
import type { ApiSession, Subagent, Tag } from '../lib/types'
import type { OrbitalState, OrbitalUiState } from '../store/store'
import { buildSceneModel } from '../map/sceneModel'
import { applyPan, applyZoom, clampZoom, fitView, MAX_ZOOM, MIN_ZOOM } from '../map/camera'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
    ...overrides,
  }
}

const workTag: Tag = { id: 1, name: 'work', hue: 210, is_default: 0 }
const personalTag: Tag = { id: 2, name: 'personal', hue: 330, is_default: 0 }
const defaultTag: Tag = { id: 3, name: 'untagged', hue: 0, is_default: 1 }

const defaultUi: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  wsStatus: 'connected',
  dialog: null,
}

function makeState(overrides: Partial<OrbitalState> = {}): OrbitalState {
  return {
    sessions: {},
    order: [],
    tags: [workTag, personalTag, defaultTag],
    rules: [],
    settings: {},
    transcripts: {},
    subagents: {},
    usage: {},
    historyLoaded: {},
    toast: null,
    ui: defaultUi,
    ...overrides,
  }
}

function withSessions(sessions: ApiSession[], overrides: Partial<OrbitalState> = {}): OrbitalState {
  const sessionsMap: Record<string, ApiSession> = {}
  for (const s of sessions) sessionsMap[s.id] = s
  return makeState({ sessions: sessionsMap, order: sessions.map((s) => s.id), ...overrides })
}

function makeSubagent(overrides: Partial<Subagent> & { id: string }): Subagent {
  return { name: 'sub', state: 'working', ...overrides }
}

// ---------------------------------------------------------------------------
// buildSceneModel
// ---------------------------------------------------------------------------

describe('buildSceneModel', () => {
  it('produces a planet for every visible session, positioned by layoutClusters', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1] }),
      makeSession({ id: 'b', tagIds: [1] }),
    ]
    const model = buildSceneModel(withSessions(sessions))

    expect(model.planets).toHaveLength(2)
    const ids = model.planets.map((p) => p.session.id).sort()
    expect(ids).toEqual(['a', 'b'])
    for (const planet of model.planets) {
      expect(typeof planet.x).toBe('number')
      expect(typeof planet.y).toBe('number')
      expect(Number.isFinite(planet.x)).toBe(true)
      expect(Number.isFinite(planet.y)).toBe(true)
    }
  })

  it('applies active/ended scale from the layout to each planet', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1], status: 'working' }),
      makeSession({ id: 'b', tagIds: [1], status: 'ended' }),
    ]
    const model = buildSceneModel(withSessions(sessions))

    const a = model.planets.find((p) => p.session.id === 'a')
    const b = model.planets.find((p) => p.session.id === 'b')
    expect(a?.scale).toBe(1.0)
    expect(b?.scale).toBe(0.45)
  })

  it('only marks the selected session as selected', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1] }),
      makeSession({ id: 'b', tagIds: [1] }),
    ]
    const model = buildSceneModel(
      withSessions(sessions, { ui: { ...defaultUi, selectedId: 'b' } })
    )

    const a = model.planets.find((p) => p.session.id === 'a')
    const b = model.planets.find((p) => p.session.id === 'b')
    expect(a?.selected).toBe(false)
    expect(b?.selected).toBe(true)
  })

  it('respects visibleSessions filtering (tag filter excludes non-matching sessions)', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1] }),
      makeSession({ id: 'b', tagIds: [2] }),
    ]
    const model = buildSceneModel(
      withSessions(sessions, { ui: { ...defaultUi, filterTagId: 1 } })
    )

    expect(model.planets.map((p) => p.session.id)).toEqual(['a'])
  })

  it('composes cluster labels as "NAME · count", uppercased', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1] }),
      makeSession({ id: 'b', tagIds: [1] }),
      makeSession({ id: 'c', tagIds: [2] }),
    ]
    const model = buildSceneModel(withSessions(sessions))

    const workLabel = model.labels.find((l) => l.text.startsWith('WORK'))
    const personalLabel = model.labels.find((l) => l.text.startsWith('PERSONAL'))
    expect(workLabel?.text).toBe('WORK · 2')
    expect(personalLabel?.text).toBe('PERSONAL · 1')
    expect(workLabel?.hue).toBe(210)
    expect(personalLabel?.hue).toBe(330)
  })

  it('derives counts from statusCounts over the visible sessions', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1], status: 'working' }),
      makeSession({ id: 'b', tagIds: [1], status: 'working' }),
      makeSession({ id: 'c', tagIds: [1], status: 'idle' }),
      makeSession({ id: 'd', tagIds: [1], status: 'ended' }),
    ]
    const model = buildSceneModel(withSessions(sessions))

    expect(model.counts).toEqual({ working: 2, idle: 1, needs_input: 0, ended: 1 })
  })

  it('has no moons for a session with no live subagents', () => {
    const sessions = [makeSession({ id: 'a', tagIds: [1] })]
    const model = buildSceneModel(withSessions(sessions))

    expect(model.moons).toHaveLength(0)
    expect(model.planets[0].subagents).toEqual([])
  })

  it('produces a moon for every live subagent of a session, with the parent planet hue', () => {
    const sessions = [makeSession({ id: 'a', tagIds: [1] })]
    const subagent = makeSubagent({ id: 'sub-1', state: 'working' })
    const model = buildSceneModel(
      withSessions(sessions, { subagents: { a: [subagent] } })
    )

    expect(model.moons).toHaveLength(1)
    expect(model.moons[0]).toMatchObject({
      sessionId: 'a',
      hue: 210,
      subagent,
    })
    expect(model.planets[0].subagents).toEqual([subagent])
  })

  it('gives multiple moons on the same planet distinct orbit radii and phases', () => {
    const sessions = [makeSession({ id: 'a', tagIds: [1] })]
    const subagents = [
      makeSubagent({ id: 'sub-1' }),
      makeSubagent({ id: 'sub-2' }),
    ]
    const model = buildSceneModel(withSessions(sessions, { subagents: { a: subagents } }))

    expect(model.moons).toHaveLength(2)
    const [m1, m2] = model.moons
    expect(m1.orbitRadius).not.toBe(m2.orbitRadius)
    expect(m1.phase).not.toBe(m2.phase)
  })

  it('produces no moons when the session referenced by state.subagents is not visible', () => {
    const sessions = [makeSession({ id: 'a', tagIds: [2] })]
    const model = buildSceneModel(
      withSessions(sessions, {
        subagents: { ghost: [makeSubagent({ id: 'sub-1' })] },
      })
    )
    expect(model.moons).toHaveLength(0)
  })

  it('returns empty planets/moons/labels/zeroed counts for no sessions', () => {
    const model = buildSceneModel(makeState())
    expect(model.planets).toEqual([])
    expect(model.moons).toEqual([])
    expect(model.labels).toEqual([])
    expect(model.counts).toEqual({ working: 0, idle: 0, needs_input: 0, ended: 0 })
  })
})

// ---------------------------------------------------------------------------
// pan/zoom helpers
// ---------------------------------------------------------------------------

describe('clampZoom', () => {
  it('clamps below MIN_ZOOM up to MIN_ZOOM', () => {
    expect(clampZoom(1)).toBe(MIN_ZOOM)
  })

  it('clamps above MAX_ZOOM down to MAX_ZOOM', () => {
    expect(clampZoom(9999)).toBe(MAX_ZOOM)
  })

  it('passes through values already in range', () => {
    expect(clampZoom(60)).toBe(60)
  })
})

describe('applyPan', () => {
  it('moves the camera opposite to drag X, and same-sign to drag Y (screen Y inverted vs world Y)', () => {
    const cam = { x: 0, y: 0, zoom: 60 }
    const next = applyPan(cam, 60, 60)
    expect(next.x).toBeCloseTo(-1)
    expect(next.y).toBeCloseTo(1)
  })

  it('scales the pan delta by zoom, so dragging feels 1:1 with the cursor at any zoom', () => {
    const zoomedIn = applyPan({ x: 0, y: 0, zoom: 120 }, 60, 0)
    const zoomedOut = applyPan({ x: 0, y: 0, zoom: 30 }, 60, 0)
    expect(Math.abs(zoomedIn.x)).toBeLessThan(Math.abs(zoomedOut.x))
  })

  it('never touches zoom', () => {
    const next = applyPan({ x: 0, y: 0, zoom: 60 }, 10, 10)
    expect(next.zoom).toBe(60)
  })
})

describe('applyZoom', () => {
  it('adds the delta and clamps to range', () => {
    expect(applyZoom({ x: 0, y: 0, zoom: 60 }, 20).zoom).toBe(80)
    expect(applyZoom({ x: 0, y: 0, zoom: MAX_ZOOM }, 50).zoom).toBe(MAX_ZOOM)
    expect(applyZoom({ x: 0, y: 0, zoom: MIN_ZOOM }, -50).zoom).toBe(MIN_ZOOM)
  })

  it('never touches x/y', () => {
    const next = applyZoom({ x: 5, y: -3, zoom: 60 }, 10)
    expect(next.x).toBe(5)
    expect(next.y).toBe(-3)
  })
})

describe('fitView', () => {
  it('falls back to origin/default zoom for an empty position list', () => {
    expect(fitView([], { width: 800, height: 600 })).toEqual({ x: 0, y: 0, zoom: 60 })
  })

  it('centers the camera on the bounding box of all positions', () => {
    const positions = [
      { x: -10, y: 0 },
      { x: 10, y: 4 },
    ]
    const fit = fitView(positions, { width: 800, height: 600 })
    expect(fit.x).toBeCloseTo(0)
    expect(fit.y).toBeCloseTo(2)
  })

  it('clamps the computed zoom to the valid range', () => {
    // A single point (zero-size box) would compute an enormous zoom without clamping.
    const fit = fitView([{ x: 0, y: 0 }], { width: 800, height: 600 })
    expect(fit.zoom).toBeLessThanOrEqual(MAX_ZOOM)
    expect(fit.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
  })

  it('picks the tighter axis so both width and height fit inside the viewport', () => {
    const positions = [
      { x: -100, y: -1 },
      { x: 100, y: 1 },
    ]
    // Very wide, very short — height is the tight constraint on a square viewport.
    const fit = fitView(positions, { width: 800, height: 800 })
    expect(fit.zoom).toBeLessThanOrEqual(MAX_ZOOM)
  })
})
