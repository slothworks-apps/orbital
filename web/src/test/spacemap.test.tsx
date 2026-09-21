import { beforeAll, describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ApiSession, OrbitalModel, Subagent, Tag } from '../lib/types'
import { PLANET_SCALE_MAX, useOrbital, type OrbitalState, type OrbitalUiState } from '../store/store'
import { buildSceneModel, contextFillFor, type SceneModel } from '../map/sceneModel'
import { useSceneModel } from '../map/useSceneModel'
import {
  applyPan,
  bodyZoomFactor,
  centerOn,
  clampZoom,
  fitView,
  zoomAt,
  zoomFromWheel,
  MAX_ZOOM,
  MIN_ZOOM,
  type CameraState,
} from '../map/camera'
import { PLANET_BASE_RADIUS } from '../map/layout'
import { CONTEXT_GAUGE_OUTER, moonVisuals } from '../map/visuals'

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
    mapDismissedAt: null,
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
  wsStatus: 'connected',
  dialog: null,
  sidebarCollapsed: false,
  fileViewer: null,
}

/** Fixed clock for the timed release — never Date.now(), the model is pure. */
const NOW = 1_800_000_000_000
const DAY = 86_400_000
/** Comfortably past the zoom tween's duration, so a click has finished arriving. */
const ZOOM_STEP_SETTLE_MS = 900

