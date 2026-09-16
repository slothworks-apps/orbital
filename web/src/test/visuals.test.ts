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
import {
  MOON_STATES as MIX_MOON_STATES,
  PLANET_STATES as MIX_PLANET_STATES,
  PLANET_TICK_LAYERS,
  RETICLE_ENTER_MS,
  RETICLE_EXIT_MS,
  STATE_TRANSITION_MS,
  BODY_MOVE_MS,
  advancePointTween,
  advanceStateMix,
  advanceTween,
  blendMoon,
  blendPlanet,
  createMoonBlend,
  createPlanetBlend,
  createPointTween,
  createStateMix,
  createTween,
  endedHideTransform,
  ENDED_HIDDEN_SCALE,
  ENDED_HIDE_MS,
  easeMotion,
  retargetHueTween,
  retargetPointTween,
  retargetStateMix,
  retargetTween,
  shortestHueDelta,
  stackAlphas,
  tickLayerWeight,
} from '../map/transition'

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

// ---------------------------------------------------------------------------
// The interpolation layer above the state table (`map/transition.ts`).
//
// jsdom has no WebGL, so none of this tests pixels. It tests the layer as what
// it actually is: pure functions from (previous weights, target state,
// progress) to a set of numbers, plus the rule that fields with no midpoint
// crossfade instead of blending.
// ---------------------------------------------------------------------------

describe('easeMotion', () => {
  it('is the app curve cubic-bezier(.2,.8,.2,1): pinned ends, front-loaded middle', () => {
    expect(easeMotion(0)).toBe(0)
    expect(easeMotion(1)).toBe(1)
    expect(easeMotion(-1)).toBe(0)
    expect(easeMotion(2)).toBe(1)
    // .2/.8 control points mean most of the distance is covered early.
    expect(easeMotion(0.5)).toBeGreaterThan(0.85)
  })

  it('is monotonic, so a transition never runs backwards mid-flight', () => {
    let previous = -1
    for (let i = 0; i <= 50; i++) {
      const value = easeMotion(i / 50)
      expect(value).toBeGreaterThanOrEqual(previous)
      previous = value
    }
  })
})

describe('stateMix', () => {
  /** Runs a mix forward in `steps` equal frames covering `seconds`. */
  function run(mix: ReturnType<typeof createStateMix<SessionStatus>>, seconds: number, steps = 10) {
    for (let i = 0; i < steps; i++) advanceStateMix(mix, seconds / steps)
  }

  it('starts one-hot and idle: a body at rest does no blend work at all', () => {
    const mix = createStateMix(MIX_PLANET_STATES, 'working')
    expect(mix.weights.working).toBe(1)
    expect(mix.weights.idle).toBe(0)
    expect(mix.active).toBe(false)
    // An inactive mix reports "nothing to apply" without touching a weight.
    expect(advanceStateMix(mix, 0.016)).toBe(false)
  })

  it('eases the weights across, always summing to 1, and settles exactly on target', () => {
    const mix = createStateMix(MIX_PLANET_STATES, 'working')
    retargetStateMix(mix, 'idle')
    run(mix, STATE_TRANSITION_MS / 2 / 1000)
    const total = PLANET_STATES.reduce((sum, s) => sum + mix.weights[s], 0)
    expect(total).toBeCloseTo(1, 10)
    expect(mix.weights.working).toBeGreaterThan(0)
    expect(mix.weights.working).toBeLessThan(1)
    expect(mix.weights.idle).toBeGreaterThan(0)

    run(mix, STATE_TRANSITION_MS / 1000)
    expect(mix.weights.idle).toBe(1)
    expect(mix.weights.working).toBe(0)
    expect(mix.active).toBe(false)
  })

  it('is framerate independent: one long frame lands where many short ones do', () => {
    const coarse = createStateMix(MIX_PLANET_STATES, 'working')
    const fine = createStateMix(MIX_PLANET_STATES, 'working')
    retargetStateMix(coarse, 'ended')
    retargetStateMix(fine, 'ended')
    advanceStateMix(coarse, 0.2)
    run(fine, 0.2, 12)
    expect(coarse.weights.ended).toBeCloseTo(fine.weights.ended, 10)
  })

  it('an interrupted transition retargets from where it actually is, not from the old target', () => {
    const mix = createStateMix(MIX_PLANET_STATES, 'working')
    retargetStateMix(mix, 'idle')
    run(mix, STATE_TRANSITION_MS / 2 / 1000)
    const workingMidway = mix.weights.working
    const idleMidway = mix.weights.idle
    expect(workingMidway).toBeGreaterThan(0)

    retargetStateMix(mix, 'ended')
    // The new starting point is the live blend — not a restart from pure idle.
    expect(mix.from.working).toBe(workingMidway)
    expect(mix.from.idle).toBe(idleMidway)
    expect(mix.weights.ended).toBe(0)
    // ...and the very next frame moves off that blend continuously.
    advanceStateMix(mix, 0.016)
    expect(mix.weights.working).toBeLessThan(workingMidway)
    expect(mix.weights.ended).toBeGreaterThan(0)
    run(mix, STATE_TRANSITION_MS / 1000)
    expect(mix.weights.ended).toBe(1)
  })

  it('retargeting to the state already in flight keeps that transition running', () => {
    const mix = createStateMix(MIX_PLANET_STATES, 'working')
    retargetStateMix(mix, 'idle')
    run(mix, STATE_TRANSITION_MS / 2 / 1000)
    const elapsed = mix.elapsedMs
    retargetStateMix(mix, 'idle')
    expect(mix.elapsedMs).toBe(elapsed)
  })

  it('reduced motion snaps to the target: correct immediately, with no interpolation', () => {
    const mix = createStateMix(MIX_PLANET_STATES, 'working')
    retargetStateMix(mix, 'ended', true)
    expect(mix.weights.ended).toBe(1)
    expect(mix.weights.working).toBe(0)
    // One frame to write the snapped values out, then nothing.
    expect(advanceStateMix(mix, 0.016)).toBe(true)
    expect(mix.weights.ended).toBe(1)
    expect(advanceStateMix(mix, 0.016)).toBe(false)
  })
})

