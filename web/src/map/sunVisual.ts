import { swatch } from '../lib/palette'
import { DARK_KIND, type SceneKind } from '../lib/sceneColours'
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
const STALE_DISC = swatch('disc-off')
const SPENT_DISC = swatch('eclipse')
/** 60a Dim: the lightness the core darkens toward as the room is used. */
const DIM_FLOOR_L = 15
/** 60a: the part of the week arc already spent, `rgba(190,225,255,.12)`. */
const ARC_SPENT = swatch('line', 0.12)

/** What a sun takes from the theme's kind (1l): its rim and arc, and whether its glows paint. */
export type SunKind = Pick<SceneKind, 'sunL' | 'sunC' | 'sunRa' | 'glowK'>

/**
 * The rim and week arc in the theme's kind (1l: `oklch(var(--sun-l)
 * var(--sun-c) <hue>)`). The canvas draws the yellow sun, whose own tint is
 * the dark kind's 91% .09; every tint is scaled by the same ratio, so a dark
 * theme keeps each sun's own rim and a light one darkens them all alike.
 */
function rimOklch(color: SunColor, alpha: number, kind: SunKind): string {
  const t = SUN_TINTS[color]
  return sunOklch(color, alpha, +((t.l * kind.sunL) / DARK_KIND.sunL).toFixed(1), (t.c * kind.sunC) / DARK_KIND.sunC)
}

/** A rim alpha the canvas wrote for the dark kind, in this kind's (`--sun-ra` over the dark .25). */
function rimAlpha(alpha: number, kind: SunKind): number {
  return Math.min(1, +((alpha * kind.sunRa) / DARK_KIND.sunRa).toFixed(3))
}

export function sunLook(
  style: SunStyle,
  reading: SunReading,
  color: SunColor,
  stale: boolean,
  kind: SunKind = DARK_KIND,
): SunLook {
  const t = SUN_TINTS[color]
  // Halos and the corona's glow paint on a dark theme only (`--glow-k`).
  const glowK = kind.glowK
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
      rimInk: rimOklch(color, 0.55, kind),
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
    coronaShadow: `0 0 0 1.5px ${rimOklch(color, 0.6, kind)},0 0 12px ${sunOklch(color, +(0.25 * glowK).toFixed(3))}`,
    arcBg: `conic-gradient(from 0deg,${rimOklch(color, 0.85, kind)} 0 ${arcDeg}deg,${ARC_SPENT} ${arcDeg}deg 360deg)`,
    // A spend-only account has no week, so no ring (limitSuns `hasWeek`).
    arcOp: reading.hasWeek === false ? 0 : 1,
    rimStyle: 'solid' as const,
    hatchOp: 0,
    ink: INK[reading.severity],
  }
  if (style === 'dim') {
    const l = Math.round(t.l - (t.l - DIM_FLOOR_L) * now)
    return {
      ...base,
      disc: now >= 1 ? SPENT_DISC : sunDiscGradient(color, l, t.c * (1 - now)),
      haloOp: +((1 - now) * glowK).toFixed(2),
      coronaOp: 0,
      rimInk: rimOklch(color, rimAlpha(now >= 1 ? 0.45 : 0.25, kind), kind),
      shadowLeft: 100,
      shadowOp: 0,
    }
  }
  return {
    ...base,
    disc: sunDiscGradient(color),
    haloOp: +((1 - now) * (1 - 0.4 * weekSpent) * glowK).toFixed(2),
    coronaOp: now >= 1 ? 0.7 : 0,
    rimInk: rimOklch(color, rimAlpha(0.25, kind), kind),
    shadowLeft: Math.round((1 - now) * 100),
    shadowOp: 1,
  }
}