/**
 * `buildSceneModel` at a fixed clock. Most tests here predate the timed
 * release and carry a 1970 `lastAt`; `makeState` opts them out of it with the
 * "never" preset, so they keep asserting what they were written to assert.
 * Tests about the release itself call `buildSceneModel` directly.
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
    contextWindows: {},
    settings: { map_release_ended_after_minutes: 'never' },
    transcripts: {},
    usage: {},
    historyLoaded: {},
    transcriptErrors: {},
    lastTurnResultAt: {},
    pendingDecisions: {},
    decisionAnswers: {},
    errors: [],
    errorsUnseen: 0,
    sessionsTotal: 0,
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

  it('gives a moonless planet the footprint of its own body', () => {
    const model = sceneModelAt(withSessions([makeSession({ id: 'a', tagIds: [1] })]))
    const planet = model.planets[0]

    expect(planet.footprint).toBe(planet.scale * PLANET_BASE_RADIUS)
  })

  it('widens the footprint to the outermost moon shell, and widens it again per subagent', () => {
    const one = sceneModelAt(
      withSessions([makeSession({ id: 'a', tagIds: [1], subagents: [makeSubagent({ id: 's1' })] })])
    )
    const three = sceneModelAt(
      withSessions([
        makeSession({
          id: 'a',
          tagIds: [1],
          subagents: [
            makeSubagent({ id: 's1' }),
            makeSubagent({ id: 's2' }),
            makeSubagent({ id: 's3' }),
          ],
        }),
      ])
    )

    // Measured to the moon's own edge, not to the trail it rides.
    const outer = three.moons[three.moons.length - 1]
    expect(three.planets[0].footprint).toBeCloseTo(
      outer.orbitRadius + moonVisuals(outer.subagent.state).discRadius,
      10
    )
    expect(one.planets[0].footprint).toBeGreaterThan(one.planets[0].scale * PLANET_BASE_RADIUS)
    expect(three.planets[0].footprint).toBeGreaterThan(one.planets[0].footprint)
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
// context fill arc (spec `context-fill-arc`, canvas 1i)
// ---------------------------------------------------------------------------

describe('contextFillFor', () => {
  /** A session whose window MODELS knows: sonnet, 200k. */
  const gauged = (overrides: Partial<ApiSession> = {}) =>
    makeSession({ id: 'g', model: 'sonnet', contextUsedTokens: 100_000, ...overrides })

  it('reads the fraction off the session and the model catalog', () => {
    expect(contextFillFor(gauged(), MODELS, {})).toEqual({ fraction: 0.5, level: 'ok' })
  })

  it('keeps a fill sitting exactly ON a threshold below it, and steps at the first token past', () => {
    // Defaults are 50 / 80: 50% is still `ok`, 80% is still `warn`.
    expect(contextFillFor(gauged({ contextUsedTokens: 100_000 }), MODELS, {})?.level).toBe('ok')
    expect(contextFillFor(gauged({ contextUsedTokens: 100_001 }), MODELS, {})?.level).toBe('warn')
    expect(contextFillFor(gauged({ contextUsedTokens: 160_000 }), MODELS, {})?.level).toBe('warn')
    expect(contextFillFor(gauged({ contextUsedTokens: 160_001 }), MODELS, {})?.level).toBe('critical')
  })

  it('follows the configured thresholds, not the defaults', () => {
    const settings = { context_threshold_warn: '20', context_threshold_critical: '40' }
    expect(contextFillFor(gauged({ contextUsedTokens: 50_000 }), MODELS, settings)?.level).toBe('warn')
    expect(contextFillFor(gauged({ contextUsedTokens: 30_000 }), MODELS, settings)?.level).toBe('ok')
    expect(contextFillFor(gauged({ contextUsedTokens: 100_000 }), MODELS, settings)?.level).toBe(
      'critical'
    )
  })

  it('clamps a window learned smaller than the session actually used, and keeps it critical', () => {
    expect(contextFillFor(gauged({ contextUsedTokens: 500_000 }), MODELS, {})).toEqual({
      fraction: 1,
      level: 'critical',
    })
  })

  it('draws no gauge for a terminal session, which can never report usage', () => {
    expect(contextFillFor(gauged({ source: 'terminal' }), MODELS, {})).toBeNull()
  })

  it('draws no gauge for an ended session (canvas 1i: "ended · no gauge")', () => {
    expect(contextFillFor(gauged({ status: 'ended' }), MODELS, {})).toBeNull()
  })

  it('draws no gauge before anything has measured the context', () => {
    expect(contextFillFor(gauged({ contextUsedTokens: null }), MODELS, {})).toBeNull()
    expect(contextFillFor(makeSession({ id: 'g', model: 'sonnet' }), MODELS, {})).toBeNull()
  })

  it('draws no gauge against an unknown window rather than inventing a denominator', () => {
    expect(
      contextFillFor(gauged({ model: null, resolvedModel: 'claude-mystery-1' }), MODELS, {})
    ).toBeNull()
    expect(contextFillFor(gauged(), [], {})).toBeNull()
  })

  it('draws no gauge at all while the map toggle is off', () => {
    expect(contextFillFor(gauged(), MODELS, { map_show_context: 'false' })).toBeNull()
  })

  it('draws the gauge from the learned window when no catalog row carries the resolved id', () => {
    // A revived terminal session (fix: revived-session-shows-no-context-gauge).
    const revived = gauged({ model: null, resolvedModel: 'claude-fable-5', contextUsedTokens: 500_000 })
    expect(contextFillFor(revived, MODELS, {}, { 'claude-fable-5': 1_000_000 })).toEqual({
      fraction: 0.5,
      level: 'ok',
    })
  })
})

describe('buildSceneModel context fill', () => {
  it('carries the fill on each planet', () => {
    const model = sceneModelAt(
      withSessions(
        [makeSession({ id: 's1', model: 'sonnet', contextUsedTokens: 180_000 })],
        { models: MODELS }
      )
    )
    expect(model.planets[0].contextFill).toEqual({ fraction: 0.9, level: 'critical' })
  })

  it('leaves it null where there is nothing to draw', () => {
    const model = sceneModelAt(
      withSessions([makeSession({ id: 's1', model: 'sonnet' })], { models: MODELS })
    )
    expect(model.planets[0].contextFill).toBeNull()
  })

  it('threads the learned windows through to the arc', () => {
    const model = sceneModelAt(
      withSessions(
        [makeSession({ id: 's1', model: null, resolvedModel: 'claude-fable-5', contextUsedTokens: 500_000 })],
        { models: MODELS, contextWindows: { 'claude-fable-5': 1_000_000 } }
      )
    )
    expect(model.planets[0].contextFill).toEqual({ fraction: 0.5, level: 'ok' })
  })
})