describe('blendPlanet', () => {
  /** A one-hot weight vector, i.e. a body at rest in `state`. */
  function only(state: SessionStatus): Record<SessionStatus, number> {
    return {
      working: state === 'working' ? 1 : 0,
      idle: state === 'idle' ? 1 : 0,
      needs_input: state === 'needs_input' ? 1 : 0,
      ended: state === 'ended' ? 1 : 0,
    }
  }

  it('at rest reproduces the state table exactly — the design values are untouched', () => {
    for (const state of PLANET_STATES) {
      const v = planetVisuals(state, false)
      const b = blendPlanet(only(state), createPlanetBlend())
      expect(b.tickSpin).toBeCloseTo(v.tickSpin, 12)
      expect(b.arcOpacity).toBeCloseTo(v.arcOpacity, 12)
      expect(b.arcSpin).toBeCloseTo(v.arcSpin, 12)
      expect(b.coreOpacity).toBeCloseTo(v.coreOpacity, 12)
      expect(b.coreRadius).toBeCloseTo(v.coreRadius, 12)
      expect(b.haloOpacity).toBeCloseTo(v.haloOpacity, 12)
      expect(b.corePulse).toBeCloseTo(v.corePulse, 12)
      expect(b.corePulseSec).toBeCloseTo(v.corePulseSec, 12)
      expect(b.dim).toBe(v.dimmed ? DIMMED_OPACITY : 1)
      expect(b.ripple).toBe(v.rippleActive ? 1 : 0)
    }
  })

  it('continuous fields land between the two states halfway through', () => {
    const half = { working: 0.5, idle: 0.5, needs_input: 0, ended: 0 }
    const b = blendPlanet(half, createPlanetBlend())
    const working = planetVisuals('working', false)
    const idle = planetVisuals('idle', false)
    expect(b.coreRadius).toBeCloseTo((working.coreRadius + idle.coreRadius) / 2, 12)
    expect(b.haloOpacity).toBeCloseTo(working.haloOpacity / 2, 12)
    expect(b.tickSpin).toBeCloseTo(working.tickSpin / 2, 12)
    expect(b.arcOpacity).toBeCloseTo(working.arcOpacity / 2, 12)
  })

  it('the ended `opacity:.6` wrapper eases in rather than switching on', () => {
    const b = blendPlanet({ working: 0, idle: 0.5, needs_input: 0, ended: 0.5 }, createPlanetBlend())
    expect(b.dim).toBeCloseTo(1 - 0.5 * (1 - DIMMED_OPACITY), 12)
    expect(b.dim).toBeGreaterThan(DIMMED_OPACITY)
    expect(b.dim).toBeLessThan(1)
  })

  it('a blink period is weighted by pulse depth, so fading to a still state never strobes', () => {
    // working (blinks at 2.4s) → idle (does not blink): the depth fades out,
    // and the period must stay at 2.4s rather than being dragged toward 0.
    const b = blendPlanet({ working: 0.25, idle: 0.75, needs_input: 0, ended: 0 }, createPlanetBlend())
    expect(b.corePulse).toBeCloseTo(0.25, 12)
    expect(b.corePulseSec).toBeCloseTo(2.4, 12)

    // Between two blinking states the period itself interpolates.
    const both = blendPlanet({ working: 0.5, idle: 0, needs_input: 0.5, ended: 0 }, createPlanetBlend())
    expect(both.corePulseSec).toBeCloseTo((2.4 + 1.2) / 2, 12)

    // Nothing pulsing at all reports no period, not an infinitely fast one.
    expect(blendPlanet({ working: 0, idle: 1, needs_input: 0, ended: 0 }, createPlanetBlend()).corePulseSec).toBe(0)
  })

  it('writes into the caller-owned object: the frame loop allocates nothing', () => {
    const out = createPlanetBlend()
    expect(blendPlanet(only('idle'), out)).toBe(out)
  })
})

