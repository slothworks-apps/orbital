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
 * Screen-space room fit keeps clear between the framed bodies and the edges
 * of the map, per side, in CSS pixels.
 *
 * It replaced a flat world-space padding, which could not do this job: the
 * map's own overlays are fixed-size chrome measured in pixels, while the
 * padding was measured in world units that shrink with the zoom they are
 * expressed in — so the tighter the fit, the less it held back. Fit is the
 * one camera move that deliberately pushes content out to the edges, so it
 * is the one that has to know where the chrome stands.
 *
 * Asymmetric on purpose, because the chrome is: the zoom stack (with the
 * error trigger above it) sits at the strip's right edge, and the camera
 * readout runs along the bottom. Left and top carry breathing room only.
 * The right value is the zoom column's width plus its edge offset — fit used
 * to leave the hole ending underneath those buttons.
 */
export const FIT_MARGIN_PX = { top: 32, right: 104, bottom: 48, left: 32 }

/**
 * Floor on what the margins may leave of an axis, as a share of it — the
 * same guard `MIN_FIT_STRIP_SHARE` below is for the panels, and for the same
 * reason: on a small window these fixed pixel margins can eat a whole axis,
 * and a frame of zero (or negative) size yields a camera nobody can use.
 */
const MIN_FIT_FRAME_SHARE = 0.25

/**
 * How many times the zoom solve is re-run against its own answer.
 *
 * Fit has to frame what is DRAWN, and a body's drawn radius depends on the
 * zoom through `bodyZoomFactor` — which is the zoom being solved for. So it
 * is a fixed point: guess the factor, solve the zoom, take the factor that
 * zoom implies, repeat. The curve is shallow (`zoom ** -FACTOR_K`, capped)
 * so the iteration contracts fast; a handful of rounds lands well inside a
 * pixel, and fit runs on a keystroke rather than on every frame.
 */
const FIT_SOLVE_ROUNDS = 6

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/**
 * The map's default zoom — the zoom at and above which the counter-zoom
 * stops inflating bodies. Exported because `Moon` seeds its DOM affordance's
 * scale off it before the first frame has a camera to read.
 *
 * NOT "the zoom at which bodies are drawn exactly as the canvas specifies
 * them", which this used to say: the canvas quotes bodies against a 100 px
 * planet and a zoom of 60 draws that planet 60 px wide. Design px equal CSS
 * px at zoom 100, which is above the reference and therefore outside the
 * curve entirely (see `bodyDesignPxToScreenPx`).
 */
export const REFERENCE_ZOOM = 60
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

/** `moonPx`/`planetPx` in `visuals.ts`: bodies are quoted against a 100 px planet. */
const DESIGN_PX_PER_WORLD_UNIT = 100

/**
 * Design px → CSS px for anything drawn in DOM ON TOP of a body: the moon's
 * hit area, its halo, its active ring and brackets (`MoonControl` in
 * `Moon.tsx`).
 *
 * The map quotes every body in "design px" against a 100 px planet — one
 * design px is `0.01` world units (`moonPx` in `visuals.ts`). A world unit
 * covers `zoom` screen px on this orthographic camera, and a body's group is
 * additionally scaled by `bodyZoomFactor(zoom)` (and, for a moon's body
 * alone, by the appearance multiplier `bodyScale`). So one design px of a
 * body is, on screen:
 *
 *     bodyZoomFactor(zoom) * bodyScale * zoom / 100   CSS px
 *
 * Worth stating plainly because the counter-zoom is easy to mistake for a
 * constant-screen-size trick and it is not: `bodyZoomFactor` is clamped to 1
 * from BELOW (see its own doc — "One-sided"), so above the reference zoom it
 * contributes nothing at all and a body's screen size grows linearly with
 * `zoom`. Across the 5–400 range this factor spans roughly 0.17 to 4.0 —
 * a 23× span that a fixed CSS-px overlay cannot follow. At the map's default
 * zoom of 60 it is 0.6, not 1: the canvas's 100 px planet draws 60 px wide.
 *
 * Pure and exported for tests; the frame loop in `Moon` reads
 * `state.camera.zoom` and hands the result to `MoonControl`, because camera
 * state deliberately never reaches React (`useSceneModel`).
 */
