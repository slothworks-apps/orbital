/**
 * The image viewer's gesture math (canvas 10d, second phone; spec
 * 2026-10-05-mobile-next § 2, "One viewer"), kept pure so it can be checked
 * without a finger. A view is a scale about the stage's centre and a pan in
 * px; the image at scale 1 is fitted into the stage ("fit").
 */

/** Spec § 2 and the IMAGES & PATHS acceptance: pinch-zoom up to 8×. */
export const MAX_ZOOM = 8
/** Canvas 10d's double-tap zoom (`imgScale: scale(2.5)`); a second double-tap returns to fit. */
export const DOUBLE_TAP_ZOOM = 2.5
/**
 * How far a finger travels down, at fit, to go back; and sideways to page.
 * The canvas gives the gestures, not their distances — these are a phone's
 * usual swipe distances, for the fidelity pass to confirm on the device.
 */
export const SWIPE_BACK_PX = 120
export const SWIPE_PAGE_PX = 60
/** Two taps this close in time are a double-tap. */
export const DOUBLE_TAP_MS = 300

export interface Size {
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export interface View {
  scale: number
  x: number
  y: number
}

export const FIT: View = { scale: 1, x: 0, y: 0 }

export function clampScale(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(1, scale))
}

/** The image fitted inside the stage, never upscaled past the stage itself. */
export function fitSize(image: Size, stage: Size): Size {
  if (image.w <= 0 || image.h <= 0) return { w: stage.w, h: stage.h }
  const k = Math.min(stage.w / image.w, stage.h / image.h)
  return { w: image.w * k, h: image.h * k }
}

/**
 * The pan held to the image's edges: a zoomed image may move only as far as
 * its overhang, so an edge never comes away from the stage's side; along an
 * axis where it is smaller than the stage it stays centred.
 */
export function clampPan(view: View, fitted: Size, stage: Size): View {
  const scale = clampScale(view.scale)
  const limit = (content: number, room: number) => Math.max(0, (content * scale - room) / 2)
  const lx = limit(fitted.w, stage.w)
  const ly = limit(fitted.h, stage.h)
  // `|| 0` folds a -0 into 0, so a centred axis reads as plain 0.
  const hold = (v: number, l: number) => Math.min(l, Math.max(-l, v)) || 0
  return { scale, x: hold(view.x, lx), y: hold(view.y, ly) }
}

/**
 * The view at `scale`, keeping the image point under `at` (relative to the
 * stage's centre) where it is — what a pinch's midpoint and a double-tap do.
 */
export function zoomAt(view: View, scale: number, at: Point, fitted: Size, stage: Size): View {
  const next = clampScale(scale)
  const k = next / view.scale
  return clampPan({ scale: next, x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k }, fitted, stage)
}

/** Double-tap: zoomed in → fit; at fit → {@link DOUBLE_TAP_ZOOM} about the tap. */
export function toggleZoom(view: View, at: Point, fitted: Size, stage: Size): View {
  return view.scale > 1 ? FIT : zoomAt(view, DOUBLE_TAP_ZOOM, at, fitted, stage)
}

/**
 * What a one-finger drag that ended at fit means: down far enough → back,
 * sideways far enough → the next or previous image. Zoomed in, a drag only
 * pans, so it means none of these.
 */
export function releaseGesture(scale: number, dx: number, dy: number): 'back' | 'next' | 'prev' | null {
  if (scale > 1) return null
  if (dy > SWIPE_BACK_PX && dy > Math.abs(dx)) return 'back'
  if (Math.abs(dx) > SWIPE_PAGE_PX && Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'next' : 'prev'
  return null
}

/** The header's zoom label: canvas 10d's `fit`, or the scale to one decimal (`2.5×`). */
export function zoomLabel(scale: number): string {
  if (scale <= 1) return 'fit'
  return `${(Math.round(scale * 10) / 10).toString()}×`
}