describe('planet tick rings crossfade rather than blending', () => {
  it('splits the four states into the three distinct rings the export draws', () => {
    expect(PLANET_TICK_LAYERS.map((l) => l.count)).toEqual([60, 45, 30])
    // idle and needs-input share a ring byte for byte, so moving between them
    // needs no crossfade at all.
    const shared = PLANET_TICK_LAYERS.find((l) => l.count === 45)!
    expect([...shared.states].sort()).toEqual(['idle', 'needs_input'])
    // Only the ended ring is drawn grey instead of in the tag hue.
    expect(PLANET_TICK_LAYERS.filter((l) => l.grey).map((l) => l.count)).toEqual([30])
  })

  it('never invents an in-between tick count — the layer weights are what move', () => {
    const half = { working: 0.5, idle: 0.5, needs_input: 0, ended: 0 }
    const counts = PLANET_TICK_LAYERS.map((l) => l.count)
    // No layer's geometry depends on the weights at all.
    expect(counts).toEqual([60, 45, 30])
    const weights = PLANET_TICK_LAYERS.map((l) => tickLayerWeight(l, half))
    expect(weights).toEqual([0.5, 0.5, 0])
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
  })

  it('at rest exactly one ring carries the full weight', () => {
    for (const state of PLANET_STATES) {
      const weights = {
        working: state === 'working' ? 1 : 0,
        idle: state === 'idle' ? 1 : 0,
        needs_input: state === 'needs_input' ? 1 : 0,
        ended: state === 'ended' ? 1 : 0,
      }
      const live = PLANET_TICK_LAYERS.map((l) => tickLayerWeight(l, weights)).filter((w) => w > 0)
      expect(live).toEqual([1])
    }
  })
})

describe('stackAlphas', () => {
  it('turns weights into per-layer alphas that composite to the weighted sum', () => {
    const weights = [0.4, 0.4, 0.2] // bottom → top
    const alphas = stackAlphas(weights, [0, 0, 0])
    // What the renderer actually paints: layer i contributes
    // aᵢ · Π_{j>i}(1 - aⱼ) once everything above it has been drawn over it.
    const contributions = alphas.map((a, i) =>
      alphas.slice(i + 1).reduce((acc, aj) => acc * (1 - aj), a)
    )
    contributions.forEach((c, i) => expect(c).toBeCloseTo(weights[i], 12))
    // Weights summing to 1 means nothing of the background is left showing.
    expect(contributions.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12)
  })

  it('a single fully-weighted layer is opaque and hides everything under it', () => {
    expect(stackAlphas([0, 0, 1], [0, 0, 0])).toEqual([0, 0, 1])
    expect(stackAlphas([1, 0, 0], [0, 0, 0])).toEqual([1, 0, 0])
  })
})

