/**
 * Pure pan/zoom math for the space map's orthographic camera. No
 * React/three/WebGL imports — kept separate from `SpaceMap.tsx` so it's
 * unit-testable in jsdom (which has no WebGL); `SpaceMap` calls these
 * helpers and copies the result onto the actual `THREE.OrthographicCamera`
 * imperatively.
 */

export interface CameraState {
  x: number
  y: number
  zoom: number
}

export interface Position {
  x: number
  y: number
}

export interface Viewport {
  width: number
  height: number
}

/** Camera zoom is clamped to this range (also the map's percent readout range). */
export const MIN_ZOOM = 20
export const MAX_ZOOM = 200

/**
 * Extra world-space padding kept around a fitted bounding box's edges.
 * Also what absorbs `bodyZoomFactor` at fit zoom: fit frames positions only,
 * and the largest inflated body radius (~1.14 world units for a big planet
 * at the factor cap) still lands inside these 2 units.
 */
const FIT_PADDING = 2

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** The map's default zoom — the zoom at which bodies are drawn exactly as the canvas specifies them. */
const REFERENCE_ZOOM = 60
/** Exponent of the counter-zoom curve; 0 would track zoom linearly, 1 would be a fixed-pixel map pin. */
const FACTOR_K = 0.5
/** Cap so the very bottom of the zoom range doesn't run the curve away (raw value there is ~1.73). */
const FACTOR_MAX = 1.7

/**
 * How much a planet (and its whole moon system) inflates to stay readable as
 * the camera zooms OUT: drawn world radius rises as `zoom^-K`, so on-screen
 * size falls as `zoom^(1-K)` instead of linearly. One-sided — clamped to 1
 * from below — so at and above the default zoom nothing changes and the
 * close-up stays exactly as the canvas draws it
 * (docs/ideas/planets-shrink-slower-than-the-map.md).
 *
 * Pure and exported for unit tests; the frame loops in `Planet`/`Moon` read
 * `state.camera.zoom` and multiply this into their group scale, because
 * camera state deliberately never reaches React (`useSceneModel`).
 */
export function bodyZoomFactor(zoom: number): number {
  return Math.min(FACTOR_MAX, Math.max(1, (REFERENCE_ZOOM / zoom) ** FACTOR_K))
}

/**
 * Pans the camera by a pointer-drag delta expressed in screen pixels.
 * Divides by `zoom` so a drag feels 1:1 with the cursor regardless of zoom
 * level, and inverts Y (screen Y grows downward, world Y grows upward) and
 * negates X (dragging right should reveal content to the left, i.e. move
 * the camera left) — standard "grab and drag the canvas" panning.
 */
export function applyPan(cam: CameraState, dx: number, dy: number): CameraState {
  return {
    ...cam,
    x: cam.x - dx / cam.zoom,
    y: cam.y + dy / cam.zoom,
  }
}

/** Adjusts zoom by a delta (positive = zoom in), clamped to [MIN_ZOOM, MAX_ZOOM]. Used by the +/- buttons (fixed step). */
export function applyZoom(cam: CameraState, deltaZoom: number): CameraState {
  return { ...cam, zoom: clampZoom(cam.zoom + deltaZoom) }
}

/**
 * `log(1.1) / 100`, chosen so that one standard Chrome mouse-wheel notch
 * (`deltaY` of about ±100, `deltaMode` 0/pixel) changes zoom by about 10%.
 */
const WHEEL_ZOOM_K = Math.log(1.1) / 100

/**
 * `DOM_DELTA_LINE` (`deltaMode === 1`) wheel events report `deltaY` in
 * "lines" rather than pixels; 16px approximates one line (a common browser
 * default line-height) so line-mode wheels (some Firefox configs) feel
 * roughly consistent with pixel-mode ones instead of being ~16x too slow.
 */
const DELTA_LINE_TO_PIXELS = 16

