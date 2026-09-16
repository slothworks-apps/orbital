import { describe, it, expect } from 'vitest'
import type { SessionStatus, Subagent } from '../lib/types'
import {
  BODY_RADIUS,
  DIMMED_OPACITY,
  HALO_BREATH_MIN,
  HALO_BREATH_SEC,
  MAT_RING_MAX_SCALE,
  MAT_RING_MIN_SCALE,
  MAT_RING_SEC,
  MAT_SHELL_SEC,
  MOON_TICK_COUNT,
  MOON_TICK_WIDTH_DEG,
  easeOut,
  moonVisuals,
  oscillate,
  planetVisuals,
  truncateLabel,
} from '../map/visuals'

const PLANET_STATES: SessionStatus[] = ['working', 'idle', 'needs_input', 'ended']
const MOON_STATES: Subagent['state'][] = [
  'materializing',
  'working',
  'idle',
  'needs_input',
  'ended',
]

/**
 * The design export's own unit: artboard 1f draws every planet with a 100px
 * body (50px radius), so a length quoted there in px maps to
 * `designPx / 50 * BODY_RADIUS` in the scene. Tests below quote the export's
 * `inset:`/size values directly and convert with this.
 */
const px = (designPx: number) => (designPx / 50) * BODY_RADIUS
/** `animation: orb-spin <sec> linear infinite` → radians/sec. */
const spin = (seconds: number) => (Math.PI * 2) / seconds
/** Moons are quoted in absolute px beside the 100px body → 0.01 units/px. */
const moonPx = (designPx: number) => designPx * 0.01

