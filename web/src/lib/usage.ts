/**
 * Token accounting shared by everything that reads a session's context
 * usage: the map's context arc (spec `context-fill-arc`) and the detail
 * panel's context bar.
 *
 * Both read ONE number, `ApiSession.contextUsedTokens`, which the server
 * writes on the row at the end of every turn and at every `compact_boundary`
 * (`server/src/runner/runner.ts`) and republishes on the `sessions` topic.
 * It is what the CLI answers when asked how full the window is, or — when it
 * cannot answer — the turn's last main-loop API call. Never a turn's summed
 * usage, which is a billing total (fix: context-arc-summed-the-whole-turn).
 * The panel used to derive its own total from the live-only `turn_result`
 * event instead, which is why it sat at em dashes after every reload while
 * the arc beside it was drawn — see
 * `docs/decisions/context-usage-has-one-source.md`.
 */

import { contextWindowFor } from './models'
import type { ApiSession, OrbitalModel } from './types'

/**
 * How full a session's context is, 0–1, or null when there is no honest
 * answer: nothing has measured it yet (`contextUsedTokens` null — a fresh
 * session, or one whose last compaction did not report its size), or its
 * context window is unknown, per `docs/decisions/models-come-from-the-sdk.md`
 * — a gauge against an invented denominator is worse than no gauge.
 *
 * Clamped to [0, 1]: a window learned smaller than the session's actual use
 * would otherwise sweep the arc past a full turn, and "more than full" is
 * still just full. The read-out quotes the UNCLAMPED numerator, because what
 * was measured is not the bar's business to round off.
 *
 * Deliberately free of every question about whether a gauge should be SHOWN
 * — the map's toggle, terminal sessions, ended sessions. Those differ per
 * surface (`contextFillFor` for the arc, `canShowContext` in `DetailPanel`);
 * the fraction does not.
 */
export function contextFractionFor(
  session: ApiSession,
  models: OrbitalModel[],
  contextWindows: Record<string, number> = {}
): number | null {
  const used = session.contextUsedTokens
  if (used == null || !Number.isFinite(used)) return null
  const window = contextWindowFor(session, models, contextWindows)
  if (window === null || window <= 0) return null
  return Math.min(1, Math.max(0, used / window))
}

/** The two percentages the arc and the context bar step their colour at. */
export interface ContextThresholds {
  warn: number
  critical: number
}

/** Where a fill sits against the thresholds — the arc's and the bar's colour. */
export type ContextLevel = 'ok' | 'warn' | 'critical'

/**
 * An oklch colour as its three components, so a CSS string and a
 * `THREE.Color` can be produced from ONE transcription of the canvas value
 * (`setOklchTagColor` in `Planet.tsx` takes exactly these).
 */
export interface Oklch {
  lightness: number
  chroma: number
  hue: number
}

/**
 * Below the first threshold — the DONE state's green (`--state-done`,
 * canvas 24d). Fixed rather than the session's tag hue: the gauge reads as
 * one traffic light on every planet, so green/amber/red mean the same thing
 * whatever the tag.
 */
export const CONTEXT_OK_OKLCH: Oklch = { lightness: 0.84, chroma: 0.12, hue: 160 }
/** Past the first threshold — canvas 1i's `oklch(80% .13 60)` amber. */
export const CONTEXT_WARN_OKLCH: Oklch = { lightness: 0.8, chroma: 0.13, hue: 60 }
/** Past the second — canvas 1i's `oklch(72% .17 25)` red. */
export const CONTEXT_CRITICAL_OKLCH: Oklch = { lightness: 0.72, chroma: 0.17, hue: 25 }

/** The same colour as a CSS `oklch()` string, for the DOM half (the detail panel's bar). */
export function oklchCss({ lightness, chroma, hue }: Oklch, alpha?: number): string {
  const base = `oklch(${lightness * 100}% ${chroma} ${hue}`
  return alpha === undefined ? `${base})` : `${base} / ${alpha})`
}

/** The gauge's colour for a level — the arc's and the bar's alike. */
export function contextLevelOklch(level: ContextLevel): Oklch {
  if (level === 'critical') return CONTEXT_CRITICAL_OKLCH
  if (level === 'warn') return CONTEXT_WARN_OKLCH
  return CONTEXT_OK_OKLCH
}

/**
 * Which colour band a fill (0–1) falls in.
 *
 * The boundaries are exclusive on the way up, which is what canvas 1i says
 * in words ("≤ 50 % — tag hue", "> 50 % — amber", "> 80 % — red"): a session
 * sitting exactly ON a threshold has not crossed it yet. Compared in
 * percent, the unit the thresholds are configured and displayed in, so "50"
 * means the same thing here as it does in the settings field.
 */
export function contextLevel(fraction: number, thresholds: ContextThresholds): ContextLevel {
  const percent = fraction * 100
  if (percent > thresholds.critical) return 'critical'
  if (percent > thresholds.warn) return 'warn'
  return 'ok'
}