describe('blendMoon', () => {
  function only(state: Subagent['state']): Record<Subagent['state'], number> {
    return {
      materializing: state === 'materializing' ? 1 : 0,
      working: state === 'working' ? 1 : 0,
      idle: state === 'idle' ? 1 : 0,
      needs_input: state === 'needs_input' ? 1 : 0,
      ended: state === 'ended' ? 1 : 0,
    }
  }

  it('at rest reproduces the moon table exactly', () => {
    for (const state of MIX_MOON_STATES) {
      const v = moonVisuals(state)
      const b = blendMoon(only(state), createMoonBlend())
      expect(b.discRadius).toBeCloseTo(v.discRadius, 12)
      expect(b.rimOpacity).toBeCloseTo(v.rimOpacity, 12)
      expect(b.coreRadius).toBeCloseTo(v.coreRadius, 12)
      expect(b.glowSize).toBeCloseTo(v.glowSize, 12)
      expect(b.glowOpacity).toBeCloseTo(v.glowOpacity, 12)
      expect(b.trailOpacity).toBeCloseTo(v.trailOpacity, 12)
      expect(b.tickSpin).toBeCloseTo(v.tickSpin, 12)
      expect(b.dim).toBe(v.dimmed ? DIMMED_OPACITY : 1)
      expect(b.materializing).toBe(v.dashedShell || v.matRing ? 1 : 0)
    }
  })

  it('sizes and glows interpolate; the materializing shell only crossfades', () => {
    const half = { materializing: 0.5, working: 0.5, idle: 0, needs_input: 0, ended: 0 }
    const b = blendMoon(half, createMoonBlend())
    const mat = moonVisuals('materializing')
    const working = moonVisuals('working')
    expect(b.discRadius).toBeCloseTo((mat.discRadius + working.discRadius) / 2, 12)
    expect(b.glowSize).toBeCloseTo((mat.glowSize + working.glowSize) / 2, 12)
    // The dashed shell has no half-way form: it is simply half faded in.
    expect(b.materializing).toBeCloseTo(0.5, 12)
  })

  it('an ended moon fades its orbit trail rather than dropping it', () => {
    const b = blendMoon({ materializing: 0, working: 0.5, idle: 0, needs_input: 0, ended: 0.5 }, createMoonBlend())
    expect(b.trailOpacity).toBeCloseTo((0.22 + 0.08) / 2, 12)
  })
})

describe('hue transitions', () => {
  it('takes the short way round the hue circle when a session is retagged', () => {
    expect(shortestHueDelta(350, 10)).toBeCloseTo(20, 12)
    expect(shortestHueDelta(10, 350)).toBeCloseTo(-20, 12)
    expect(shortestHueDelta(210, 330)).toBeCloseTo(120, 12)
    expect(Math.abs(shortestHueDelta(0, 200))).toBeLessThanOrEqual(180)
  })

  it('eases the hue across instead of cutting, and settles on the new tag colour', () => {
    const tw = createTween(210, STATE_TRANSITION_MS)
    retargetHueTween(tw, 330)
    expect(advanceTween(tw, STATE_TRANSITION_MS / 2 / 1000)).toBe(true)
    expect(tw.value).toBeGreaterThan(210)
    expect(tw.value).toBeLessThan(330)
    advanceTween(tw, STATE_TRANSITION_MS / 1000)
    expect(tw.value).toBeCloseTo(330, 12)
    expect(tw.active).toBe(false)
  })

  it('crossing 0° runs through 0, not backwards through every other hue', () => {
    const tw = createTween(350, STATE_TRANSITION_MS)
    retargetHueTween(tw, 10)
    advanceTween(tw, STATE_TRANSITION_MS / 2 / 1000)
    // The unwrapped angle walks up past 360 rather than down through 180.
    expect(tw.value).toBeGreaterThan(350)
    advanceTween(tw, STATE_TRANSITION_MS / 1000)
    expect(((tw.value % 360) + 360) % 360).toBeCloseTo(10, 10)
  })

  it('reduced motion snaps the hue too', () => {
    const tw = createTween(210, STATE_TRANSITION_MS)
    retargetHueTween(tw, 330, true)
    advanceTween(tw, 0.016)
    expect(tw.value).toBeCloseTo(330, 12)
    expect(tw.active).toBe(false)
  })
})

