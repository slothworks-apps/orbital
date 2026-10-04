import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ApiSession, OrbitalModel, Subagent, Tag } from '../lib/types'
import { PLANET_SCALE_MAX, PLANET_SCALE_MIN, useOrbital, type OrbitalState, type OrbitalUiState } from '../store/store'
import { buildSceneModel, contextFillFor, MOON_EXTENT_RADIUS, type SceneModel } from '../map/sceneModel'
import { useSceneModel } from '../map/useSceneModel'
import {
  applyPan,
  bodyDesignPxToScreenPx,
  bodyZoomFactor,
  centerOn,
  clampZoom,
  fitView,
  zoomAt,
  zoomFromWheel,
  FIT_MARGIN_PX,
  MAX_ZOOM,
  MIN_ZOOM,
  type CameraState,
  type FitBody,
} from '../map/camera'
import { PLANET_BASE_RADIUS } from '../map/layout'
import { installKeyListener } from '../lib/commands'
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

/** Fixed clock for the leaving grace — never Date.now(), the model is pure. */
const NOW = 1_800_000_000_000
const DAY = 86_400_000
/** Comfortably past the zoom tween's duration, so a click has finished arriving. */
const ZOOM_STEP_SETTLE_MS = 900
/** Same, for the fit flight, which runs on the longer `FIT_FLIGHT_MS`. */
const FIT_SETTLE_MS = 1200