export function bodyDesignPxToScreenPx(zoom: number, bodyScale = 1): number {
  return (bodyZoomFactor(zoom) * bodyScale * zoom) / DESIGN_PX_PER_WORLD_UNIT
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
 * A body for `fitView` to frame: where it sits, plus how far its drawing
 * reaches out from there in world units at reference zoom — a planet's
 * `footprint`, the hole's halo. Omit `r` and it is framed as a bare point.
 */
export interface FitBody extends Position {
  r?: number
}

/** Bounding box of the bodies, each inflated by its drawn radius. */
function fitBox(bodies: FitBody[], factor: number) {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const b of bodies) {
    const r = (b.r ?? 0) * factor
    if (b.x - r < minX) minX = b.x - r
    if (b.x + r > maxX) maxX = b.x + r
    if (b.y - r < minY) minY = b.y - r
    if (b.y + r > maxY) maxY = b.y + r
  }
  return { minX, maxX, minY, maxY }
}

/**
 * Computes a camera state that frames every given body, for the "fit" zoom
 * control. Falls back to the default camera (origin, zoom 60) when there's
 * nothing to fit.
 *
 * `insets` are the panels covering the map's edges. Fit frames the box into
 * the strip BETWEEN them — sized to the strip, then centred in it the way
 * `centerOn` does — so "show me everything" does not park half the sessions
 * under the sidebar or the detail panel. Omit them to fit the full viewport.
 * Inside that strip it keeps `FIT_MARGIN_PX` clear on every side, and it
 * frames what each body DRAWS rather than the point it stands on.
 */
export function fitView(
  bodies: FitBody[],
  viewport: Viewport,
  insets: Insets = { left: 0, right: 0 }
): CameraState {
  if (bodies.length === 0) {
    return { x: 0, y: 0, zoom: 60 }
  }

  // The rectangle the box has to land inside: the strip the panels leave,
  // less the margins that keep the bodies off the map's own overlays.
  const strip = Math.max(
    viewport.width - insets.left - insets.right,
    viewport.width * MIN_FIT_STRIP_SHARE
  )
  const frameWidth = Math.max(
    strip - FIT_MARGIN_PX.left - FIT_MARGIN_PX.right,
    strip * MIN_FIT_FRAME_SHARE
  )
  const frameHeight = Math.max(
    viewport.height - FIT_MARGIN_PX.top - FIT_MARGIN_PX.bottom,
    viewport.height * MIN_FIT_FRAME_SHARE
  )

  // Orthographic projection: on-screen pixels = world units * zoom, so the
  // zoom that makes a world span exactly fill a frame span is framePx /
  // worldUnits. Pick whichever axis is tighter so both fit — then re-solve
  // against the body inflation that zoom implies (`FIT_SOLVE_ROUNDS`).
  let box = fitBox(bodies, 1)
  let zoom = clampZoom(Math.min(frameWidth, frameHeight))
  for (let i = 0; i < FIT_SOLVE_ROUNDS; i++) {
    box = fitBox(bodies, bodyZoomFactor(zoom))
    const zoomX = frameWidth / Math.max(box.maxX - box.minX, 1e-6)
    const zoomY = frameHeight / Math.max(box.maxY - box.minY, 1e-6)
    zoom = clampZoom(Math.min(zoomX, zoomY))
  }

  const centerX = (box.minX + box.maxX) / 2
  const centerY = (box.minY + box.maxY) / 2

  // Where the frame's centre sits on screen: the strip's centre, shifted by
  // half the difference between the side margins. The camera's x/y is the
  // world point at the VIEWPORT centre, so landing the box's centre on the
  // frame's centre means offsetting the camera by exactly that screen
  // distance, converted back into world units — `centerOn`'s move, with the
  // margins folded in. The vertical pair reads the other way round because
  // screen y grows downward while world y grows upward: the taller bottom
  // margin has to push the bodies UP.
  const offsetX =
    (insets.left - insets.right) / 2 + (FIT_MARGIN_PX.left - FIT_MARGIN_PX.right) / 2
  const offsetY = (FIT_MARGIN_PX.bottom - FIT_MARGIN_PX.top) / 2
  return { x: centerX - offsetX / zoom, y: centerY - offsetY / zoom, zoom }
}