/**
 * Computes the next zoom for a wheel/trackpad event, multiplicatively
 * (`zoom * exp(-deltaY * k)`) rather than additively (`applyZoom`'s fixed
 * step). Multiplicative zoom means the same physical wheel gesture always
 * reads as the same *relative* change — a notch at zoom 20 and a notch at
 * zoom 200 both change zoom by ~10% — instead of the same fixed absolute
 * amount swamping the low end and doing nothing at the high end.
 *
 * Returns the zoom only, clamped to [MIN_ZOOM, MAX_ZOOM]. Where that zoom
 * leaves the camera is `zoomAt`'s job — the wheel handler pipes one into the
 * other so the point under the cursor is what the gesture pulls towards.
 */
export function zoomFromWheel(zoom: number, deltaY: number, deltaMode = 0): number {
  const normalizedDeltaY = deltaMode === 1 ? deltaY * DELTA_LINE_TO_PIXELS : deltaY
  return clampZoom(zoom * Math.exp(-normalizedDeltaY * WHEEL_ZOOM_K))
}

/**
 * Zooms to `nextZoom` while pinning the world point under `pointer`, so the
 * map grows towards the cursor (and shrinks away from it) instead of towards
 * the middle of the screen. `pointer` is in CSS pixels relative to the map
 * container's top-left corner.
 *
 * The camera is orthographic with the frustum centred on the canvas, so a
 * screen point maps to `world = cam + (pointer - viewportCentre) / zoom`
 * (Y negated: screen Y grows downward, world Y upward). Holding that world
 * point still across a zoom change leaves the camera shifted by the
 * difference of the two reciprocals — which is why this is `1/zoom - 1/next`
 * and not a ratio. Zooming out through the anchor therefore retraces exactly
 * the path zooming in took.
 *
 * `nextZoom` is clamped first, so a gesture that runs into MIN/MAX_ZOOM stops
 * moving the camera too, rather than sliding it while the zoom stands still.
 */
export function zoomAt(
  cam: CameraState,
  nextZoom: number,
  pointer: Position,
  viewport: Viewport
): CameraState {
  const zoom = clampZoom(nextZoom)
  if (zoom === cam.zoom) return cam
  const shift = 1 / cam.zoom - 1 / zoom
  return {
    zoom,
    x: cam.x + (pointer.x - viewport.width / 2) * shift,
    y: cam.y - (pointer.y - viewport.height / 2) * shift,
  }
}

/** Screen-space chrome covering the map's edges, in CSS pixels. */
export interface Insets {
  /** Sidebar side. */
  left: number
  /** Detail-panel side. */
  right: number
}

/**
 * Camera that puts `target` in the middle of the map a user can actually
 * SEE — the strip between the sidebar and the detail panel — rather than in
 * the middle of the viewport, half of which the 450px detail panel is sitting
 * on when anything is selected.
 *
 * Zoom is deliberately untouched: following a retagged session should move
 * the view, not reframe it. Whatever the user had zoomed to stays.
 *
 * The camera's `x` is the world point at the viewport centre, and screen
 * pixels relate to world units by `zoom`, so putting `target` at screen x
 * `W/2 + (left - right)/2` means offsetting the camera by exactly that half
 * difference converted back into world units. The viewport width cancels out,
 * which is why it is not a parameter.
 */
export function centerOn(cam: CameraState, target: Position, insets: Insets): CameraState {
  return {
    ...cam,
    x: target.x - (insets.left - insets.right) / 2 / cam.zoom,
    y: target.y,
  }
}

/**
 * Computes a camera state that frames every given position with some
 * padding, for the "fit" zoom control. Falls back to the default camera
 * (origin, zoom 60) when there's nothing to fit.
 */
export function fitView(positions: Position[], viewport: Viewport): CameraState {
  if (positions.length === 0) {
    return { x: 0, y: 0, zoom: 60 }
  }

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of positions) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const width = maxX - minX + FIT_PADDING * 2
  const height = maxY - minY + FIT_PADDING * 2

  // Orthographic projection: on-screen pixels = world units * zoom, so the
  // zoom that makes a world span exactly fill a viewport span is
  // viewportPx / worldUnits. Pick whichever axis is tighter so both fit.
  const safeWidth = Math.max(width, 1e-6)
  const safeHeight = Math.max(height, 1e-6)
  const zoomX = viewport.width / safeWidth
  const zoomY = viewport.height / safeHeight

  return { x: centerX, y: centerY, zoom: clampZoom(Math.min(zoomX, zoomY)) }
}
