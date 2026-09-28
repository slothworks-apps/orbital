import { describe, it, expect } from 'vitest'
import { sessionStateKey, statePill, type ApiSession, type SessionStateKey } from '../lib/types'
import { stateDot, stateWord, STATE_TONE, type StateSurface } from '../lib/stateStyle'

type Shape = Pick<ApiSession, 'status' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents'>

const session = (over: Partial<Shape> = {}): Shape => ({
  status: 'working',
  interruptedAt: null,
  pendingDecision: null,
  awaitingSubagents: false,
  subagents: [],
  ...over,
})
const asking = { kind: 'permission' } as unknown as ApiSession['pendingDecision']
const moon = { id: 'm', name: 'm', state: 'working' as const, startedAt: 0 }

describe('sessionStateKey', () => {
  it('lets INTERRUPTED displace every status, a parked question included', () => {
    expect(sessionStateKey(session({ status: 'needs_input', interruptedAt: 1, pendingDecision: asking }))).toBe(
      'interrupted'
    )
    expect(sessionStateKey(session({ status: 'working', interruptedAt: 1 }))).toBe('interrupted')
  })

  it('splits needs_input by why it stopped, and working by where the work is', () => {
    expect(sessionStateKey(session({ status: 'needs_input', pendingDecision: asking }))).toBe('needs_input')
    expect(sessionStateKey(session({ status: 'needs_input' }))).toBe('done')
    expect(sessionStateKey(session({ awaitingSubagents: true, subagents: [moon] }))).toBe('waiting')
    // Flagged as waiting but with every moon ended: nothing to wait on.
    expect(sessionStateKey(session({ awaitingSubagents: true, subagents: [{ ...moon, state: 'ended' }] }))).toBe(
      'working'
    )
    expect(sessionStateKey(session())).toBe('working')
    expect(sessionStateKey(session({ status: 'idle' }))).toBe('idle')
    expect(sessionStateKey(session({ status: 'ended' }))).toBe('ended')
  })

  it('gives the map a pill exactly for the states the planet body does not already tell', () => {
    const withPill = (over: Partial<Shape>) => statePill(session(over))?.key ?? null
    expect(withPill({ status: 'needs_input', pendingDecision: asking })).toBe('needs_input')
    expect(withPill({ status: 'needs_input' })).toBe('done')
    expect(withPill({ status: 'idle', interruptedAt: 1 })).toBe('interrupted')
    expect(withPill({ awaitingSubagents: true, subagents: [moon] })).toBe('waiting')
    expect(withPill({})).toBeNull()
    expect(withPill({ status: 'idle' })).toBeNull()
    expect(withPill({ status: 'ended' })).toBeNull()
  })
})

const PILL_STATES: SessionStateKey[] = ['needs_input', 'waiting', 'interrupted', 'done']

describe('stateDot', () => {
  // The acceptance criterion "every state is distinguishable in greyscale, in
  // both modes": with the word showing, the colour-free cue is the word; in
  // dot mode it is the dot alone, so no two pill states may share a shape.
  it('gives every pill state its own dot in dot mode', () => {
    const shapes = PILL_STATES.map((key) => stateDot(key, 'dot'))
    expect(shapes.every((dot) => dot.shape !== 'none')).toBe(true)
    expect(new Set(shapes.map((dot) => `${dot.shape}/${dot.motion}`)).size).toBe(PILL_STATES.length)
  })

  it('draws INTERRUPTED and DONE with no dot while the word is spelled out', () => {
    for (const surface of ['label', 'chip'] as StateSurface[]) {
      expect(stateDot('interrupted', surface).shape).toBe('none')
      expect(stateDot('done', surface).shape).toBe('none')
    }
  })

  it('animates only NEEDS INPUT and WAITING, plus the chip’s WORKING', () => {
    const all = Object.keys(STATE_TONE) as SessionStateKey[]
    for (const surface of ['label', 'dot', 'chip'] as StateSurface[]) {
      const moving = all.filter((key) => {
        const dot = stateDot(key, surface)
        return dot.shape !== 'none' && dot.motion !== 'steady'
      })
      expect(moving.sort()).toEqual(
        (surface === 'chip' ? ['needs_input', 'waiting', 'working'] : ['needs_input', 'waiting']).sort()
      )
    }
  })

  it('keeps NEEDS INPUT and WAITING the same shape in both map modes', () => {
    for (const key of ['needs_input', 'waiting'] as const) {
      expect(stateDot(key, 'dot')).toEqual(stateDot(key, 'label'))
    }
  })
})

describe('stateWord', () => {
  it('shortens only for the sidebar row', () => {
    expect(stateWord('needs_input', 0)).toBe('NEEDS INPUT')
    expect(stateWord('needs_input', 0, true)).toBe('INPUT')
    expect(stateWord('waiting', 1)).toBe('WAITING FOR')
    expect(stateWord('waiting', 2, true)).toBe('WAITING · 2')
    expect(stateWord('interrupted', 0, true)).toBe('INTERRUPTED')
  })
})