describe('body migration', () => {
  // Retagging moves a session into another cluster; it should walk there.
  it('is slower than a state change, because it crosses the map', () => {
    expect(BODY_MOVE_MS).toBeGreaterThan(STATE_TRANSITION_MS)
  })

  it('eases both axes together and lands exactly on the new position', () => {
    const pt = createPointTween(0, 0, BODY_MOVE_MS)
    retargetPointTween(pt, 10, -4)

    expect(advancePointTween(pt, BODY_MOVE_MS / 2 / 1000)).toBe(true)
    expect(pt.x.value).toBeGreaterThan(0)
    expect(pt.x.value).toBeLessThan(10)
    expect(pt.y.value).toBeLessThan(0)
    expect(pt.y.value).toBeGreaterThan(-4)
    // Same duration and curve on both axes: the body travels in a straight
    // line, so progress along each axis stays in the same proportion.
    expect(pt.x.value / 10).toBeCloseTo(pt.y.value / -4, 12)

    advancePointTween(pt, BODY_MOVE_MS / 1000)
    expect(pt.x.value).toBe(10)
    expect(pt.y.value).toBe(-4)
    expect(advancePointTween(pt, 0.016)).toBe(false)
  })

  it('retagging again mid-walk continues from where the body is, not from where it set off', () => {
    const pt = createPointTween(0, 0, BODY_MOVE_MS)
    retargetPointTween(pt, 10, 10)
    advancePointTween(pt, BODY_MOVE_MS / 4 / 1000)
    const partway = { x: pt.x.value, y: pt.y.value }
    expect(partway.x).toBeGreaterThan(0)

    retargetPointTween(pt, -6, 2)
    expect(pt.x.from).toBe(partway.x)
    expect(pt.y.from).toBe(partway.y)
  })

  it('reduced motion puts the body straight down in its new place', () => {
    const pt = createPointTween(0, 0, BODY_MOVE_MS)
    retargetPointTween(pt, 10, -4, true)
    advancePointTween(pt, 0.016)
    expect(pt.x.value).toBe(10)
    expect(pt.y.value).toBe(-4)
    expect(pt.x.active).toBe(false)
    expect(pt.y.active).toBe(false)
  })

  it('advances the axis that is still moving even after the other has settled', () => {
    const pt = createPointTween(0, 0, BODY_MOVE_MS)
    // x is already where it needs to be, so only y has anywhere to go.
    retargetPointTween(pt, 0, 10)
    expect(pt.x.active).toBe(false)
    expect(advancePointTween(pt, BODY_MOVE_MS / 2 / 1000)).toBe(true)
    expect(pt.y.value).toBeGreaterThan(0)
  })
})

describe('selection reticle fade', () => {
  it('fades in on select and out on deselect, exiting faster than it enters', () => {
    expect(RETICLE_EXIT_MS).toBeLessThan(RETICLE_ENTER_MS)
    const tw = createTween(0, RETICLE_ENTER_MS)
    retargetTween(tw, 1, RETICLE_ENTER_MS)
    advanceTween(tw, RETICLE_ENTER_MS / 2 / 1000)
    expect(tw.value).toBeGreaterThan(0)
    expect(tw.value).toBeLessThan(1)
    advanceTween(tw, RETICLE_ENTER_MS / 1000)
    expect(tw.value).toBe(1)

    retargetTween(tw, 0, RETICLE_EXIT_MS)
    advanceTween(tw, RETICLE_EXIT_MS / 1000)
    expect(tw.value).toBe(0)
    expect(tw.active).toBe(false)
  })

  it('deselecting mid-fade-in starts from the visible opacity, not from full', () => {
    const tw = createTween(0, RETICLE_ENTER_MS)
    retargetTween(tw, 1, RETICLE_ENTER_MS)
    advanceTween(tw, RETICLE_ENTER_MS / 4 / 1000)
    const partway = tw.value
    expect(partway).toBeLessThan(1)
    retargetTween(tw, 0, RETICLE_EXIT_MS)
    expect(tw.from).toBe(partway)
  })
})

// ---------------------------------------------------------------------------
// ended suppression — canvas 2a
// ---------------------------------------------------------------------------

describe('endedHideTransform', () => {
  // Canvas 2a drives a hidden ended planet with
  // `opacity:0; transform:scale(.82); transition:opacity .5s ease, transform .5s ease`.
  it('is a no-op at full fade, so a shown planet keeps its existing appearance', () => {
    expect(endedHideTransform(1)).toEqual({ opacity: 1, scale: 1 })
  })

  it('reaches transparent and .82 scale at zero fade', () => {
    expect(endedHideTransform(0)).toEqual({ opacity: 0, scale: ENDED_HIDDEN_SCALE })
  })

  it('interpolates scale from 1 toward .82 as the fade runs out, never past it', () => {
    const mid = endedHideTransform(0.5)
    expect(mid.opacity).toBe(0.5)
    expect(mid.scale).toBeCloseTo(0.91, 10)
  })

  it('runs for the half second the artboard specifies', () => {
    expect(ENDED_HIDE_MS).toBe(500)
  })
})