/** `buildSceneModel` at a fixed clock. */
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
    settings: {},
    transcripts: {},
    historyLoaded: {},
    transcriptErrors: {},
    lastTurnResultAt: {},
    statsRevision: {},
    pendingDecisions: {},
    decisionAnswers: {},
    decisionVerdicts: {},
    ideDismissed: {},
    composerDrafts: {},
    rewindSending: {},
    detachedIds: [],
    errors: [],
    errorsUnseen: 0,
    remote: null,
    sessionsTotal: 0,
    leavingSince: {},
    toast: null,
    subagentPanel: null,
    taskOutput: null,
    stoppingTasks: {},
      harnesses: {},
      harnessEvents: {},
      harnessEventsMore: {},
      harnessRemoved: {},
      harnessPanel: null,
      harnessTemplatesFocus: null,
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
  return { name: 'sub', state: 'working', startedAt: 0, ...overrides }
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
      makeSession({ id: 'b', tagIds: [1], status: 'ended', pinnedAt: 1 }),
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

  // ADR `search-mutes-planets-instead-of-hiding-them`: typing a query must
  // not move a single body — the layout never sees the search.
  it('keeps every planet in place under a search query, muting the ones that do not match', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1], title: 'Alpha', status: 'working', subagents: [makeSubagent({ id: 'sa' })] }),
      makeSession({ id: 'b', tagIds: [1], title: 'Beta', status: 'working', subagents: [makeSubagent({ id: 'sb' })] }),
      makeSession({ id: 'c', tagIds: [2], title: 'Gamma', cwd: '/home/alpha-tools', status: 'idle' }),
      makeSession({ id: 'd', tagIds: [2], title: 'Delta', status: 'ended', pinnedAt: 1 }),
    ]
    const plain = sceneModelAt(withSessions(sessions))
    const searched = sceneModelAt(withSessions(sessions, { ui: { ...defaultUi, search: '  ALPHA ' } }))

    const place = (m: SceneModel) =>
      m.planets.map((p) => ({ id: p.session.id, x: p.x, y: p.y, scale: p.scale, footprint: p.footprint }))
    expect(place(searched)).toEqual(place(plain))
    expect(searched.anchors).toEqual(plain.anchors)
    expect(searched.labels).toEqual(plain.labels)
    expect(searched.hole).toEqual(plain.hole)

    // Title OR cwd, case-insensitive, trimmed — the sidebar's own predicate.
    const muted = Object.fromEntries(searched.planets.map((p) => [p.session.id, p.muted]))
    expect(muted).toEqual({ a: false, b: true, c: false, d: true })
    expect(plain.planets.every((p) => !p.muted)).toBe(true)

    // A muted planet's moons mute with it.
    const moonMuted = Object.fromEntries(searched.moons.map((m) => [m.sessionId, m.muted]))
    expect(moonMuted).toEqual({ a: false, b: true })

    // The readout counts matches only; the layout above counts everything.
    expect(searched.counts).toEqual({ working: 1, idle: 1, needs_input: 0, ended: 0 })
  })

  it('keeps every planet in place under a tag filter, muting the other tags', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1], status: 'working' }),
      makeSession({ id: 'b', tagIds: [2], status: 'working', subagents: [makeSubagent({ id: 'sb' })] }),
    ]
    const plain = sceneModelAt(withSessions(sessions))
    const filtered = sceneModelAt(withSessions(sessions, { ui: { ...defaultUi, filterTagId: 1 } }))

    const place = (m: SceneModel) => m.planets.map((p) => ({ id: p.session.id, x: p.x, y: p.y }))
    expect(place(filtered)).toEqual(place(plain))
    expect(filtered.labels).toEqual(plain.labels)

    const muted = Object.fromEntries(filtered.planets.map((p) => [p.session.id, p.muted]))
    expect(muted).toEqual({ a: false, b: true })
    expect(filtered.moons.map((m) => m.muted)).toEqual([true])
    expect(filtered.counts).toEqual({ working: 1, idle: 0, needs_input: 0, ended: 0 })
  })

  it('mutes a session the tag filter passes when the search does not', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1], title: 'Alpha' }),
      makeSession({ id: 'b', tagIds: [1], title: 'Beta' }),
      makeSession({ id: 'c', tagIds: [2], title: 'Alpha too' }),
    ]
    const model = sceneModelAt(
      withSessions(sessions, { ui: { ...defaultUi, filterTagId: 1, search: 'alpha' } })
    )
    const muted = Object.fromEntries(model.planets.map((p) => [p.session.id, p.muted]))
    expect(muted).toEqual({ a: false, b: true, c: true })
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

  it('derives counts from statusCounts over the drawn sessions', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1], status: 'working' }),
      makeSession({ id: 'b', tagIds: [1], status: 'working' }),
      makeSession({ id: 'c', tagIds: [1], status: 'idle' }),
      makeSession({ id: 'd', tagIds: [1], status: 'ended', pinnedAt: 1 }),
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

  it('keeps moons on neighbouring orbits from touching as they pass, at every planet size', () => {
    const subagents = [makeSubagent({ id: 's1' }), makeSubagent({ id: 's2' })]
    for (const size of [PLANET_SCALE_MIN, 1, PLANET_SCALE_MAX]) {
      const model = sceneModelAt(
        withSessions([makeSession({ id: 'a', tagIds: [1], subagents })], {
          settings: { planet_scale: String(size) },
        })
      )
      const [inner, outer] = model.moons
      expect(outer.orbitRadius - inner.orbitRadius).toBeGreaterThan(2 * MOON_EXTENT_RADIUS * size)
    }
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

  /**
   * Finished moons leave the map (subagent list spec § 5) — and only the
   * map: the session keeps every agent, because the detail panel's
   * subagent list and the transcript's `OPEN →` row read that full list.
   */
  it('drops an ENDED subagent from the map, and only from the map', () => {
    const kept = makeSubagent({ id: 'sub-live', state: 'working' })
    const ended = makeSubagent({ id: 'sub-ended', state: 'ended', status: 'completed' })
    const session = makeSession({ id: 'a', tagIds: [1], subagents: [kept, ended] })
    const model = sceneModelAt(withSessions([session]))

    expect(model.moons.map((m) => m.subagent.id)).toEqual(['sub-live'])
    expect(model.planets[0].subagents.map((s) => s.id)).toEqual(['sub-live'])
    expect(session.subagents.map((s) => s.id)).toEqual(['sub-live', 'sub-ended'])
  })

  it('draws no moon for a session whose subagents have all ended, and sizes the planet as moonless', () => {
    const model = sceneModelAt(
      withSessions([makeSession({ id: 'a', tagIds: [1], subagents: [makeSubagent({ id: 'sub-1', state: 'ended' })] })])
    )

    expect(model.moons).toHaveLength(0)
    expect(model.planets[0].subagents).toEqual([])
    expect(model.planets[0].footprint).toBeCloseTo(model.planets[0].scale * PLANET_BASE_RADIUS, 10)
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
        { models: MODELS, settings: { map_show_context: 'false' } }
      )
    )
    expect(toggledOff.moons[0].orbitRadius).toBe(plain.moon.orbitRadius)
  })
})

