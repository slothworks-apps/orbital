import { formatContextWindow } from '../../lib/format'
import { contextWindowFor } from '../../lib/models'
import type { ApiSession, OrbitalModel } from '../../lib/types'
import { contextFractionFor } from '../../lib/usage'

/**
 * The phone's context readout and sheet (spec 2026-10-05-mobile-next § 5;
 * canvas 10k, 10l). Pure; `session/ContextReadout.tsx` and
 * `ContextSheet.tsx` draw it.
 *
 * The fill gets brighter, never warmer: three steps of one neutral ink, the
 * Plan limits fill scale, at the canvas's two thresholds. The desktop's own
 * context thresholds and colours are a Mac setting and do not apply here.
 */

/** Canvas 10l "brighter from 80%". */
export const CONTEXT_BRIGHTER_AT = 0.8
/** Canvas 10l "full ink from 95%". */
export const CONTEXT_FULL_INK_AT = 0.95

export type PhoneContextLevel = 'normal' | 'brighter' | 'full'

/** Canvas 10k/10l `ctxRing`: the three inks of the fill, and its track. */
export const CONTEXT_INK: Record<PhoneContextLevel, string> = {
  normal: 'rgba(150,205,255,.42)',
  brighter: 'rgba(214,230,248,.72)',
  full: '#e8eef8',
}
export const CONTEXT_TRACK = 'rgba(150,205,255,.1)'

export function phoneContextLevel(fraction: number): PhoneContextLevel {
  if (fraction >= CONTEXT_FULL_INK_AT) return 'full'
  if (fraction >= CONTEXT_BRIGHTER_AT) return 'brighter'
  return 'normal'
}

export interface ContextReading {
  /** Tokens in the context as last measured; null before the first turn is measured. */
  used: number | null
  /** The model's window; null when the phone does not genuinely know it. */
  window: number | null
  /** The fill, clamped to 0..1 — a context above its window draws full. Null without both numbers. */
  fill: number | null
  /** Whole percent of the window as measured, unclamped (the sheet's "· 64%"). */
  percent: number | null
  level: PhoneContextLevel
}

/**
 * What the readout reads, or null where it is not drawn at all: a terminal
 * session's context is never measured (spec § 8 Decision 1).
 */
export function contextReading(
  session: ApiSession,
  models: OrbitalModel[],
  learned: Record<string, number> = {},
): ContextReading | null {
  if (session.source === 'terminal') return null
  const raw = session.contextUsedTokens
  const used = raw != null && Number.isFinite(raw) ? raw : null
  const found = contextWindowFor(session, models, learned)
  const window = found !== null && found > 0 ? found : null
  const fill = contextFractionFor(session, models, learned)
  // Floored, so the number never reads a threshold the ink has not reached.
  const percent = used !== null && window !== null ? Math.floor((used / window) * 100) : null
  return { used, window, fill, percent, level: phoneContextLevel(fill ?? 0) }
}

/** The header's two lines: "640k" over "/ 1M"; "—" unmeasured; no second line without a window. */
export function readoutLines(reading: ContextReading): { used: string; window: string | null } {
  return {
    // Rounded to the k, as 10k prints it; `formatContextWindow` is that form.
    used: reading.used === null ? '—' : formatContextWindow(reading.used),
    window: reading.window === null ? null : `/ ${formatContextWindow(reading.window)}`,
  }
}

const exact = (n: number) => n.toLocaleString('en-US')

/** The sheet's headline (10l): "640,212" and "of 1,000,000 tokens · 64%". */
export function sheetHeadline(reading: ContextReading): { used: string; rest: string } {
  const used = reading.used === null ? '—' : exact(reading.used)
  if (reading.window === null) return { used, rest: 'tokens' }
  const of = `of ${exact(reading.window)} tokens`
  return { used, rest: reading.percent === null ? of : `${of} · ${reading.percent}%` }
}

/**
 * The ring's fill: the level's ink up to the fill, the track after it. No
 * ring without a window; an empty one while unmeasured.
 */
export function ringGradient(reading: ContextReading): string | null {
  if (reading.window === null) return null
  const pct = Math.round((reading.fill ?? 0) * 1000) / 10
  return `conic-gradient(${CONTEXT_INK[reading.level]} 0 ${pct}%,${CONTEXT_TRACK} ${pct}%)`
}
