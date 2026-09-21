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

/**
 * Camera zoom is clamped to this range (also the map's percent readout range).
 *
 * The range was [20, 200], and the floor was the binding one: a map of a few
 * clusters plus the hole, framed into the strip between an open sidebar and
 * an open detail panel, wants a zoom in the low teens — the clamp caught it
 * and silently let the fit overflow both panels again, which is the bug fit
 * insets exist to fix.
 *
 * It is wide rather than merely wide enough on purpose. The limits do not
 * have to keep anyone oriented: fit (the zoom stack's ⌖, ⌥F) reframes the
 * whole map from wherever the camera has been left, so overshooting in
 * either direction costs one keystroke. What a tight range costs instead is
 * a view the map genuinely needs and cannot reach.
 */
export const MIN_ZOOM = 5
export const MAX_ZOOM = 400

/**
 * Extra world-space padding kept around a fitted bounding box's edges.
 * Also what absorbs `bodyZoomFactor` at fit zoom: fit frames positions only,
 * so a body's drawn radius has to come out of this padding. A big planet is
 * ~0.67 world units before inflation, which stays inside these 2 units at
 * every zoom down to ~7 — and past that bottom sliver it pokes out by under
 * 2 screen pixels, because the padding shrinks with the zoom it is measured
 * in. Not worth widening the padding for, which would cost every fit at
 * every other zoom.
 */
const FIT_PADDING = 2

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** The map's default zoom — the zoom at which bodies are drawn exactly as the canvas specifies them. */
const REFERENCE_ZOOM = 60
/** Exponent of the counter-zoom curve; 0 would track zoom linearly, 1 would be a fixed-pixel map pin. */
const FACTOR_K = 0.5
/**
 * Cap on the counter-zoom curve, set to its own raw value at the bottom of
 * the zoom range (`sqrt(60 / MIN_ZOOM)`) — so the curve runs uninterrupted
 * across the whole range and the cap only ever catches the arithmetic, never
 * the design. It moved with `MIN_ZOOM`: left at the old floor's 1.7, bodies
 * would have started shrinking linearly again over the newly-opened bottom of
 * the range, which is exactly where they can least afford it.
 */
const FACTOR_MAX = (REFERENCE_ZOOM / MIN_ZOOM) ** FACTOR_K

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

/**
 * The world point under a screen position (CSS px relative to the map
 * container's top-left). The same projection `zoomAt` holds still: ortho
 * camera, frustum centred on the canvas, screen Y inverted. Used by the
 * body-drag interaction to pin a dragged planet to the pointer.
 */
export function screenToWorld(
  cam: CameraState,
  point: Position,
  viewport: Viewport
): Position {
  return {
    x: cam.x + (point.x - viewport.width / 2) / cam.zoom,
    y: cam.y - (point.y - viewport.height / 2) / cam.zoom,
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
 * Smallest strip the panels are allowed to squeeze the fit into, as a share
 * of the viewport width. Both panels open on a narrow window can otherwise
 * leave zero (or negative) room, and dividing by that yields a camera nobody
 * can use. Fitting into a too-small strip at least keeps the map on screen.
 */
const MIN_FIT_STRIP_SHARE = 0.2

/**
 * Computes a camera state that frames every given position with some
 * padding, for the "fit" zoom control. Falls back to the default camera
 * (origin, zoom 60) when there's nothing to fit.
 *
 * `insets` are the panels covering the map's edges. Fit frames the box into
 * the strip BETWEEN them — sized to the strip, then centred in it the way
 * `centerOn` does — so "show me everything" does not park half the sessions
 * under the sidebar or the detail panel. Omit them to fit the full viewport.
 */
export function fitView(
  positions: Position[],
  viewport: Viewport,
  insets: Insets = { left: 0, right: 0 }
): CameraState {
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
  const strip = Math.max(
    viewport.width - insets.left - insets.right,
    viewport.width * MIN_FIT_STRIP_SHARE
  )
  const safeWidth = Math.max(width, 1e-6)
  const safeHeight = Math.max(height, 1e-6)
  const zoomX = strip / safeWidth
  const zoomY = viewport.height / safeHeight
  const zoom = clampZoom(Math.min(zoomX, zoomY))

  // Same offset `centerOn` uses: the camera's x is the world point at the
  // VIEWPORT centre, so putting the box's centre at the STRIP's centre means
  // shifting by half the inset difference, converted back into world units.
  return { x: centerX - (insets.left - insets.right) / 2 / zoom, y: centerY, zoom }
}
