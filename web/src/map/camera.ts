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

/** Extra world-space padding kept around a fitted bounding box's edges. */
const FIT_PADDING = 2

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
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

/** Adjusts zoom by a delta (positive = zoom in), clamped to [MIN_ZOOM, MAX_ZOOM]. */
export function applyZoom(cam: CameraState, deltaZoom: number): CameraState {
  return { ...cam, zoom: clampZoom(cam.zoom + deltaZoom) }
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
