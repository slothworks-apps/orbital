import { describe, it, expect } from 'vitest'
import { act, render } from '@testing-library/react'
import type { ApiSession, OrbitalModel, Subagent, Tag } from '../lib/types'
import { useOrbital, type OrbitalState, type OrbitalUiState } from '../store/store'
import { buildSceneModel, type SceneModel } from '../map/sceneModel'
import { useSceneModel } from '../map/useSceneModel'
import {
  applyPan,
  applyZoom,
  centerOn,
  clampZoom,
  fitView,
  zoomAt,
  zoomFromWheel,
  MAX_ZOOM,
  MIN_ZOOM,
  type CameraState,
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
    model: null,
    resolvedModel: null,
    parentId: null,
    tagIds: [],
    status: 'idle',
    subagents: [],
    ...overrides,
  }
}

const MODELS: OrbitalModel[] = [
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', family: 'Opus', version: 'Opus 5 with 1M context', shortVersion: 'Opus 5', variant: '1M', blurb: 'Best for everyday, complex tasks', contextWindow: 1_000_000 },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', family: 'Sonnet', version: 'Sonnet 5', shortVersion: 'Sonnet 5', variant: null, blurb: 'Efficient for routine tasks', contextWindow: 200_000 },
]

const workTag: Tag = { id: 1, name: 'work', hue: 210, is_default: 0 }
const personalTag: Tag = { id: 2, name: 'personal', hue: 330, is_default: 0 }
const defaultTag: Tag = { id: 3, name: 'untagged', hue: 0, is_default: 1 }

const defaultUi: OrbitalUiState = {
  selectedId: null,
  filterTagId: 'all',
  search: '',
  sourceFilter: 'all',
  hideEnded: false,
  wsStatus: 'connected',
  dialog: null,
  sidebarCollapsed: false,
}

/** Fixed clock for the ended-age cutoff — never Date.now(), the model is pure. */
const NOW = 1_800_000_000_000
const DAY = 86_400_000

/**
 * `buildSceneModel` at a fixed clock. Most tests here predate the ended-age
 * cutoff and carry a 1970 `lastAt`; `makeState` opts them out of it with the
 * "never" preset, so they keep asserting what they were written to assert.
 * Tests about the cutoff itself call `buildSceneModel` directly.
 */
function sceneModelAt(state: OrbitalState, nowMs: number = NOW): SceneModel {
  return buildSceneModel(state, nowMs)
}

