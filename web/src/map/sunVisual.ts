import { swatch } from '../lib/palette'
import { SUN_TINTS, sunDiscGradient, sunOklch, type SunColor, type SunReading, type SunStyle } from '../lib/limitSuns'

/**
 * How one sun looks, as CSS (canvas `Feature - Limit sun` 60a, the script's
 * `sunVis`): the halo, the corona, the week arc, the disc with its rim, the
 * eclipse shadow and the stale hatching. The values are the canvas's; usage
 * moves only the coverage or brightness, the arc's length and the halo.
 */
export interface SunLook {
  haloBg: string
  haloOp: number
  coronaShadow: string
  coronaOp: number
  arcBg: string
  arcOp: number
  disc: string
  rimStyle: 'solid' | 'dashed'
  rimInk: string
  /** The eclipse shadow's `left`, in percent of the disc. */
  shadowLeft: number
  shadowOp: number
  hatchOp: number
  /** The label's ink: one neutral ink in three steps (31a). */
  ink: string
}

/** 31a's three steps of one ink, the label's colour by severity (60a: `INK`). */
const INK = {
  normal: swatch('ink-900', 0.72),
  warning: swatch('ink-400', 0.86),
  critical: swatch('ink-100'),
  reached: swatch('ink-100'),
} as const
/** 60f STALE: the label of a reading that is out of date. */
const STALE_INK = swatch('ink-900', 0.6)
/** 60a: the disc of a stale sun, and the dark a spent one goes to in Dim. */
const STALE_DISC = 'oklch(19% .008 250)'
const SPENT_DISC = 'oklch(15% .01 250)'
/** 60a Dim: the lightness the core darkens toward as the room is used. */
const DIM_FLOOR_L = 15
/** 60a: the part of the week arc already spent. */
const ARC_SPENT = 'rgba(190,225,255,.12)'

export function sunLook(style: SunStyle, reading: SunReading, color: SunColor, stale: boolean): SunLook {
  const t = SUN_TINTS[color]
  if (stale) {
    return {
      haloBg: 'transparent',
      haloOp: 0,
      coronaShadow: 'none',
      coronaOp: 0,
      arcBg: 'transparent',
      arcOp: 0,
      disc: STALE_DISC,
      rimStyle: 'dashed',
      rimInk: sunOklch(color, 0.55),
      shadowLeft: 100,
      shadowOp: 0,
      hatchOp: 1,
      ink: STALE_INK,
    }
  }
  const now = Math.min(1, Math.max(0, reading.spentNow))
  const weekSpent = 1 - Math.min(1, Math.max(0, reading.weekLeft))
  const arcDeg = Math.round((1 - weekSpent) * 360)
  const base = {
    haloBg: `radial-gradient(closest-side,${sunOklch(color, 0.26)},${sunOklch(color, 0.07)} 55%,transparent)`,
    coronaShadow: `0 0 0 1.5px ${sunOklch(color, 0.6)},0 0 12px ${sunOklch(color, 0.25)}`,
    arcBg: `conic-gradient(from 0deg,${sunOklch(color, 0.85)} 0 ${arcDeg}deg,${ARC_SPENT} ${arcDeg}deg 360deg)`,
    arcOp: 1,
    rimStyle: 'solid' as const,
    hatchOp: 0,
    ink: INK[reading.severity],
  }
  if (style === 'dim') {
    const l = Math.round(t.l - (t.l - DIM_FLOOR_L) * now)
    return {
      ...base,
      disc: now >= 1 ? SPENT_DISC : sunDiscGradient(color, l, t.c * (1 - now)),
      haloOp: +(1 - now).toFixed(2),
      coronaOp: 0,
      rimInk: sunOklch(color, now >= 1 ? 0.45 : 0.25),
      shadowLeft: 100,
      shadowOp: 0,
    }
  }
  return {
    ...base,
    disc: sunDiscGradient(color),
    haloOp: +((1 - now) * (1 - 0.4 * weekSpent)).toFixed(2),
    coronaOp: now >= 1 ? 0.7 : 0,
    rimInk: sunOklch(color, 0.25),
    shadowLeft: Math.round((1 - now) * 100),
    shadowOp: 1,
  }
}