// spec 2026-09-24-sessions-end-only-by-hand-design § 3.
describe('buildSceneModel and ended sessions', () => {
  it('draws no planet for an ended, unpinned session, a pinned one as usual, and flags a leaving one', () => {
    const sessions = [
      makeSession({ id: 'idle', tagIds: [1], status: 'idle', lastAt: NOW - 90 * DAY }),
      makeSession({ id: 'pinned', tagIds: [1], status: 'ended', pinnedAt: NOW - DAY }),
      makeSession({ id: 'leaving', tagIds: [1], status: 'ended' }),
      makeSession({ id: 'gone', tagIds: [1], status: 'ended', lastAt: NOW - 1_000 }),
    ]
    const model = buildSceneModel(withSessions(sessions, { leavingSince: { leaving: NOW - 1 } }), NOW)

    const byId = new Map(model.planets.map((p) => [p.session.id, p]))
    expect([...byId.keys()].sort()).toEqual(['idle', 'leaving', 'pinned'])
    expect(byId.get('leaving')?.leaving).toBe(true)
    expect(byId.get('pinned')?.leaving).toBe(false)
    expect(byId.get('idle')?.leaving).toBe(false)
  })

  // A leaving body is already gone as far as its clump is concerned.
  it('drops leaving planets from the cluster label count, and the label entirely when none remain', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1], status: 'working' }),
      makeSession({ id: 'b', tagIds: [1], status: 'ended' }),
      makeSession({ id: 'c', tagIds: [2], status: 'ended' }),
    ]
    const state = withSessions(sessions, { leavingSince: { b: NOW - 1, c: NOW - 1 } })
    const model = buildSceneModel(state, NOW)
    expect(model.labels.map((l) => l.text)).toEqual(['WORK · 1'])
    // The leaving planets themselves stay, so their fade can play.
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

  it('counts the sessions in the index that are not drawn (leaving ones already count)', () => {
    const sessions = [
      makeSession({ id: 'a', tagIds: [1] }),
      makeSession({ id: 'b', tagIds: [1], status: 'ended' }),
    ]
    // 10 in the index, 1 drawn to stay ('a') — the fading 'b' already counts
    // as not drawn, so only the body that stays subtracts.
    const model = sceneModelAt(withSessions(sessions, { sessionsTotal: 10, leavingSince: { b: NOW - 1 } }))
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

  it('runs the curve all the way to the bottom of the zoom range', () => {
    // The cap is the curve's own value at MIN_ZOOM, so it never cuts the
    // curve short: bodies keep inflating right down to the furthest-out view,
    // which is the one that most needs them to stay visible.
    expect(bodyZoomFactor(MIN_ZOOM)).toBeCloseTo((60 / MIN_ZOOM) ** 0.5, 10)
  })

  it('never exceeds its value at the bottom of the range', () => {
    // Zoom is clamped to [MIN_ZOOM, MAX_ZOOM] before it ever gets here, but
    // the guard has to hold for a caller that has not clamped yet.
    expect(bodyZoomFactor(1)).toBe(bodyZoomFactor(MIN_ZOOM))
  })

  it('is monotonically non-increasing in zoom', () => {
    const zooms = [MIN_ZOOM, 25, 30, 40, 50, 60, 100, MAX_ZOOM]
    const factors = zooms.map(bodyZoomFactor)
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeLessThanOrEqual(factors[i - 1])
    }
  })
})

/**
 * I5. What a DOM overlay on a body has to multiply its design px by. The
 * moon's affordance (`MoonControl`) was sized in fixed CSS px on the premise
 * that the counter-zoom holds a body's apparent screen size constant; it
 * does not, and these pin the arithmetic that says so — there is no browser
 * in this environment to check the result against.
 */
