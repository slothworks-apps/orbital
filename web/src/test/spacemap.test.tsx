import { describe, it, expect } from 'vitest'
import { act, render } from '@testing-library/react'
import type { ApiSession, Subagent, Tag } from '../lib/types'
import { useOrbital, type OrbitalState, type OrbitalUiState } from '../store/store'
import { buildSceneModel, type SceneModel } from '../map/sceneModel'
import { useSceneModel } from '../map/useSceneModel'
import {
  applyPan,
  applyZoom,
  clampZoom,
  fitView,
  zoomFromWheel,
  MAX_ZOOM,
  MIN_ZOOM,
} from '../map/camera'

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
  sidebarCollapsed: false,
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

  it('drops ended subagents — moons exist only for LIVE subagents', () => {
    const sessions = [makeSession({ id: 'a', tagIds: [1] })]
    const liveSubagent = makeSubagent({ id: 'sub-live', state: 'working' })
    const endedSubagent = makeSubagent({ id: 'sub-ended', state: 'ended' })
    const model = buildSceneModel(
      withSessions(sessions, { subagents: { a: [liveSubagent, endedSubagent] } })
    )

    expect(model.moons).toHaveLength(1)
    expect(model.moons[0].subagent.id).toBe('sub-live')
    expect(model.planets[0].subagents.map((s) => s.id)).toEqual(['sub-live'])
  })

  it('drops every moon when a session has only ended subagents', () => {
    const sessions = [makeSession({ id: 'a', tagIds: [1] })]
    const model = buildSceneModel(
      withSessions(sessions, { subagents: { a: [makeSubagent({ id: 'sub-1', state: 'ended' })] } })
    )

    expect(model.moons).toHaveLength(0)
    expect(model.planets[0].subagents).toEqual([])
  })

  it('planet positions are independent of session recency order (stable id ordering feeds layout)', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1], lastAt: 100 }),
      makeSession({ id: 'b', tagIds: [1], lastAt: 90 }),
      makeSession({ id: 'c', tagIds: [1], lastAt: 80 }),
    ]
    const before = buildSceneModel(withSessions(sessions))
    const positionsBefore = new Map(before.planets.map((p) => [p.session.id, { x: p.x, y: p.y }]))

    // Bump session 'c' to the front of recency order — this must NOT
    // reshuffle any planet's position (it would if layout used the
    // recency-sorted array's index directly).
    const reordered = sessions.map((s) => (s.id === 'c' ? { ...s, lastAt: 999 } : s))
    const after = buildSceneModel(withSessions(reordered))
    const positionsAfter = new Map(after.planets.map((p) => [p.session.id, { x: p.x, y: p.y }]))

    for (const id of ['a', 'b', 'c']) {
      expect(positionsAfter.get(id)).toEqual(positionsBefore.get(id))
    }
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
      { x: -3, y: -1 },
      { x: 3, y: 1 },
    ]
    // width = 6 + 2*padding(2) = 10 -> zoomX = 800/10 = 80
    // height = 2 + 2*padding(2) = 6  -> zoomY = 300/6  = 50 (tighter, neither clamped)
    const fit = fitView(positions, { width: 800, height: 300 })
    expect(fit.zoom).toBeCloseTo(50)
  })

  it('picks the other axis when IT is the tighter constraint', () => {
    const positions = [
      { x: -1, y: -3 },
      { x: 1, y: 3 },
    ]
    // width = 2 + 4 = 6   -> zoomX = 300/6  = 50 (tighter, neither clamped)
    // height = 6 + 4 = 10 -> zoomY = 800/10 = 80
    const fit = fitView(positions, { width: 300, height: 800 })
    expect(fit.zoom).toBeCloseTo(50)
  })
})