function makeState(overrides: Partial<OrbitalState> = {}): OrbitalState {
  return {
    sessions: {},
    order: [],
    tags: [workTag, personalTag, defaultTag],
    rules: [],
    models: [],
    settings: { map_ended_max_age_days: 'never' },
    transcripts: {},
    usage: {},
    historyLoaded: {},
    transcriptErrors: {},
    lastTurnResultAt: {},
    errors: [],
    errorsUnseen: 0,
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
    const model = sceneModelAt(withSessions(sessions))

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
    const model = sceneModelAt(withSessions(sessions))

    const a = model.planets.find((p) => p.session.id === 'a')
    const b = model.planets.find((p) => p.session.id === 'b')
    expect(a?.scale).toBe(1.0)
    expect(b?.scale).toBe(0.44)
  })

  it('only marks the selected session as selected', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1] }),
      makeSession({ id: 'b', tagIds: [1] }),
    ]
    const model = sceneModelAt(
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
    const model = sceneModelAt(
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
    const model = sceneModelAt(withSessions(sessions))

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
    const model = sceneModelAt(withSessions(sessions))

    expect(model.counts).toEqual({ working: 2, idle: 1, needs_input: 0, ended: 1 })
  })

  it('has no moons for a session with no live subagents', () => {
    const sessions = [makeSession({ id: 'a', tagIds: [1] })]
    const model = sceneModelAt(withSessions(sessions))

    expect(model.moons).toHaveLength(0)
    expect(model.planets[0].subagents).toEqual([])
  })

  it('produces a moon for every live subagent of a session, with the parent planet hue', () => {
    const subagent = makeSubagent({ id: 'sub-1', state: 'working' })
    const sessions = [makeSession({ id: 'a', tagIds: [1], subagents: [subagent] })]
    const model = sceneModelAt(withSessions(sessions))

    expect(model.moons).toHaveLength(1)
    expect(model.moons[0]).toMatchObject({
      sessionId: 'a',
      hue: 210,
      subagent,
    })
    expect(model.planets[0].subagents).toEqual([subagent])
  })

  it('gives multiple moons on the same planet distinct orbit radii and phases', () => {
    const subagents = [
      makeSubagent({ id: 'sub-1' }),
      makeSubagent({ id: 'sub-2' }),
    ]
    const model = sceneModelAt(withSessions([makeSession({ id: 'a', tagIds: [1], subagents })]))

    expect(model.moons).toHaveLength(2)
    const [m1, m2] = model.moons
    expect(m1.orbitRadius).not.toBe(m2.orbitRadius)
    expect(m1.phase).not.toBe(m2.phase)
  })

  it('drops ended subagents — moons exist only for LIVE subagents', () => {
    const liveSubagent = makeSubagent({ id: 'sub-live', state: 'working' })
    const endedSubagent = makeSubagent({ id: 'sub-ended', state: 'ended' })
    const model = sceneModelAt(
      withSessions([makeSession({ id: 'a', tagIds: [1], subagents: [liveSubagent, endedSubagent] })])
    )

    expect(model.moons).toHaveLength(1)
    expect(model.moons[0].subagent.id).toBe('sub-live')
    expect(model.planets[0].subagents.map((s) => s.id)).toEqual(['sub-live'])
  })

  it('drops every moon when a session has only ended subagents', () => {
    const model = sceneModelAt(
      withSessions([makeSession({ id: 'a', tagIds: [1], subagents: [makeSubagent({ id: 'sub-1', state: 'ended' })] })])
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
    const before = sceneModelAt(withSessions(sessions))
    const positionsBefore = new Map(before.planets.map((p) => [p.session.id, { x: p.x, y: p.y }]))

    // Bump session 'c' to the front of recency order — this must NOT
    // reshuffle any planet's position (it would if layout used the
    // recency-sorted array's index directly).
    const reordered = sessions.map((s) => (s.id === 'c' ? { ...s, lastAt: 999 } : s))
    const after = sceneModelAt(withSessions(reordered))
    const positionsAfter = new Map(after.planets.map((p) => [p.session.id, { x: p.x, y: p.y }]))

    for (const id of ['a', 'b', 'c']) {
      expect(positionsAfter.get(id)).toEqual(positionsBefore.get(id))
    }
  })

  it('produces no moons for a session the filter hides, however many it is running', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1] }),
      makeSession({ id: 'hidden', tagIds: [2], subagents: [makeSubagent({ id: 'sub-1' })] }),
    ]
    const model = sceneModelAt(
      withSessions(sessions, { ui: { ...defaultUi, filterTagId: 1 } })
    )
    expect(model.planets.map((p) => p.session.id)).toEqual(['a'])
    expect(model.moons).toHaveLength(0)
  })

  it('returns empty planets/moons/labels/zeroed counts for no sessions', () => {
    const model = sceneModelAt(makeState())
    expect(model.planets).toEqual([])
    expect(model.moons).toEqual([])
    expect(model.labels).toEqual([])
    expect(model.counts).toEqual({ working: 0, idle: 0, needs_input: 0, ended: 0 })
  })
})