describe('planetVisuals', () => {
  it('working: 60 dense ticks spinning at the export 24s period (1.2deg/6deg conic, inset -26, 8px band)', () => {
    const v = planetVisuals('working', false)
    expect(v.tickCount).toBe(60)
    expect(v.tickWidthDeg).toBe(1.2)
    expect(v.tickOpacity).toBe(0.9)
    expect(v.tickSpin).toBeCloseTo(spin(24), 10)
    // mask band 76px → 68px, so the mid-radius is 72px and the tick is 8px long
    expect(v.tickRadius).toBeCloseTo(px(72), 10)
    expect(v.tickLength).toBeCloseTo(px(8), 10)
  })

  it('working: thin inner 4-arc ring at .5, counter-rotating on the 60s reverse period', () => {
    const v = planetVisuals('working', false)
    expect(v.arcOpacity).toBe(0.5)
    // `animation: orb-spin 60s linear infinite reverse` → negative angular speed
    expect(v.arcSpin).toBeCloseTo(-spin(60), 10)
    expect(v.arcSpin).toBeLessThan(0)
    // and it spins against the tick ring, never with it
    expect(Math.sign(v.arcSpin)).toBe(-Math.sign(v.tickSpin))
  })

  it('only working carries the arc ring and the breathing halo', () => {
    for (const state of PLANET_STATES) {
      const v = planetVisuals(state, false)
      expect(v.arcOpacity > 0).toBe(state === 'working')
      expect(v.arcSpin !== 0).toBe(state === 'working')
      expect(v.haloOpacity > 0).toBe(state === 'working')
      expect(v.haloBreathes).toBe(state === 'working')
    }
    expect(planetVisuals('working', false).haloOpacity).toBe(0.18)
  })

  it('working: pulsing full core blinking on the 2.4s orb-blink period, 16px wide', () => {
    const v = planetVisuals('working', false)
    expect(v.corePulse).toBe(1)
    expect(v.corePulseSec).toBe(2.4)
    expect(v.coreOpacity).toBe(1)
    expect(v.coreRadius).toBeCloseTo(px(8), 10)
    expect(v.rippleActive).toBe(false)
    expect(v.dimmed).toBe(false)
  })

  it('idle: 45 static ticks at .45 (1.5deg/8deg conic, inset -21, 7px band), steady .8 core', () => {
    const v = planetVisuals('idle', false)
    expect(v.tickCount).toBe(45)
    expect(v.tickWidthDeg).toBe(1.5)
    expect(v.tickOpacity).toBe(0.45)
    expect(v.tickSpin).toBe(0)
    expect(v.tickRadius).toBeCloseTo(px(67.5), 10)
    expect(v.tickLength).toBeCloseTo(px(7), 10)
    expect(v.coreOpacity).toBe(0.8)
    expect(v.coreRadius).toBeCloseTo(px(7), 10)
    expect(v.corePulse).toBe(0)
    expect(v.rippleActive).toBe(false)
    expect(v.dimmed).toBe(false)
  })

  it('needs_input: the idle tick ring exactly, plus a ripple and a faster 1.2s core blink', () => {
    const idle = planetVisuals('idle', false)
    const v = planetVisuals('needs_input', false)
    expect(v.tickCount).toBe(idle.tickCount)
    expect(v.tickWidthDeg).toBe(idle.tickWidthDeg)
    expect(v.tickOpacity).toBe(idle.tickOpacity)
    expect(v.tickRadius).toBe(idle.tickRadius)
    expect(v.tickLength).toBe(idle.tickLength)
    expect(v.tickSpin).toBe(0)
    expect(v.rippleActive).toBe(true)
    expect(v.corePulse).toBe(1)
    expect(v.corePulseSec).toBe(1.2)
    expect(v.coreOpacity).toBe(1)
    expect(v.coreRadius).toBeCloseTo(px(8), 10)
    expect(v.dimmed).toBe(false)
  })

  it('ended: 30 grey ticks at .4 (2deg/12deg conic, inset -22, 3px band), no core, dimmed', () => {
    const v = planetVisuals('ended', false)
    expect(v.tickCount).toBe(30)
    expect(v.tickWidthDeg).toBe(2)
    expect(v.tickOpacity).toBe(0.4)
    expect(v.tickSpin).toBe(0)
    expect(v.tickRadius).toBeCloseTo(px(70.5), 10)
    expect(v.tickLength).toBeCloseTo(px(3), 10)
    expect(v.coreOpacity).toBe(0)
    expect(v.corePulse).toBe(0)
    expect(v.rippleActive).toBe(false)
    expect(v.dimmed).toBe(true)
  })

  it('only needs_input runs the white ripple', () => {
    for (const state of PLANET_STATES) {
      expect(planetVisuals(state, false).rippleActive).toBe(state === 'needs_input')
    }
  })

  it('only the tick ring ever spins by itself — every other state is static', () => {
    for (const state of PLANET_STATES) {
      if (state === 'working') continue
      const v = planetVisuals(state, false)
      expect(v.tickSpin).toBe(0)
      expect(v.arcSpin).toBe(0)
    }
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

  it('returns a fresh object each call, never the shared table entry', () => {
    const a = planetVisuals('working', false)
    const b = planetVisuals('working', false)
    expect(a).not.toBe(b)
    a.tickCount = 0
    expect(planetVisuals('working', false).tickCount).toBe(60)
  })
})

describe('moonVisuals', () => {
  it('working: 26px disc with a hue/.9 rim, 20-tick micro ring spinning on the 8s period', () => {
    const v = moonVisuals('working')
    expect(v.discRadius).toBeCloseTo(moonPx(13), 10)
    expect(v.rimOpacity).toBe(0.9)
    expect(v.tickSpin).toBeCloseTo(spin(8), 10)
    expect(MOON_TICK_COUNT).toBe(20) // 4deg on / 18deg pitch
    expect(MOON_TICK_WIDTH_DEG).toBe(4)
    expect(v.coreRadius).toBeCloseTo(moonPx(3), 10)
    expect(v.coreOpacity).toBe(1)
    expect(v.corePulse).toBe(1)
    expect(v.corePulseSec).toBe(1.4)
    expect(v.glowOpacity).toBe(0.7) // box-shadow: 0 0 16px hue/.7
    expect(v.glowSize).toBeCloseTo(moonPx(26 + 2 * 16), 10)
    expect(v.rippleActive).toBe(false)
    expect(v.matRing).toBe(false)
    expect(v.dashedShell).toBe(false)
    expect(v.dimmed).toBe(false)
  })

  it('idle: 22px disc, hue/.7 rim, no ticks, static dim 4px core', () => {
    const v = moonVisuals('idle')
    expect(v.discRadius).toBeCloseTo(moonPx(11), 10)
    expect(v.rimOpacity).toBe(0.7)
    expect(v.tickSpin).toBe(0)
    expect(v.coreRadius).toBeCloseTo(moonPx(2), 10)
    expect(v.coreOpacity).toBe(0.8)
    expect(v.corePulse).toBe(0)
    expect(v.glowOpacity).toBe(0.4) // 0 0 10px hue/.4
    expect(v.rippleActive).toBe(false)
    expect(v.dimmed).toBe(false)
  })

  it('needs_input: the idle disc plus a white ripple and a 1.2s-blinking 6px core', () => {
    const idle = moonVisuals('idle')
    const v = moonVisuals('needs_input')
    expect(v.discRadius).toBe(idle.discRadius)
    expect(v.rimOpacity).toBe(idle.rimOpacity)
    expect(v.rippleActive).toBe(true)
    expect(v.matRing).toBe(false)
    expect(v.coreRadius).toBeCloseTo(moonPx(3), 10)
    expect(v.coreOpacity).toBe(1)
    expect(v.corePulse).toBe(1)
    expect(v.corePulseSec).toBe(1.2)
    expect(v.dimmed).toBe(false)
  })

  it('materializing: dashed shell + a HUE expanding ring (not the white needs-input ripple), no core', () => {
    const v = moonVisuals('materializing')
    expect(v.dashedShell).toBe(true)
    expect(v.matRing).toBe(true)
    // the white `orb-pulse-out` ripple belongs to needs-input only
    expect(v.rippleActive).toBe(false)
    expect(v.discRadius).toBeCloseTo(moonPx(12), 10)
    expect(v.rimOpacity).toBe(0) // the dashed shell replaces the solid rim
    expect(v.coreRadius).toBe(0)
    expect(v.coreOpacity).toBe(0)
    expect(v.glowOpacity).toBe(0.6) // 0 0 14px hue/.6
    expect(v.tickSpin).toBe(0)
    expect(v.dimmed).toBe(false)
  })

  it('ended: 16px grey disc, no core, no glow, orbit trail fades', () => {
    const v = moonVisuals('ended')
    expect(v.discRadius).toBeCloseTo(moonPx(8), 10)
    expect(v.rimOpacity).toBe(0.35)
    expect(v.coreRadius).toBe(0)
    expect(v.coreOpacity).toBe(0)
    expect(v.glowOpacity).toBe(0)
    expect(v.dimmed).toBe(true)
    expect(v.trailOpacity).toBeLessThan(moonVisuals('working').trailOpacity)
  })

  it('every active state draws the orbit trail at the export 0.22', () => {
    for (const state of MOON_STATES) {
      if (state === 'ended') continue
      expect(moonVisuals(state).trailOpacity).toBe(0.22)
    }
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

describe('animation helpers', () => {
  it('oscillate reproduces a CSS ease-in-out A → B → A keyframe cycle', () => {
    expect(oscillate(0, 2.4)).toBeCloseTo(0, 10)
    expect(oscillate(1.2, 2.4)).toBeCloseTo(1, 10)
    expect(oscillate(2.4, 2.4)).toBeCloseTo(0, 10)
    // periodic: the next cycle repeats exactly
    expect(oscillate(3.6, 2.4)).toBeCloseTo(oscillate(1.2, 2.4), 10)
    // guards against a division by zero for states with no pulse
    expect(oscillate(5, 0)).toBe(0)
  })

  it('easeOut runs 0 → 1 and front-loads the motion, like CSS ease-out', () => {
    expect(easeOut(0)).toBe(0)
    expect(easeOut(1)).toBe(1)
    expect(easeOut(0.5)).toBeGreaterThan(0.5)
  })

  it('exports the export-derived animation constants the components drive', () => {
    expect(HALO_BREATH_SEC).toBe(2.4) // orb-ring 2.4s
    expect(HALO_BREATH_MIN).toBe(0.55) // orb-ring: opacity .55 → 1 → .55
    expect(MAT_RING_SEC).toBe(1.8) // orb-matring 1.8s
    expect(MAT_RING_MIN_SCALE).toBe(0.6) // orb-matring: scale .6 → 2
    expect(MAT_RING_MAX_SCALE).toBe(2)
    expect(MAT_SHELL_SEC).toBe(1.8) // orb-mat 1.8s
    expect(DIMMED_OPACITY).toBe(0.6) // ended bodies sit inside opacity:.6
  })
})

describe('truncateLabel', () => {
  it('passes short titles through unchanged', () => {
    expect(truncateLabel('auth-refactor')).toBe('auth-refactor')
  })

  it('shortens long titles with an ellipsis at the cap', () => {
    const long = 'Pomoz mi vymyslet finální název pro tento projekt a jeho moduly'
    const out = truncateLabel(long)
    expect(out.length).toBeLessThanOrEqual(26)
    expect(out.endsWith('…')).toBe(true)
  })
})
