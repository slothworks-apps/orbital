import { describe, expect, it } from 'vitest'
import type { ApiSession } from '../lib/types'
import { reuseContextFills, type ContextFill, type SceneModel, type ScenePlanet } from '../map/sceneModel'

function planet(id: string, contextFill: ContextFill | null): ScenePlanet {
  return {
    session: { id } as ApiSession,
    x: 0,
    y: 0,
    scale: 1,
    selected: false,
    hue: 0,
    tagId: 1,
    subagents: [],
    footprint: 1,
    leaving: false,
    modelFamily: null,
    muted: false,
    contextFill,
    compactingSince: null,
  }
}

function model(planets: ScenePlanet[]): SceneModel {
  return {
    planets,
    moons: [],
    labels: [],
    counts: { working: 0, idle: 0, needs_input: 0, ended: 0 },
    anchors: [],
    hole: { x: 0, y: 0, count: 0 },
  }
}

// `Planet` is memoised on shallow props: a fill that says the same thing must
// be the same object, or every gauged planet re-renders on every event.
describe('reuseContextFills', () => {
  it('keeps the previous fill object where it says the same thing, and takes the new one where it changed', () => {
    const same = { fraction: 0.4, level: 'ok' } as ContextFill
    const old = { fraction: 0.4, level: 'ok' } as ContextFill
    const previous = model([planet('a', same), planet('b', old)])
    const moved = { fraction: 0.9, level: 'critical' } as ContextFill
    const next = reuseContextFills(
      model([planet('a', { ...same }), planet('b', moved), planet('c', { fraction: 0.1, level: 'ok' })]),
      previous,
    )

    expect(next.planets[0].contextFill).toBe(same)
    expect(next.planets[1].contextFill).toBe(moved)
    expect(next.planets[2].contextFill).toEqual({ fraction: 0.1, level: 'ok' })
  })

  it('leaves a gauge that went away as null', () => {
    const previous = model([planet('a', { fraction: 0.4, level: 'ok' })])
    expect(reuseContextFills(model([planet('a', null)]), previous).planets[0].contextFill).toBeNull()
  })
})