describe('buildSceneModel model family', () => {
  it('carries the model family on each planet', () => {
    const model = sceneModelAt(
      withSessions([makeSession({ id: 's1', model: 'opus[1m]' })], {
        models: MODELS,
        settings: { map_show_model: 'true' },
      })
    )
    expect(model.planets[0].modelFamily).toBe('Opus')
  })

  it('omits the family when the map toggle is off', () => {
    const model = sceneModelAt(
      withSessions([makeSession({ id: 's1', model: 'opus[1m]' })], {
        models: MODELS,
        settings: { map_show_model: 'false' },
      })
    )
    expect(model.planets[0].modelFamily).toBeNull()
  })

  it('omits the family for a session whose model is unknown', () => {
    const model = sceneModelAt(
      withSessions([makeSession({ id: 's1', model: null, resolvedModel: 'claude-mystery-1' })], {
        models: MODELS,
        settings: { map_show_model: 'true' },
      })
    )
    expect(model.planets[0].modelFamily).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ended decluttering — canvas 2a/2b
// ---------------------------------------------------------------------------

describe('buildSceneModel and the ended age cutoff', () => {
  it('draws no planet at all for an ended session past the cutoff', () => {
    const sessions = [
      makeSession({ id: 'live', tagIds: [1], status: 'idle', lastAt: NOW - 90 * DAY }),
      makeSession({ id: 'fresh', tagIds: [1], status: 'ended', lastAt: NOW - 1_000 }),
      makeSession({ id: 'stale', tagIds: [1], status: 'ended', lastAt: NOW - 30 * DAY }),
    ]
    const state = withSessions(sessions, { settings: { map_ended_max_age_days: '1' } })
    const model = buildSceneModel(state, NOW)

    expect(model.planets.map((p) => p.session.id).sort()).toEqual(['fresh', 'live'])
    expect(model.counts.ended).toBe(1)
  })
})

describe('buildSceneModel and hideEnded', () => {
  const sessions = [
    makeSession({ id: 'a', tagIds: [1], status: 'working' }),
    makeSession({ id: 'b', tagIds: [1], status: 'idle' }),
    makeSession({ id: 'z-ended', tagIds: [1], status: 'ended' }),
  ]
  const hidden = withSessions(sessions, { ui: { ...defaultUi, hideEnded: true } })

  it('keeps the ended planet in the model and flags it hidden, so it can fade out', () => {
    const model = buildSceneModel(hidden, NOW)
    const byId = new Map(model.planets.map((p) => [p.session.id, p]))

    expect(byId.get('z-ended')?.hidden).toBe(true)
    expect(byId.get('a')?.hidden).toBe(false)
    expect(byId.get('b')?.hidden).toBe(false)
  })

  // Toggling must not renumber the golden-angle spiral — otherwise every
  // other planet in the cluster teleports, the hazard withStableSessionOrder
  // exists to prevent.
  it('leaves every other planet at exactly the position it had while ended were shown', () => {
    const shown = buildSceneModel(withSessions(sessions), NOW)
    const after = buildSceneModel(hidden, NOW)
    const pos = (m: SceneModel, id: string) => {
      const p = m.planets.find((q) => q.session.id === id)
      return p && { x: p.x, y: p.y, scale: p.scale }
    }

    expect(pos(after, 'a')).toEqual(pos(shown, 'a'))
    expect(pos(after, 'b')).toEqual(pos(shown, 'b'))
  })

  // Canvas 2a: `cWork: hid ? 2 : 3` — the cluster label counts what is drawn.
  it('drops hidden planets from the cluster label count', () => {
    expect(sceneModelAt(withSessions(sessions)).labels[0].text).toBe('WORK · 3')
    expect(buildSceneModel(hidden, NOW).labels[0].text).toBe('WORK · 2')
  })

  // A label over nothing is exactly the clutter the toggle is pressed to
  // remove — and unlike a planet, it is DOM text that would go on reading
  // over empty space.
  it('drops a cluster label whose every planet is suppressed', () => {
    const allEnded = [
      makeSession({ id: 'a', tagIds: [1], status: 'working' }),
      makeSession({ id: 'b', tagIds: [2], status: 'ended' }),
      makeSession({ id: 'c', tagIds: [2], status: 'ended' }),
    ]
    const shown = sceneModelAt(withSessions(allEnded))
    expect(shown.labels.map((l) => l.text)).toEqual(['WORK · 1', 'PERSONAL · 2'])

    const model = buildSceneModel(
      withSessions(allEnded, { ui: { ...defaultUi, hideEnded: true } }),
      NOW
    )
    expect(model.labels.map((l) => l.text)).toEqual(['WORK · 1'])
    // The planets themselves stay, so they can fade rather than vanish.
    expect(model.planets).toHaveLength(3)
  })

  it('anchors the label above the topmost planet still drawn, not above a hidden one', () => {
    // Spiral index 1 is the one that lands highest, and the cluster is laid
    // out in id order — so `b` is the cluster's topmost planet.
    const topmostIsEnded = [
      makeSession({ id: 'a', tagIds: [1], status: 'working' }),
      makeSession({ id: 'b', tagIds: [1], status: 'ended' }),
      makeSession({ id: 'c', tagIds: [1], status: 'working' }),
    ]
    const state = withSessions(topmostIsEnded)
    const shown = buildSceneModel(state, NOW)
    const hiddenModel = buildSceneModel(
      withSessions(topmostIsEnded, { ui: { ...defaultUi, hideEnded: true } }),
      NOW
    )

    const drawnTop = Math.max(
      ...hiddenModel.planets.filter((p) => !p.hidden).map((p) => p.y)
    )
    const suppressedTop = Math.max(...shown.planets.map((p) => p.y))
    // Only meaningful if the ended planet really is the cluster's topmost.
    expect(suppressedTop).toBeGreaterThan(drawnTop)
    expect(hiddenModel.labels[0].y).toBeLessThan(shown.labels[0].y)
  })

  // Canvas 2b: the ENDED number keeps counting; it is what you click to
  // bring them back.
  it('keeps the ended count intact so the readout reads suppressed, not zero', () => {
    expect(buildSceneModel(hidden, NOW).counts).toEqual({
      working: 1,
      idle: 1,
      needs_input: 0,
      ended: 1,
    })
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

describe('centerOn', () => {
  const VIEWPORT = { width: 1440, height: 900 }
  /** The sidebar and detail panel, as `SpaceMap` measures them (1a/1b). */
  const INSETS = { left: 340, right: 466 }

  function worldToScreen(cam: CameraState, world: { x: number; y: number }) {
    return {
      x: VIEWPORT.width / 2 + (world.x - cam.x) * cam.zoom,
      y: VIEWPORT.height / 2 - (world.y - cam.y) * cam.zoom,
    }
  }

  it('lands the target in the middle of the strip between the panels, not of the viewport', () => {
    const cam: CameraState = { x: 0, y: 0, zoom: 60 }
    const target = { x: 12, y: -5 }

    const screen = worldToScreen(centerOn(cam, target, INSETS), target)

    expect(screen.x).toBeCloseTo(INSETS.left + (VIEWPORT.width - INSETS.left - INSETS.right) / 2, 10)
    expect(screen.y).toBeCloseTo(VIEWPORT.height / 2, 10)
  })

  it('never touches the zoom — following a session moves the view, it does not reframe it', () => {
    const cam: CameraState = { x: 3, y: 9, zoom: 137 }
    expect(centerOn(cam, { x: -20, y: 4 }, INSETS).zoom).toBe(137)
  })

  it('offsets by fewer world units the further in you are zoomed', () => {
    const target = { x: 0, y: 0 }
    const near = centerOn({ x: 0, y: 0, zoom: 150 }, target, INSETS)
    const far = centerOn({ x: 0, y: 0, zoom: 30 }, target, INSETS)
    expect(Math.abs(near.x)).toBeLessThan(Math.abs(far.x))
  })

  it('centres on the viewport when nothing is covering it', () => {
    const cam: CameraState = { x: 0, y: 0, zoom: 60 }
    expect(centerOn(cam, { x: 7, y: 2 }, { left: 0, right: 0 })).toEqual({ x: 7, y: 2, zoom: 60 })
  })
})

describe('zoomAt', () => {
  const VIEWPORT = { width: 1000, height: 600 }

  /** The projection `zoomAt` has to hold still: ortho camera, frustum centred on the canvas. */
  function screenToWorld(cam: CameraState, point: { x: number; y: number }) {
    return {
      x: cam.x + (point.x - VIEWPORT.width / 2) / cam.zoom,
      y: cam.y - (point.y - VIEWPORT.height / 2) / cam.zoom,
    }
  }

  it('keeps the world point under the pointer in place', () => {
    const cam: CameraState = { x: 3, y: -2, zoom: 60 }
    const pointer = { x: 820, y: 130 }
    const before = screenToWorld(cam, pointer)

    const next = zoomAt(cam, 96, pointer, VIEWPORT)

    const after = screenToWorld(next, pointer)
    expect(after.x).toBeCloseTo(before.x, 10)
    expect(after.y).toBeCloseTo(before.y, 10)
  })

  it('holds the anchor when zooming out too, not just in', () => {
    const cam: CameraState = { x: -7, y: 4, zoom: 120 }
    const pointer = { x: 90, y: 540 }
    const before = screenToWorld(cam, pointer)

    const after = screenToWorld(zoomAt(cam, 45, pointer, VIEWPORT), pointer)
    expect(after.x).toBeCloseTo(before.x, 10)
    expect(after.y).toBeCloseTo(before.y, 10)
  })

  it('leaves the camera centred when the pointer is the viewport centre', () => {
    const cam: CameraState = { x: 3, y: -2, zoom: 60 }
    const next = zoomAt(cam, 90, { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 }, VIEWPORT)
    expect(next.x).toBeCloseTo(3, 10)
    expect(next.y).toBeCloseTo(-2, 10)
    expect(next.zoom).toBe(90)
  })

  it('retraces its own path: zooming back through the same point returns the camera', () => {
    const cam: CameraState = { x: 3, y: -2, zoom: 60 }
    const pointer = { x: 700, y: 420 }
    const back = zoomAt(zoomAt(cam, 150, pointer, VIEWPORT), 60, pointer, VIEWPORT)
    expect(back.x).toBeCloseTo(cam.x, 10)
    expect(back.y).toBeCloseTo(cam.y, 10)
    expect(back.zoom).toBe(cam.zoom)
  })

  it('clamps the zoom, and pans by the clamped amount rather than the requested one', () => {
    const cam: CameraState = { x: 0, y: 0, zoom: 150 }
    const pointer = { x: 900, y: 100 }
    expect(zoomAt(cam, 1e6, pointer, VIEWPORT)).toEqual(zoomAt(cam, MAX_ZOOM, pointer, VIEWPORT))
  })

  it('does not move the camera at all when the zoom cannot change', () => {
    const cam: CameraState = { x: 5, y: 5, zoom: MAX_ZOOM }
    expect(zoomAt(cam, MAX_ZOOM * 2, { x: 0, y: 0 }, VIEWPORT)).toBe(cam)
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