describe('bodyDesignPxToScreenPx', () => {
  it('is NOT constant across the zoom range — the premise the fixed-px affordance rested on', () => {
    expect(bodyDesignPxToScreenPx(MIN_ZOOM)).not.toBeCloseTo(bodyDesignPxToScreenPx(MAX_ZOOM), 3)
  })

  it('grows linearly with zoom at and above the reference, where the counter-zoom is inert', () => {
    // bodyZoomFactor === 1 here, so one design px is zoom/100 CSS px.
    expect(bodyDesignPxToScreenPx(100)).toBeCloseTo(1, 10)
    expect(bodyDesignPxToScreenPx(MAX_ZOOM)).toBeCloseTo(MAX_ZOOM / 100, 10)
    expect(bodyDesignPxToScreenPx(60)).toBeCloseTo(0.6, 10)
  })

  it('follows the counter-zoom curve below the reference', () => {
    expect(bodyDesignPxToScreenPx(30)).toBeCloseTo((Math.SQRT2 * 30) / 100, 10)
    expect(bodyDesignPxToScreenPx(MIN_ZOOM)).toBeCloseTo(
      (bodyZoomFactor(MIN_ZOOM) * MIN_ZOOM) / 100,
      10,
    )
  })

  it('carries the appearance body multiplier, which scales a moon\'s body and not its orbit', () => {
    expect(bodyDesignPxToScreenPx(60, 2)).toBeCloseTo(2 * bodyDesignPxToScreenPx(60), 10)
  })

  /**
   * The load-bearing property, stated as a property rather than as numbers:
   * whatever the camera does, a design-px offset converted through this
   * lands on screen in the same proportion to the drawn body as the canvas
   * drew it. That is the whole of what the affordance needs, and it is what
   * a fixed CSS-px layer cannot provide.
   */
  it('keeps a design-px offset in constant proportion to the body it decorates', () => {
    const discDesignPx = 13
    const offsetDesignPx = 19
    for (const zoom of [MIN_ZOOM, 20, 60, 150, MAX_ZOOM]) {
      const scale = bodyDesignPxToScreenPx(zoom)
      expect((discDesignPx + offsetDesignPx) * scale / (discDesignPx * scale)).toBeCloseTo(
        (discDesignPx + offsetDesignPx) / discDesignPx,
        10,
      )
      // And a moon's own drawn radius really is `designPx * scale`: the map
      // quotes moons at 0.01 world units per design px (`moonPx`,
      // `visuals.ts`) and a world unit covers `zoom` screen px.
      expect(discDesignPx * scale).toBeCloseTo(
        discDesignPx * 0.01 * bodyZoomFactor(zoom) * zoom,
        10,
      )
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
  const VIEWPORT = { width: 1440, height: 900 }
  /**
   * The zoom is solved by iterating against its own answer (the bodies
   * inflate as it zooms out), so an edge lands a fraction of a pixel inside
   * or outside the margin rather than exactly on it.
   */
  const EDGE_SLACK_PX = 0.01

  /** Where a world point lands on screen under a camera — the projection `SpaceMap` applies. */
  function worldToScreen(cam: CameraState, viewport: typeof VIEWPORT, world: { x: number; y: number }) {
    return {
      x: viewport.width / 2 + (world.x - cam.x) * cam.zoom,
      y: viewport.height / 2 - (world.y - cam.y) * cam.zoom,
    }
  }

  /**
   * Screen-space box the bodies actually cover under `cam`, radii included
   * and inflated the way the map inflates them (`bodyZoomFactor`) — what fit
   * has to keep inside the frame.
   */
  function drawnBox(cam: CameraState, viewport: typeof VIEWPORT, bodies: FitBody[]) {
    const factor = bodyZoomFactor(cam.zoom)
    let left = Infinity
    let right = -Infinity
    let top = Infinity
    let bottom = -Infinity
    for (const b of bodies) {
      const px = (b.r ?? 0) * factor * cam.zoom
      const at = worldToScreen(cam, viewport, b)
      left = Math.min(left, at.x - px)
      right = Math.max(right, at.x + px)
      top = Math.min(top, at.y - px)
      bottom = Math.max(bottom, at.y + px)
    }
    return { left, right, top, bottom }
  }

  it('falls back to origin/default zoom for an empty body list', () => {
    expect(fitView([], { width: 800, height: 600 })).toEqual({ x: 0, y: 0, zoom: 60 })
  })

  it('centers the camera on the bounding box of all positions', () => {
    const bodies = [
      { x: -10, y: 0 },
      { x: 10, y: 4 },
    ]
    const fit = fitView(bodies, VIEWPORT)
    const centre = worldToScreen(fit, VIEWPORT, { x: 0, y: 2 })
    // The frame's own centre, which the margins pull off the viewport's.
    expect(centre.x).toBeCloseTo(VIEWPORT.width / 2 + (FIT_MARGIN_PX.left - FIT_MARGIN_PX.right) / 2, 10)
    expect(centre.y).toBeCloseTo(VIEWPORT.height / 2 + (FIT_MARGIN_PX.top - FIT_MARGIN_PX.bottom) / 2, 10)
  })

  it('clamps the computed zoom to the valid range', () => {
    // A single point (zero-size box) would compute an enormous zoom without clamping.
    const fit = fitView([{ x: 0, y: 0 }], VIEWPORT)
    expect(fit.zoom).toBeLessThanOrEqual(MAX_ZOOM)
    expect(fit.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
  })

  it('keeps the whole box clear of the margins on every side', () => {
    const bodies = [
      { x: -10, y: -4 },
      { x: 10, y: 4 },
    ]
    const box = drawnBox(fitView(bodies, VIEWPORT), VIEWPORT, bodies)
    expect(box.left).toBeGreaterThanOrEqual(FIT_MARGIN_PX.left - EDGE_SLACK_PX)
    expect(box.right).toBeLessThanOrEqual(VIEWPORT.width - FIT_MARGIN_PX.right + EDGE_SLACK_PX)
    expect(box.top).toBeGreaterThanOrEqual(FIT_MARGIN_PX.top - EDGE_SLACK_PX)
    expect(box.bottom).toBeLessThanOrEqual(VIEWPORT.height - FIT_MARGIN_PX.bottom + EDGE_SLACK_PX)
  })

  it('picks the tighter axis so both width and height fit inside the frame', () => {
    // Wide box in a short viewport: height is what binds, and it binds exactly.
    const bodies = [
      { x: -3, y: -1 },
      { x: 3, y: 1 },
    ]
    const viewport = { width: 1440, height: 300 }
    const fit = fitView(bodies, viewport)
    expect(fit.zoom).toBeCloseTo(
      (viewport.height - FIT_MARGIN_PX.top - FIT_MARGIN_PX.bottom) / 2,
      10
    )
    const box = drawnBox(fit, viewport, bodies)
    expect(box.left).toBeGreaterThanOrEqual(FIT_MARGIN_PX.left - EDGE_SLACK_PX)
    expect(box.right).toBeLessThanOrEqual(viewport.width - FIT_MARGIN_PX.right + EDGE_SLACK_PX)
  })

  it('picks the other axis when IT is the tighter constraint', () => {
    const bodies = [
      { x: -1, y: -3 },
      { x: 1, y: 3 },
    ]
    const viewport = { width: 400, height: 900 }
    const fit = fitView(bodies, viewport)
    expect(fit.zoom).toBeCloseTo((viewport.width - FIT_MARGIN_PX.left - FIT_MARGIN_PX.right) / 2, 10)
  })

  describe('with body radii', () => {
    it('frames what a body DRAWS, not the point it stands on', () => {
      const points = [
        { x: -10, y: 0 },
        { x: 10, y: 0 },
      ]
      const withRadii = points.map((p) => ({ ...p, r: 3 }))
      const fit = fitView(withRadii, VIEWPORT)
      // A body 3 units wide on each end is 6 units more to fit, so the fit
      // has to pull back from the one that frames the bare points.
      expect(fit.zoom).toBeLessThan(fitView(points, VIEWPORT).zoom)
      const box = drawnBox(fit, VIEWPORT, withRadii)
      expect(box.left).toBeGreaterThanOrEqual(FIT_MARGIN_PX.left - EDGE_SLACK_PX)
      expect(box.right).toBeLessThanOrEqual(VIEWPORT.width - FIT_MARGIN_PX.right + EDGE_SLACK_PX)
    })

    it('holds at a zoom low enough for the map to inflate the bodies', () => {
      // Far enough apart that the fit lands deep in the zoomed-out range,
      // where `bodyZoomFactor` grows the radii the solve has to allow for —
      // the hole halo ending under the zoom stack was exactly this miss.
      const bodies = [
        { x: -30, y: -20 },
        { x: 30, y: 20, r: 2.1 },
      ]
      const fit = fitView(bodies, VIEWPORT)
      expect(bodyZoomFactor(fit.zoom)).toBeGreaterThan(1)
      const box = drawnBox(fit, VIEWPORT, bodies)
      expect(box.right).toBeLessThanOrEqual(VIEWPORT.width - FIT_MARGIN_PX.right + EDGE_SLACK_PX)
      expect(box.bottom).toBeLessThanOrEqual(VIEWPORT.height - FIT_MARGIN_PX.bottom + EDGE_SLACK_PX)
    })

    it('treats a radius-less body as the bare point it was before', () => {
      const bodies = [
        { x: -10, y: -4 },
        { x: 10, y: 4 },
      ]
      expect(fitView(bodies, VIEWPORT)).toEqual(
        fitView(
          bodies.map((b) => ({ ...b, r: 0 })),
          VIEWPORT
        )
      )
    })
  })

  describe('with panel insets', () => {
    const INSETS = { left: 340, right: 466 }

    const bodies = [
      { x: -10, y: -4 },
      { x: 10, y: 4 },
    ]

    it('fits the box into the strip between the panels, not the whole viewport', () => {
      const fit = fitView(bodies, VIEWPORT, INSETS)
      const left = worldToScreen(fit, VIEWPORT, { x: -10, y: 0 })
      const right = worldToScreen(fit, VIEWPORT, { x: 10, y: 0 })
      expect(left.x).toBeGreaterThanOrEqual(INSETS.left + FIT_MARGIN_PX.left)
      expect(right.x).toBeLessThanOrEqual(VIEWPORT.width - INSETS.right - FIT_MARGIN_PX.right)
    })

    it('centres the box in the strip, so the panels bite equally into the margins', () => {
      const fit = fitView(bodies, VIEWPORT, INSETS)
      const centre = worldToScreen(fit, VIEWPORT, { x: 0, y: 0 })
      const stripCentre = INSETS.left + (VIEWPORT.width - INSETS.left - INSETS.right) / 2
      expect(centre.x).toBeCloseTo(stripCentre + (FIT_MARGIN_PX.left - FIT_MARGIN_PX.right) / 2, 10)
      expect(centre.y).toBeCloseTo(VIEWPORT.height / 2 + (FIT_MARGIN_PX.top - FIT_MARGIN_PX.bottom) / 2, 10)
    })

    it('zooms out further than the uninset fit — there is less room to fit into', () => {
      const inset = fitView(bodies, VIEWPORT, INSETS)
      const full = fitView(bodies, VIEWPORT)
      expect(inset.zoom).toBeLessThan(full.zoom)
    })

    it('behaves exactly like the uninset fit when no panel is covering the map', () => {
      expect(fitView(bodies, VIEWPORT, { left: 0, right: 0 })).toEqual(fitView(bodies, VIEWPORT))
    })

    it('still fits vertically when height, not the narrowed width, is the tighter axis', () => {
      const viewport = { width: 1440, height: 240 }
      const fit = fitView(bodies, viewport, INSETS)
      const top = worldToScreen(fit, viewport, { x: 0, y: 4 })
      const bottom = worldToScreen(fit, viewport, { x: 0, y: -4 })
      expect(top.y).toBeGreaterThanOrEqual(FIT_MARGIN_PX.top - EDGE_SLACK_PX)
      expect(bottom.y).toBeLessThanOrEqual(viewport.height - FIT_MARGIN_PX.bottom + EDGE_SLACK_PX)
    })

    it('survives panels wider than the viewport instead of returning a nonsense camera', () => {
      const fit = fitView(bodies, { width: 700, height: 900 }, INSETS)
      expect(fit.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
      expect(fit.zoom).toBeLessThanOrEqual(MAX_ZOOM)
      expect(Number.isFinite(fit.x)).toBe(true)
      expect(Number.isFinite(fit.y)).toBe(true)
    })

    it('survives a viewport the margins alone would swallow', () => {
      const fit = fitView(bodies, { width: 160, height: 90 }, INSETS)
      expect(fit.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
      expect(fit.zoom).toBeLessThanOrEqual(MAX_ZOOM)
      expect(Number.isFinite(fit.x)).toBe(true)
      expect(Number.isFinite(fit.y)).toBe(true)
    })

    it('falls back to the default camera for an empty list, insets or not', () => {
      expect(fitView([], VIEWPORT, INSETS)).toEqual({ x: 0, y: 0, zoom: 60 })
    })
  })

  describe('with the window drag band on top', () => {
    const BAND = 48
    // Taller than wide in world units, so height is the tighter axis and the
    // band has to cost zoom.
    const bodies = [
      { x: -2, y: -10 },
      { x: 2, y: 10 },
    ]

    it('keeps the bodies below the band plus the usual top margin', () => {
      const fit = fitView(bodies, VIEWPORT, { left: 0, right: 0, top: BAND })
      const top = worldToScreen(fit, VIEWPORT, { x: 0, y: 10 })
      const bottom = worldToScreen(fit, VIEWPORT, { x: 0, y: -10 })
      expect(top.y).toBeGreaterThanOrEqual(BAND + FIT_MARGIN_PX.top - EDGE_SLACK_PX)
      expect(bottom.y).toBeLessThanOrEqual(VIEWPORT.height - FIT_MARGIN_PX.bottom + EDGE_SLACK_PX)
    })

    it('centres the box in the height the band leaves', () => {
      const fit = fitView(bodies, VIEWPORT, { left: 0, right: 0, top: BAND })
      const centre = worldToScreen(fit, VIEWPORT, { x: 0, y: 0 })
      const frameTop = BAND + FIT_MARGIN_PX.top
      const frameBottom = VIEWPORT.height - FIT_MARGIN_PX.bottom
      expect(centre.y).toBeCloseTo((frameTop + frameBottom) / 2, 10)
    })

    it('zooms out further than without it when height is the tighter axis', () => {
      const banded = fitView(bodies, VIEWPORT, { left: 0, right: 0, top: BAND })
      expect(banded.zoom).toBeLessThan(fitView(bodies, VIEWPORT).zoom)
    })

    it('is the plain fit when the band is absent (full screen, the browser)', () => {
      expect(fitView(bodies, VIEWPORT, { left: 0, right: 0, top: 0 })).toEqual(fitView(bodies, VIEWPORT))
    })
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
    globalThis.ResizeObserver = NoopObserver
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
      historyLoaded: {},
      toast: null,
      // Reset explicitly (`setState` merges rather than replaces): a test
      // below that opens the subagent panel and does not close it again
      // would otherwise leak it into whatever test runs next.
      subagentPanel: null,
      taskOutput: null,
      stoppingTasks: {},
      harnesses: {},
      harnessEvents: {},
      harnessEventsMore: {},
      harnessRemoved: {},
      harnessPanel: null,
      harnessTemplatesFocus: null,
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

  // -------------------------------------------------------------------------
  // Task 8 (spec § 8 "Layout"): with the subagent panel open, the map's
  // right-anchored overlays have to clear BOTH docked panels plus BOTH of
  // their gutters, not just the detail panel's own. `mapInsets.right` is
  // computed from the exact same expression (`rightPanelsChromePx` in
  // `SpaceMap.tsx`) but is never itself rendered to a DOM style — only fed
  // to `fitView`/`centerOn`, which are already exercised against arbitrary
  // inset values in this file's own `describe('fitView', ...)` /
  // `describe('centerOn', ...)` blocks — so asserting the overlay offset
  // here is also the coverage for that shared expression.
  // -------------------------------------------------------------------------
  describe('with the subagent panel also open', () => {
    const originalInnerWidth = window.innerWidth

    function setViewportWidth(px: number) {
      Object.defineProperty(window, 'innerWidth', { value: px, configurable: true })
    }

    afterEach(() => {
      Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true })
    })

    function openSubagentPanel(): OrbitalState['subagentPanel'] {
      return {
        sessionId: 'a',
        subagent: makeSubagent({ id: 'agent-1', toolUseId: 'tool-1' }),
        messages: [],
        droppedCount: 0,
        found: true,
      }
    }

    it('adds the subagent panel width and a second 16px gutter at a wide viewport (no ceiling shrink)', async () => {
      // 450 (detail) + 16 (gutter) + 380 (subagent default) + 16 (gutter) +
      // 24 (overlay clearance) = 886. Neither panel is shrunk: 450 + 16
      // (gutter) + 380 = 846 sits well under the pair's 75% ceiling (1200)
      // at this viewport.
      setViewportWidth(1600)
      await renderMap({ settings: { detail_panel_width: '450' }, subagentPanel: openSubagentPanel() })

      const zoomStack = screen
        .getByRole('button', { name: 'Zoom in' })
        .closest('[data-overlay="zoom-column"]') as HTMLElement
      expect(zoomStack.style.right).toBe('886px')
      const readout = screen.getByText(/ENDED/).closest('[data-overlay="aggregate"]') as HTMLElement
      expect(readout.style.right).toBe('886px')
    })

    it('reflects the shrunk detail AND subagent widths once the pair ceiling bites (fix round 1: gutter-inclusive)', async () => {
      // Ceiling at 1000px viewport = 750; 450 + 16 (gutter) + 380 overshoots
      // it hard enough that BOTH panels give way, resolving to {360, 374}
      // (`resolvePanelPairWidths`'s own "locks the gutter-inclusive reading
      // in at V=1000" test covers the arithmetic — this is the same
      // viewport, deliberately). The overlay must offset by the RESOLVED
      // widths, not the stored 450 or the subagent's 380 default:
      // 360 + 16 + 374 + 16 + 24 = 790.
      setViewportWidth(1000)
      await renderMap({ settings: { detail_panel_width: '450' }, subagentPanel: openSubagentPanel() })

      const zoomStack = screen
        .getByRole('button', { name: 'Zoom in' })
        .closest('[data-overlay="zoom-column"]') as HTMLElement
      expect(zoomStack.style.right).toBe('790px')
    })
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
    globalThis.ResizeObserver = NoopObserver
  })

  // The tween is driven by real `requestAnimationFrame`/`performance.now()`
  // elapsed-time deltas, so counting on wall-clock ticks to land it exactly on
  // MIN_ZOOM is load-sensitive (docs/fixes/spacemap-zoom-accumulation-flakes-under-load.md):
  // under CPU contention a real `setTimeout` settle can resolve before every
  // rAF the run scheduled has actually run. Fake timers make the clock (and
  // rAF, which vitest fakes along with it) deterministic, so `settle` below
  // advances a virtual clock instead of waiting on the real one.
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function renderMap() {
    useOrbital.setState({
      sessions: { a: makeSession({ id: 'a', tagIds: [1], lastAt: Date.now() }) },
      order: ['a'],
      tags: [workTag, personalTag, defaultTag],
      rules: [],
      settings: {},
      transcripts: {},
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

  /** Lets the rAF-driven tween run to completion, on the fake clock. */
  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ZOOM_STEP_SETTLE_MS)
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

// Fit is the map's "show me everything": it has to survive a reload, answer
// to a shortcut, and account for the panels sitting on top of the map.
describe('SpaceMap fit', () => {
  let uninstallKeys: () => void

  beforeAll(() => {
    class NoopObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = NoopObserver
    // jsdom lays nothing out, so the map container measures 0×0 and every fit
    // would collapse to MIN_ZOOM — which is the same number whatever the
    // insets are, and so would pass no matter what this code did. Give the
    // container a real box so the arithmetic is the thing under test.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1440,
      bottom: 900,
      width: 1440,
      height: 900,
      toJSON: () => ({}),
    })
    // `main.tsx` installs the app's one keydown listener; SpaceMap alone does not.
    uninstallKeys = installKeyListener()
  })

  afterAll(() => {
    uninstallKeys()
    vi.restoreAllMocks()
  })

  async function renderMap(
    overrides: Partial<Omit<OrbitalState, 'ui'>> & { ui?: Partial<OrbitalUiState> } = {},
  ) {
    useOrbital.setState({
      // One session, one cluster: a wider map fits at MIN_ZOOM in jsdom's
      // 1024×768, and a clamped fit cannot show the insets changing anything.
      sessions: { a: makeSession({ id: 'a', tagIds: [1], lastAt: Date.now() }) },
      order: ['a'],
      tags: [workTag, personalTag, defaultTag],
      rules: [],
      settings: {},
      transcripts: {},
      historyLoaded: {},
      toast: null,
      ...overrides,
      // `urlRestored` is what the fit-on-load waits for — the real app sets
      // it once the `?session=` restore settles, so a mounted map that has
      // finished loading always has it.
      ui: { ...defaultUi, selectedId: null, urlRestored: true, ...(overrides.ui ?? {}) },
    })
    const { SpaceMap } = await import('../map/SpaceMap')
    return render(<SpaceMap />)
  }

  function zoomPercent(): number {
    const readout = screen.getByText(/% · x/)
    return Number(readout.textContent?.match(/^(\d+)%/)?.[1])
  }

  /** The `x` of the HUD's `NN% · x … y …` readout. */
  function cameraX(): number {
    const readout = screen.getByText(/% · x/)
    return Number(readout.textContent?.match(/x (-?\d+)/)?.[1])
  }

  /**
   * Lets the fit flight finish. Fit eases over `FIT_FLIGHT_MS` of real
   * animation frames rather than cutting, so the camera it lands on is not
   * there on the frame the control was pressed.
   */
  async function settleFit() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FIT_SETTLE_MS))
    })
  }

  it('fits on load instead of opening at the fixed default camera', async () => {
    await renderMap()
    // The load fit and the button's fit are the same operation, so pressing
    // the button must be a no-op. If the load fit never ran, the map would
    // still be sitting at the default zoom and the button would move it.
    const onLoad = zoomPercent()
    fireEvent.click(screen.getByRole('button', { name: 'Fit view' }))
    expect(zoomPercent()).toBe(onLoad)
  })

  it('waits for the ?session= restore before fitting, so the panel it opens is in the arithmetic', async () => {
    // Fitting the moment planets exist would frame the full viewport and then
    // let the deep link's detail panel open over the result — the sessions
    // back under a panel, which is the whole bug.
    await renderMap({ ui: { urlRestored: false } })
    expect(zoomPercent()).toBe(60)

    await act(async () => {
      useOrbital.setState((s) => ({ ui: { ...s.ui, urlRestored: true, selectedId: 'a' } }))
    })
    expect(zoomPercent()).not.toBe(60)
  })

  it('fits into the strip left by the panels — an open detail panel zooms out further', async () => {
    const { unmount } = await renderMap({ ui: { selectedId: null } })
    const noPanel = zoomPercent()
    unmount()

    await renderMap({ ui: { selectedId: 'a' } })
    expect(zoomPercent()).toBeLessThan(noPanel)
  })

  it('pushes the framed map clear of a sidebar dragged wider', async () => {
    const { unmount } = await renderMap({ settings: { sidebar_width: '300' } })
    const narrow = cameraX()
    unmount()

    // The camera's x is the world point at the VIEWPORT centre, and the fit
    // centres the map in the strip to the right of the sidebar — so a wider
    // sidebar moves that world point left.
    await renderMap({ settings: { sidebar_width: '560' } })
    expect(cameraX()).toBeLessThan(narrow)
  })

  it('⌘F fits, from wherever the camera has been left', async () => {
    await renderMap()
    const fitted = zoomPercent()

    fireEvent.wheel(screen.getByTestId('map-surface'), { deltaY: -400 })
    expect(zoomPercent()).toBeGreaterThan(fitted)

    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', metaKey: true })
    await settleFit()
    expect(zoomPercent()).toBe(fitted)
  })

  it('flies to the fitted frame rather than cutting to it', async () => {
    await renderMap()
    const fitted = zoomPercent()
    fireEvent.wheel(screen.getByTestId('map-surface'), { deltaY: -400 })
    const zoomed = zoomPercent()

    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', metaKey: true })
    // A few frames in, the camera has left where it was without arriving —
    // the whole point of the flight, and what a plain `setCamera` cannot do.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
    })
    const midFlight = zoomPercent()
    expect(midFlight).toBeLessThan(zoomed)
    expect(midFlight).toBeGreaterThan(fitted)

    // And it lands exactly, not merely near: every later gesture is computed
    // from this number.
    await settleFit()
    expect(zoomPercent()).toBe(fitted)
  })
})