describe('moon orbits around a gauged planet', () => {
  const moonsFor = (overrides: Partial<ApiSession>) => {
    const model = sceneModelAt(
      withSessions(
        [makeSession({ id: 's1', model: 'sonnet', subagents: [makeSubagent({ id: 'a' })], ...overrides })],
        { models: MODELS }
      )
    )
    return { moon: model.moons[0], planet: model.planets[0] }
  }

  it('starts the innermost orbit past the gauge ring, at the largest size the slider can draw it', () => {
    const gauged = moonsFor({ contextUsedTokens: 100_000 })
    const plain = moonsFor({})
    expect(gauged.planet.contextFill).not.toBeNull()
    expect(plain.planet.contextFill).toBeNull()
    // The gauge lives in the planet's scaled group and the planet-size
    // slider scales that group, while orbits never see the slider — so the
    // trail must clear the gauge even at PLANET_SCALE_MAX.
    expect(gauged.moon.orbitRadius).toBeGreaterThan(
      CONTEXT_GAUGE_OUTER * PLANET_SCALE_MAX * gauged.planet.scale
    )
    expect(gauged.moon.orbitRadius).toBeGreaterThan(plain.moon.orbitRadius)
  })

  it('keeps the orbit where it was when the gauge is not drawn', () => {
    const plain = moonsFor({})
    const toggledOff = sceneModelAt(
      withSessions(
        [makeSession({ id: 's1', model: 'sonnet', contextUsedTokens: 100_000, subagents: [makeSubagent({ id: 'a' })] })],
        { models: MODELS, settings: { map_show_context: 'false', map_release_ended_after_minutes: 'never' } }
      )
    )
    expect(toggledOff.moons[0].orbitRadius).toBe(plain.moon.orbitRadius)
  })
})

// ---------------------------------------------------------------------------
// tag clusters — timed release, the hole, anchors (canvas 4a/4b)
// ---------------------------------------------------------------------------

describe('buildSceneModel and the timed release', () => {
  it('draws no planet at all for an absorbed ended session, and flags a releasing one', () => {
    const sessions = [
      makeSession({ id: 'live', tagIds: [1], status: 'idle', lastAt: NOW - 90 * DAY }),
      makeSession({ id: 'fresh', tagIds: [1], status: 'ended', lastAt: NOW - 1_000 }),
      makeSession({ id: 'releasing', tagIds: [1], status: 'ended', lastAt: NOW - 2 * 3_600_000 - 1_000 }),
      makeSession({ id: 'absorbed', tagIds: [1], status: 'ended', lastAt: NOW - 30 * DAY }),
    ]
    const state = withSessions(sessions, { settings: {} }) // 2h default delay
    const model = buildSceneModel(state, NOW)

    const byId = new Map(model.planets.map((p) => [p.session.id, p]))
    expect([...byId.keys()].sort()).toEqual(['fresh', 'live', 'releasing'])
    expect(byId.get('releasing')?.released).toBe(true)
    expect(byId.get('fresh')?.released).toBe(false)
  })

  it('flags a manually dismissed session as released while its fall grace runs', () => {
    const sessions = [
      makeSession({ id: 'dismissed', tagIds: [1], status: 'idle', mapDismissedAt: NOW - 1_000 }),
      makeSession({ id: 'kept', tagIds: [1], status: 'idle' }),
    ]
    const model = buildSceneModel(withSessions(sessions), NOW)

    const byId = new Map(model.planets.map((p) => [p.session.id, p]))
    expect(byId.get('dismissed')?.released).toBe(true)
    expect(byId.get('kept')?.released).toBe(false)
  })

  // A released body's bond is cut — it is no longer part of the clump the
  // label describes (canvas 4a's chips count bonded bodies).
  it('drops released planets from the cluster label count, and the label entirely when none remain', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1], status: 'working' }),
      makeSession({ id: 'b', tagIds: [1], status: 'idle', mapDismissedAt: NOW - 1_000 }),
      makeSession({ id: 'c', tagIds: [2], status: 'idle', mapDismissedAt: NOW - 1_000 }),
    ]
    const model = buildSceneModel(withSessions(sessions), NOW)
    expect(model.labels.map((l) => l.text)).toEqual(['WORK · 1'])
    // The released planets themselves stay, so their fall can play.
    expect(model.planets).toHaveLength(3)
  })
})

