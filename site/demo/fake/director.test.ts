import { describe, expect, it } from 'vitest'
import { INITIAL_DIRECTOR, stepDirector, type DirectorState } from './director'

const tick = { kind: 'tick', reducedMotion: false } as const
const reducedTick = { kind: 'tick', reducedMotion: true } as const

function run(durations: number[], ticks: number, from: DirectorState = INITIAL_DIRECTOR): DirectorState {
  let state = from
  for (let i = 0; i < ticks; i++) state = stepDirector(durations, state, tick)
  return state
}

describe('stepDirector', () => {
  it('holds each beat for its own number of ticks', () => {
    expect(run([3, 1], 2).beat).toBe(0)
    expect(run([3, 1], 3).beat).toBe(1)
    expect(run([3, 1], 4).beat).toBe(0)
  })

  it('starts over after the last beat', () => {
    const durations = [2, 2, 2]
    expect(run(durations, 6)).toEqual(INITIAL_DIRECTOR)
    expect(run(durations, 6 * 5 + 4).beat).toBe(2)
  })

  it('stops for good on the first interaction', () => {
    const midway = run([2, 2], 3)
    const stopped = stepDirector([2, 2], midway, { kind: 'interaction' })
    expect(stopped.stopped).toBe(true)
    expect(run([2, 2], 50, stopped)).toEqual(stopped)
    expect(stopped.beat).toBe(midway.beat)
  })

  it('does not advance on its own under reduced motion', () => {
    let state = INITIAL_DIRECTOR
    for (let i = 0; i < 20; i++) state = stepDirector([1, 1], state, reducedTick)
    expect(state).toEqual(INITIAL_DIRECTOR)
  })

  it('an interaction under reduced motion still stops it', () => {
    const stopped = stepDirector([1], INITIAL_DIRECTOR, { kind: 'interaction' })
    expect(run([1, 1], 5, stopped)).toEqual(stopped)
  })

  it('treats a zero-length beat as one tick rather than stalling', () => {
    expect(run([0, 5], 1).beat).toBe(1)
  })
})
