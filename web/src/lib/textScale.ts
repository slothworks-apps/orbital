/**
 * Text size (spec 2026-10-27-text-size-design). The app's text and the
 * transcript's each take one step, a multiplier the root carries as CSS
 * variables: `--text-scale` for the app and `--transcript-text-scale`,
 * which `[data-text-scope='transcript']` swaps in (`theme.css`). The `fs-*`
 * utility multiplies every size by them; spacing never sees them.
 *
 * On the Mac the steps come from Settings → Appearance; on the phone the
 * system's text size stands in for both (`mobile/platform/textScale.ts`).
 */

type Settings = Record<string, string>

export const TEXT_SCALE_KEY = 'text_scale'
export const TRANSCRIPT_TEXT_SCALE_KEY = 'transcript_text_scale'
/** The transcript's value while it follows the app's step. */
export const TRANSCRIPT_FOLLOWS_APP = 'app'

/** The steps, default first. Only larger than today: nothing goes below it. */
export const TEXT_SCALE_STEPS = [
  { value: '1', name: 'Default' },
  { value: '1.125', name: 'Large' },
  { value: '1.25', name: 'Larger' },
  { value: '1.5', name: 'Largest' },
] as const

export type TextScaleValue = (typeof TEXT_SCALE_STEPS)[number]['value']

export const TEXT_SCALE_MIN = 1
export const TEXT_SCALE_MAX = Number(TEXT_SCALE_STEPS[TEXT_SCALE_STEPS.length - 1].value)

/** A step's percentage, as its tooltip reads it: `112.5 %`. */
export function textScalePercent(value: string): string {
  return `${Number(value) * 100} %`
}

function stepOf(raw: string | undefined): TextScaleValue | null {
  return TEXT_SCALE_STEPS.find((step) => step.value === raw)?.value ?? null
}

/** The app's step as stored, the default for a missing or unknown one. */
export function textScaleSetting(settings: Settings): TextScaleValue {
  return stepOf(settings[TEXT_SCALE_KEY]) ?? '1'
}

/** The transcript's own step, or `TRANSCRIPT_FOLLOWS_APP` while it has none. */
export function transcriptTextScaleSetting(settings: Settings): TextScaleValue | typeof TRANSCRIPT_FOLLOWS_APP {
  return stepOf(settings[TRANSCRIPT_TEXT_SCALE_KEY]) ?? TRANSCRIPT_FOLLOWS_APP
}

/** The two multipliers the root carries, the transcript's resolved to the app's when it follows. */
export function textScales(settings: Settings): { app: number; transcript: number } {
  const app = Number(textScaleSetting(settings))
  const own = transcriptTextScaleSetting(settings)
  return { app, transcript: own === TRANSCRIPT_FOLLOWS_APP ? app : Number(own) }
}

/** A measured multiplier (the phone's system size) held to the Mac's range. */
export function clampTextScale(raw: number): number {
  if (!Number.isFinite(raw)) return TEXT_SCALE_MIN
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, raw))
}

export function applyTextScales(root: HTMLElement, scales: { app: number; transcript: number }): void {
  root.style.setProperty('--text-scale', String(scales.app))
  root.style.setProperty('--transcript-text-scale', String(scales.transcript))
}