describe('buildSceneModel anchors and hole', () => {
  it('produces one anchor per cluster, deterministic, with the tag hue', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1] }),
      makeSession({ id: 'b', tagIds: [2] }),
    ]
    const first = sceneModelAt(withSessions(sessions))
    const again = sceneModelAt(withSessions(sessions))

    expect(first.anchors.map((a) => a.tagId).sort()).toEqual([1, 2])
    expect(first.anchors).toEqual(again.anchors)
    const work = first.anchors.find((a) => a.tagId === 1)
    expect(work?.hue).toBe(210)
    expect(Number.isFinite(work?.x)).toBe(true)
    expect(Number.isFinite(work?.y)).toBe(true)
  })

  it('pins the hole bottom-right of the whole field, clear of every planet', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1] }),
      makeSession({ id: 'b', tagIds: [2] }),
      makeSession({ id: 'c', tagIds: [2] }),
    ]
    const model = sceneModelAt(withSessions(sessions))

    expect(model.hole.x).toBeGreaterThan(0)
    expect(model.hole.y).toBeLessThan(0)
    for (const planet of model.planets) {
      expect(planet.x).toBeLessThan(model.hole.x)
      expect(planet.y).toBeGreaterThan(model.hole.y)
    }
  })

  it('places a hole even on an empty map — it is the history handle, not a planet', () => {
    const model = sceneModelAt(makeState({ sessionsTotal: 47 }))
    expect(Number.isFinite(model.hole.x)).toBe(true)
    expect(model.hole.count).toBe(47)
  })

  it('counts the sessions in the index that are not drawn (released ones already count)', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1] }),
      makeSession({ id: 'b', tagIds: [1], status: 'idle', mapDismissedAt: NOW - 1_000 }),
    ]
    // 10 in the index, 1 drawn-and-bonded ('a') — the falling 'b' is already
    // the hole's, so only the bonded body subtracts.
    const model = sceneModelAt(withSessions(sessions, { sessionsTotal: 10 }))
    expect(model.hole.count).toBe(9)
  })

  it('never counts below zero, however stale the total', () => {
    const sessions = [makeSession({ id: 'a', tagIds: [1] })]
    const model = sceneModelAt(withSessions(sessions, { sessionsTotal: 0 }))
    expect(model.hole.count).toBe(0)
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

describe('bodyZoomFactor', () => {
  it('is exactly 1 at the reference zoom (60) and above — the close-up view never changes', () => {
    expect(bodyZoomFactor(60)).toBe(1)
    expect(bodyZoomFactor(120)).toBe(1)
    expect(bodyZoomFactor(MAX_ZOOM)).toBe(1)
  })

  it('follows (60/zoom)^0.5 in the open range — √2 at half the reference zoom', () => {
    expect(bodyZoomFactor(30)).toBeCloseTo(Math.SQRT2, 10)
  })

  it('clamps at the cap near MIN_ZOOM, where the raw curve would exceed it', () => {
    // (60/20)^0.5 ≈ 1.732 — the cap catches the bottom of the range.
    expect(bodyZoomFactor(MIN_ZOOM)).toBe(1.7)
  })

  it('is monotonically non-increasing in zoom', () => {
    const zooms = [MIN_ZOOM, 25, 30, 40, 50, 60, 100, MAX_ZOOM]
    const factors = zooms.map(bodyZoomFactor)
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeLessThanOrEqual(factors[i - 1])
    }
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

// ---------------------------------------------------------------------------
// Overlays track the live detail-panel width (drag handle)
// ---------------------------------------------------------------------------

describe('SpaceMap overlays and the live panel width', () => {
  // R3F's <Canvas> measures itself via react-use-measure, which needs
  // ResizeObserver — jsdom has none. Same scoped polyfill as app.test.tsx.
  beforeAll(() => {
    class NoopObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    global.ResizeObserver = NoopObserver
  })

  // `ui` is itself partial — the calls below override a single flag, and the
  // rest is filled from `defaultUi` in the setState spread.
  async function renderMap(
    overrides: Partial<Omit<OrbitalState, 'ui'>> & { ui?: Partial<OrbitalUiState> } = {},
  ) {
    useOrbital.setState({
      sessions: { a: makeSession({ id: 'a', tagIds: [1], lastAt: Date.now() }) },
      order: ['a'],
      tags: [workTag, personalTag, defaultTag],
      rules: [],
      settings: {},
      transcripts: {},
      usage: {},
      historyLoaded: {},
      toast: null,
      ...overrides,
      ui: { ...defaultUi, selectedId: 'a', ...(overrides.ui ?? {}) },
    })
    const { SpaceMap } = await import('../map/SpaceMap')
    return render(<SpaceMap />)
  }

  it('offsets the aggregate readout and the zoom stack by the stored panel width', async () => {
    await renderMap({ settings: { detail_panel_width: '600' } })

    // 600px panel + 16px inset + 24px gap. The positioned element is the
    // zoom COLUMN (errors trigger + joined stack), not the stack itself.
    const zoomStack = screen
      .getByRole('button', { name: 'Zoom in' })
      .closest('[data-overlay="zoom-column"]') as HTMLElement
    expect(zoomStack.style.right).toBe('640px')
    const readout = screen.getByText(/ENDED/).closest('[data-overlay="aggregate"]') as HTMLElement
    expect(readout.style.right).toBe('640px')
  })

  it('falls back to the 24px edge inset when nothing is selected', async () => {
    await renderMap({ ui: { selectedId: null } })
    const zoomStack = screen
      .getByRole('button', { name: 'Zoom in' })
      .closest('[data-overlay="zoom-column"]') as HTMLElement
    expect(zoomStack.style.right).toBe('24px')
  })
})

// The +/- buttons ease the zoom instead of cutting to it
// (ADR `the-zoom-buttons-ease-in-log-space`). Driven through the real DOM
// because the whole of the logic is the hook wiring: a unit test of the
// tween would not have caught the buttons doing nothing.
describe('SpaceMap zoom buttons', () => {
  beforeAll(() => {
    class NoopObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    global.ResizeObserver = NoopObserver
  })

  async function renderMap() {
    useOrbital.setState({
      sessions: { a: makeSession({ id: 'a', tagIds: [1], lastAt: Date.now() }) },
      order: ['a'],
      tags: [workTag, personalTag, defaultTag],
      rules: [],
      settings: {},
      transcripts: {},
      usage: {},
      historyLoaded: {},
      toast: null,
      ui: { ...defaultUi, selectedId: null },
    })
    const { SpaceMap } = await import('../map/SpaceMap')
    return render(<SpaceMap />)
  }

  /** The HUD's `NN% · x … y …` readout, as a number. */
  function zoomPercent(): number {
    const readout = screen.getByText(/% · x/)
    return Number(readout.textContent?.match(/^(\d+)%/)?.[1])
  }

  /** Lets the rAF-driven tween run to completion. */
  async function settle() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ZOOM_STEP_SETTLE_MS))
    })
  }

  it('arrives at a full step in, and back out again', async () => {
    await renderMap()
    const start = zoomPercent()

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    await settle()
    const zoomedIn = zoomPercent()
    expect(zoomedIn).toBeGreaterThan(start)

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    await settle()
    expect(zoomPercent()).toBe(start)
  })

  it('accumulates presses made during a run, and stops at the end of the range', async () => {
    await renderMap()
    // Every press lands while the previous run is still in flight: each one
    // has to add a step to where the run is HEADED, not re-aim at one step
    // past wherever the animation currently stands.
    for (let i = 0; i < 12; i++) {
      fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    }
    await settle()
    expect(zoomPercent()).toBe(MIN_ZOOM)
  })
})
