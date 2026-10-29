import { useEffect, useState } from 'react'

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
type TextScales = { app: number; transcript: number }

export const TEXT_SCALE_KEY = 'text_scale'
export const TRANSCRIPT_TEXT_SCALE_KEY = 'transcript_text_scale'
/** The transcript's value while it follows the app's step. */
export const TRANSCRIPT_FOLLOWS_APP = 'app'

/** The steps, default first. Only larger than today: nothing goes below it. */
export const TEXT_SCALE_STEPS = [
  { value: '1', name: 'Default' },
  { value: '1.125', name: 'Medium' },
  { value: '1.25', name: 'Large' },
  { value: '1.5', name: 'Extra large' },
] as const

type TextScaleValue = (typeof TEXT_SCALE_STEPS)[number]['value']

const TEXT_SCALE_MIN = 1
const TEXT_SCALE_MAX = Number(TEXT_SCALE_STEPS[TEXT_SCALE_STEPS.length - 1].value)

/** A step's percentage, as Settings shows it beside the name: `112.5 %`. */
export function textScalePercent(value: string): string {
  return `${Number(value) * 100} %`
}

function stepOf(raw: string | undefined): (typeof TEXT_SCALE_STEPS)[number] | null {
  return TEXT_SCALE_STEPS.find((step) => step.value === raw) ?? null
}

/** A step's name (`Large`), or the value itself when it is not a step. */
export function textScaleName(value: string): string {
  return stepOf(value)?.name ?? value
}

/** The app's step as stored, the default for a missing or unknown one. */
export function textScaleSetting(settings: Settings): TextScaleValue {
  return stepOf(settings[TEXT_SCALE_KEY])?.value ?? '1'
}

/** The transcript's own step, or `TRANSCRIPT_FOLLOWS_APP` while it has none. */
export function transcriptTextScaleSetting(settings: Settings): TextScaleValue | typeof TRANSCRIPT_FOLLOWS_APP {
  return stepOf(settings[TRANSCRIPT_TEXT_SCALE_KEY])?.value ?? TRANSCRIPT_FOLLOWS_APP
}

/**
 * The two multipliers the root carries. The transcript is never smaller than
 * the app (canvas `Feature - Text size` 6a): while it follows, or while its
 * own step is below the app's, it takes the app's. The saved step is kept,
 * so lowering the app's brings it back.
 */
export function textScales(settings: Settings): TextScales {
  const app = Number(textScaleSetting(settings))
  const own = transcriptTextScaleSetting(settings)
  return { app, transcript: own === TRANSCRIPT_FOLLOWS_APP ? app : Math.max(app, Number(own)) }
}

/** The transcript has a step of its own that the app's has outgrown (6a's note under the row). */
export function transcriptBelowApp(settings: Settings): boolean {
  const own = transcriptTextScaleSetting(settings)
  return own !== TRANSCRIPT_FOLLOWS_APP && textScales(settings).transcript !== Number(own)
}

/** A measured multiplier (the phone's system size) held to the Mac's range. */
export function clampTextScale(raw: number): number {
  if (!Number.isFinite(raw)) return TEXT_SCALE_MIN
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, raw))
}

/** A design size in px as CSS that follows the step: what `fs-*` does, for an inline style. */
export function scaledPx(px: number): string {
  return `calc(${px}px * var(--text-scale, 1))`
}

/** Fired on `window` when the root's scales change, for code that measures text in JS. */
const TEXT_SCALE_EVENT = 'orbital:text-scale'

export function applyTextScales(root: HTMLElement, scales: TextScales): void {
  const app = String(scales.app)
  const transcript = String(scales.transcript)
  if (root.style.getPropertyValue('--text-scale') === app && root.style.getPropertyValue('--transcript-text-scale') === transcript) return
  root.style.setProperty('--text-scale', app)
  root.style.setProperty('--transcript-text-scale', transcript)
  window.dispatchEvent(new Event(TEXT_SCALE_EVENT))
}

/** Changes whenever the scales do: a dependency for an effect that measures rendered text. */
export function useTextScaleVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    window.addEventListener(TEXT_SCALE_EVENT, bump)
    return () => window.removeEventListener(TEXT_SCALE_EVENT, bump)
  }, [])
  return version
}

/** The app's multiplier the root carries now, following every change. */
export function useAppTextScale(): number {
  useTextScaleVersion()
  const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--text-scale'))
  return Number.isFinite(raw) && raw > 0 ? raw : 1
}

/**
 * The last scales a window applied, kept in `localStorage` so the next page
 * load paints at them before settings arrive, and so pages that never load
 * settings (Stats, Limits, the walkthrough) and other windows follow a change
 * through the `storage` event.
 */
export const TEXT_SCALES_STORAGE_KEY = 'orbital.textScales'

export function rememberedTextScales(raw: string | null): TextScales {
  try {
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const { app, transcript } = parsed as Record<string, unknown>
      if (typeof app === 'number' && typeof transcript === 'number') {
        const a = clampTextScale(app)
        return { app: a, transcript: Math.max(a, clampTextScale(transcript)) }
      }
    }
  } catch {
    // A value from an older or broken write: the default.
  }
  return { app: TEXT_SCALE_MIN, transcript: TEXT_SCALE_MIN }
}