describe('zoomFromWheel', () => {
  it('zooms in (increases zoom) for a negative deltaY (scroll up/forward)', () => {
    const next = zoomFromWheel(60, -100)
    expect(next).toBeGreaterThan(60)
  })

  it('zooms out (decreases zoom) for a positive deltaY (scroll down/back)', () => {
    const next = zoomFromWheel(60, 100)
    expect(next).toBeLessThan(60)
  })

  it('a standard Chrome notch (deltaY ~ -100, pixel mode) changes zoom by about 10%', () => {
    const next = zoomFromWheel(100, -100)
    expect(next).toBeCloseTo(110, 0)
  })

  it('is multiplicative: the same notch changes zoom by the same relative amount at any zoom level', () => {
    const lowRatio = zoomFromWheel(40, -100) / 40
    const highRatio = zoomFromWheel(160, -100) / 160
    expect(lowRatio).toBeCloseTo(highRatio, 5)
  })

  it('clamps the result to [MIN_ZOOM, MAX_ZOOM]', () => {
    expect(zoomFromWheel(MIN_ZOOM, 100000)).toBe(MIN_ZOOM)
    expect(zoomFromWheel(MAX_ZOOM, -100000)).toBe(MAX_ZOOM)
  })

  it('normalizes DOM_DELTA_LINE (deltaMode 1) by treating deltaY as ~16px lines', () => {
    // deltaMode 1, deltaY -100/16 "lines" should behave like -100px in pixel mode.
    const pixelMode = zoomFromWheel(100, -100, 0)
    const lineMode = zoomFromWheel(100, -100 / 16, 1)
    expect(lineMode).toBeCloseTo(pixelMode)
  })

  it('defaults to pixel-mode normalization when deltaMode is omitted', () => {
    expect(zoomFromWheel(100, -100)).toBe(zoomFromWheel(100, -100, 0))
  })
})

// ---------------------------------------------------------------------------
// useSceneModel — mount safety + reference stability
// ---------------------------------------------------------------------------

describe('useSceneModel', () => {
  function resetStore(overrides: Partial<OrbitalState> = {}) {
    useOrbital.setState({
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
      ui: { ...defaultUi },
      ...overrides,
    })
  }

  it('mounts without exceeding the update depth (regression for `useOrbital(buildSceneModel)` looping forever)', () => {
    resetStore()
    const seen: SceneModel[] = []
    function Probe() {
      const model = useSceneModel()
      seen.push(model)
      return null
    }

    // Pre-fix, this either throws "Maximum update depth exceeded" or hangs
    // the test — `buildSceneModel` allocated a fresh object every selector
    // call, which zustand 5's default `Object.is` equality never settles
    // on.
    expect(() => render(<Probe />)).not.toThrow()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1].planets).toEqual([])
  })

  it('returns a stable model reference across a re-render triggered by an unrelated store update', () => {
    resetStore({
      sessions: { a: makeSession({ id: 'a', tagIds: [1] }) },
      order: ['a'],
    })

    const seen: SceneModel[] = []
    function Probe() {
      const model = useSceneModel()
      seen.push(model)
      return null
    }

    const { rerender } = render(<Probe />)
    const beforeCount = seen.length
    const first = seen[seen.length - 1]
    expect(first.planets).toHaveLength(1)

    // wsStatus isn't read by buildSceneModel — updating it must not change
    // the memoized model reference, even when something forces a re-render.
    act(() => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, wsStatus: 'reconnecting' } }))
    })
    rerender(<Probe />)

    expect(seen.length).toBeGreaterThan(beforeCount)
    const last = seen[seen.length - 1]
    expect(last).toBe(first)
  })

  it('recomputes when a relevant slice (sessions) actually changes', () => {
    resetStore()
    const seen: SceneModel[] = []
    function Probe() {
      const model = useSceneModel()
      seen.push(model)
      return null
    }

    const { rerender } = render(<Probe />)
    const first = seen[seen.length - 1]
    expect(first.planets).toHaveLength(0)

    act(() => {
      useOrbital.setState((s) => ({
        sessions: { ...s.sessions, a: makeSession({ id: 'a', tagIds: [1] }) },
        order: [...s.order, 'a'],
      }))
    })
    rerender(<Probe />)

    const last = seen[seen.length - 1]
    expect(last).not.toBe(first)
    expect(last.planets).toHaveLength(1)
  })
})
