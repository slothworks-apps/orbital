import { describe, it, expect } from 'vitest'
import type { SessionStatus, Subagent } from '../lib/types'
import { planetVisuals, moonVisuals, type PlanetVisuals, type MoonVisuals } from '../map/visuals'

const PLANET_STATES: SessionStatus[] = ['working', 'idle', 'needs_input', 'ended']
const MOON_STATES: Subagent['state'][] = [
  'materializing',
  'working',
  'idle',
  'needs_input',
  'ended',
]

describe('planetVisuals', () => {
  it('working: ticks rotate, core pulses, halo breathes, no ripple, not dimmed', () => {
    const v = planetVisuals('working', false)
    expect(v).toEqual<PlanetVisuals>({
      tickSpin: 0.4,
      corePulse: 1,
      haloOpacity: 0.5,
      haloBreathes: true,
      rippleActive: false,
      dimmed: false,
      reticle: false,
    })
  })

  it('idle: ticks static, steady (non-pulsing) core, dimmer halo', () => {
    const v = planetVisuals('idle', false)
    expect(v).toEqual<PlanetVisuals>({
      tickSpin: 0,
      corePulse: 0,
      haloOpacity: 0.25,
      haloBreathes: false,
      rippleActive: false,
      dimmed: false,
      reticle: false,
    })
  })

  it('needs_input: ripple active (white core/ring carried by the component, not this table)', () => {
    const v = planetVisuals('needs_input', false)
    expect(v).toEqual<PlanetVisuals>({
      tickSpin: 0,
      corePulse: 1,
      haloOpacity: 0.5,
      haloBreathes: false,
      rippleActive: true,
      dimmed: false,
      reticle: false,
    })
  })

  it('ended: dimmed, no halo, no tick spin, no core pulse, no ripple', () => {
    const v = planetVisuals('ended', false)
    expect(v).toEqual<PlanetVisuals>({
      tickSpin: 0,
      corePulse: 0,
      haloOpacity: 0,
      haloBreathes: false,
      rippleActive: false,
      dimmed: true,
      reticle: false,
    })
  })

  it('haloBreathes is true only for working — the halo is otherwise steady', () => {
    expect(planetVisuals('working', false).haloBreathes).toBe(true)
    expect(planetVisuals('idle', false).haloBreathes).toBe(false)
    expect(planetVisuals('needs_input', false).haloBreathes).toBe(false)
    expect(planetVisuals('ended', false).haloBreathes).toBe(false)
  })

  it('selected flag only ever changes `reticle`, orthogonal to state', () => {
    for (const state of PLANET_STATES) {
      const unselected = planetVisuals(state, false)
      const selected = planetVisuals(state, true)
      expect(selected).toEqual({ ...unselected, reticle: true })
      expect(unselected.reticle).toBe(false)
    }
  })

  it('never includes a hue/color field: state is carried by motion + core only', () => {
    for (const state of PLANET_STATES) {
      for (const selected of [false, true]) {
        const keys = Object.keys(planetVisuals(state, selected))
        expect(keys.some((k) => /hue|color/i.test(k))).toBe(false)
      }
    }
  })
})

describe('moonVisuals', () => {
  it('working: micro tick ring spins, full core opacity, no ripple/shell, dim trail', () => {
    const v = moonVisuals('working')
    expect(v).toEqual<MoonVisuals>({
      tickSpin: 0.6,
      coreOpacity: 1,
      rippleActive: false,
      dashedShell: false,
      dimmed: false,
      trailOpacity: 0.4,
    })
  })

  it('idle: static disc, dim core', () => {
    const v = moonVisuals('idle')
    expect(v).toEqual<MoonVisuals>({
      tickSpin: 0,
      coreOpacity: 0.5,
      rippleActive: false,
      dashedShell: false,
      dimmed: false,
      trailOpacity: 0.25,
    })
  })

  it('needs_input: white ripple', () => {
    const v = moonVisuals('needs_input')
    expect(v).toEqual<MoonVisuals>({
      tickSpin: 0,
      coreOpacity: 1,
      rippleActive: true,
      dashedShell: false,
      dimmed: false,
      trailOpacity: 0.4,
    })
  })

  it('materializing: dashed shell fades in, ripple expands, core still forming', () => {
    const v = moonVisuals('materializing')
    expect(v).toEqual<MoonVisuals>({
      tickSpin: 0,
      coreOpacity: 0.3,
      rippleActive: true,
      dashedShell: true,
      dimmed: false,
      trailOpacity: 0.15,
    })
  })

  it('ended: grey disc, orbit trail fades', () => {
    const v = moonVisuals('ended')
    expect(v).toEqual<MoonVisuals>({
      tickSpin: 0,
      coreOpacity: 0.3,
      rippleActive: false,
      dashedShell: false,
      dimmed: true,
      trailOpacity: 0.08,
    })
  })

  it('never includes a hue/color field: state is carried by motion + core only', () => {
    for (const state of MOON_STATES) {
      const keys = Object.keys(moonVisuals(state))
      expect(keys.some((k) => /hue|color/i.test(k))).toBe(false)
    }
  })

  it('returns a fresh object each call, never the shared table entry', () => {
    const a = moonVisuals('working')
    const b = moonVisuals('working')
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
    // Mutating one caller's result must never leak into another caller's.
    a.coreOpacity = 0
    expect(moonVisuals('working').coreOpacity).toBe(1)
  })
})
