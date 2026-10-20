import { LIMIT_SUN_COLORS_KEY, LIMIT_SUN_POSITIONS_KEY, LIMIT_SUN_STYLE_KEY } from './experimental'
import { formatResetShort, isFiveHourKind, isWeeklyAllKind, limitSeverity } from './limits'
import type { LimitSeverity, LimitWindow } from './types'

/**
 * The limit suns (spec 2026-10-20-limit-suns-design § 4; canvas `Feature -
 * Limit sun` 60a–60f): what a sun shows of its account's windows, which star
 * colour each account wears, its style, and where it sits. Pure: the map,
 * the limits page and Settings → Labs read the same answers.
 */

type Settings = Record<string, string | undefined>

/** The star colours, in the order accounts take them (60f, COLOUR). Colour says whose sun it is, never its state. */
export const SUN_COLORS = ['yellow', 'white', 'blue', 'red'] as const
export type SunColor = (typeof SUN_COLORS)[number]

/**
 * The star tints (60f, COLOUR): low chroma like real stars, under the tag
 * hues' so a sun never reads as a tag. Lightness, chroma and hue of oklch.
 */
export const SUN_TINTS: Record<SunColor, { l: number; c: number; h: number }> = {
  yellow: { l: 91, c: 0.09, h: 95 },
  white: { l: 95, c: 0.012, h: 250 },
  blue: { l: 84, c: 0.08, h: 250 },
  red: { l: 77, c: 0.11, h: 40 },
}

/** A star colour as CSS `oklch()`, at the tint's own lightness and chroma unless given, with an optional alpha. */
export function sunOklch(color: SunColor, alpha?: number, l?: number, c?: number): string {
  const t = SUN_TINTS[color]
  const chroma = +(c ?? t.c).toFixed(3)
  return `oklch(${l ?? t.l}% ${chroma} ${t.h}${alpha === undefined ? '' : ` / ${alpha}`})`
}

/** The lit disc, and the colour dot beside an account (60c, 60e): the canvas's radial gradient. */
export function sunDiscGradient(color: SunColor, l?: number, c?: number): string {
  const t = SUN_TINTS[color]
  const lit = l ?? t.l
  const chroma = c ?? t.c
  return `radial-gradient(circle at 42% 38%,${sunOklch(color, undefined, lit, chroma)},${sunOklch(color, undefined, lit - 12, chroma * 1.1)} 80%)`
}

export type SunStyle = 'eclipse' | 'dim'

/** Eclipse unless Dim was picked (60e). */
export function sunStyle(settings: Settings): SunStyle {
  return settings[LIMIT_SUN_STYLE_KEY] === 'dim' ? 'dim' : 'eclipse'
}

function parseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function isSunColor(value: unknown): value is SunColor {
  return typeof value === 'string' && (SUN_COLORS as readonly string[]).includes(value)
}

/**
 * Each account's colour, for the accounts in their order. A stored colour
 * holds while no earlier account holds it too; any other account takes the
 * first colour still free. Past four accounts the colours repeat, and the
 * directory tiles tell the suns apart (60f).
 */
export function sunColors(keys: readonly string[], settings: Settings): Map<string, SunColor> {
  const stored = parseObject(settings[LIMIT_SUN_COLORS_KEY])
  const out = new Map<string, SunColor>()
  const taken = new Set<SunColor>()
  for (const key of keys) {
    const want = stored[key]
    if (isSunColor(want) && !taken.has(want)) {
      out.set(key, want)
      taken.add(want)
    }
  }
  let next = 0
  for (const key of keys) {
    if (out.has(key)) continue
    const free = SUN_COLORS.find((c) => !taken.has(c))
    const color = free ?? SUN_COLORS[next++ % SUN_COLORS.length]
    out.set(key, color)
    taken.add(color)
  }
  return out
}

/**
 * The stored value after `key` picks `color` (60e): picking a colour another
 * account wears swaps the two. Every listed account's colour is written, so
 * the swap holds whatever order the accounts come in later.
 */
export function pickSunColor(keys: readonly string[], settings: Settings, key: string, color: SunColor): string {
  const current = sunColors(keys, settings)
  const before = current.get(key)
  const next: Record<string, SunColor> = Object.fromEntries(current)
  for (const [other, c] of current) if (other !== key && c === color && before) next[other] = before
  next[key] = color
  return JSON.stringify(next)
}

export interface SunPosition {
  x: number
  y: number
}

/** The stored positions, by account key, in map coordinates; anything unreadable is left out. */
export function sunPositions(settings: Settings): Map<string, SunPosition> {
  const out = new Map<string, SunPosition>()
  for (const [key, value] of Object.entries(parseObject(settings[LIMIT_SUN_POSITIONS_KEY]))) {
    const p = value as { x?: unknown; y?: unknown } | null
    if (p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      out.set(key, { x: p.x, y: p.y })
    }
  }
  return out
}

/** The stored value with one sun moved. */
export function withSunPosition(settings: Settings, key: string, position: SunPosition): string {
  return JSON.stringify({ ...Object.fromEntries(sunPositions(settings)), [key]: position })
}

/**
 * What one sun shows (60f, MIDDLE + RING). The middle is the room left right
 * now, the more spent of the 5-hour and the weekly all-models window: with
 * the week spent the 5-hour window cannot be used either. The ring is what
 * is left of the week. Model windows and extra usage are not on the sun.
 */
export interface SunReading {
  /** Spent of the room right now, 0…1. */
  spentNow: number
  /** Left of the week, 0…1. */
  weekLeft: number
  /** `5h 62 % · wk 40 %`, or `limit · resets 15:00` once a window is spent. */
  label: string
  /** The label's ink step (31a's three steps of one ink), `reached` at 100 %. */
  severity: LimitSeverity | 'reached'
}

const SEVERITY_RANK: Record<LimitSeverity, number> = { normal: 0, warning: 1, critical: 2 }

export function sunReading(windows: readonly LimitWindow[], now: number = Date.now()): SunReading {
  const five = windows.find((w) => isFiveHourKind(w.kind))
  const week = windows.find((w) => isWeeklyAllKind(w.kind))
  const pct = (w: LimitWindow | undefined) => Math.max(0, Math.min(w?.percent ?? 0, 100))
  const spent = [five, week].filter((w): w is LimitWindow => w !== undefined && w.percent >= 100)
  // Both spent: the later reset is when work can start again.
  const blocking = spent.sort((a, b) => Date.parse(b.resetsAt ?? '') - Date.parse(a.resetsAt ?? ''))[0]
  let severity: LimitSeverity | 'reached' = 'normal'
  if (blocking) severity = 'reached'
  else {
    for (const w of [five, week]) {
      const s = w ? limitSeverity(w.severity) : 'normal'
      if (SEVERITY_RANK[s] > SEVERITY_RANK[severity]) severity = s
    }
  }
  return {
    spentNow: Math.max(pct(five), pct(week)) / 100,
    weekLeft: 1 - pct(week) / 100,
    label: blocking
      ? `limit · resets ${formatResetShort(blocking.resetsAt, now)}`
      : `5h ${Math.round(five?.percent ?? 0)} % · wk ${Math.round(week?.percent ?? 0)} %`,
    severity,
  }
}

/** The directory tiles a sun and its account head wear (60f, ONE PER ACCOUNT): at most two, then `+n`. */
export function sunTiles(monograms: readonly string[]): { tiles: string[]; more: number } {
  return { tiles: monograms.slice(0, 2), more: Math.max(0, monograms.length - 2) }
}
