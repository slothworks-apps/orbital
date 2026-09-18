import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { Group, OrthographicCamera } from 'three'
import { useOrbital, parsePlanetScale, parseDetailPanelWidth } from '../store/store'
import { labelFontPx } from './visuals'
import { Button } from '../ui/Button'
import { Planet } from './Planet'
import { Moon } from './Moon'
import { Hole } from './Hole'
import { useSceneModel } from './useSceneModel'
import type { SceneLabel } from './sceneModel'
import { LABEL_MARGIN, PLANET_BASE_RADIUS } from './layout'
import {
  createSimulation,
  dragSimBody,
  holeDropState,
  rehomeTarget,
  reconcileSimulation,
  settleSimulation,
  stepSimulation,
  type SimBody,
  type SimInput,
  type SimState,
} from './simulation'
import {
  BODY_MOVE_MS,
  advancePointTween,
  createPointTween,
  prefersReducedMotion,
  retargetPointTween,
} from './transition'
import {
  applyPan,
  applyZoom,
  bodyZoomFactor,
  centerOn,
  fitView,
  screenToWorld,
  zoomAt,
  zoomFromWheel,
  type CameraState,
  type Position,
} from './camera'

/**
 * Top-down space map scene: a `Canvas` (WebGL, untestable in jsdom) driven
 * entirely by `useSceneModel`/`buildSceneModel` (pure, unit-tested in
 * `test/spacemap.test.tsx`) plus custom pan/zoom camera math (`camera.ts`,
 * also unit-tested there). This file just wires those two testable pieces
 * to React Three Fiber components and a plain-DOM HUD overlay.
 */

const INITIAL_CAMERA: CameraState = { x: 0, y: 0, zoom: 60 }
const ZOOM_STEP = 20
/** Below this many screen px of movement, a pointer down+up is treated as a click, not a drag-pan. */
const DRAG_THRESHOLD_PX = 3

/**
 * Sloth's resting position, expressed as a percentage of the map viewport
 * rather than a fixed pixel offset — the original design artboard is a
 * fixed 1440x900 canvas (sloth at left:120/top:640), but `SpaceMap` is a
 * full-bleed, arbitrarily-sized viewport, so a literal pixel offset would
 * drift off-proportion (or off-screen) at other viewport sizes.
 */
const SLOTH_LEFT_PERCENT = (120 / 1440) * 100
const SLOTH_TOP_PERCENT = (640 / 900) * 100

/**
 * Map width the panels sit on, in CSS pixels — what `centerOn` keeps the
 * followed planet clear of. The detail panel's width is live (drag handle,
 * `detail_panel_width`) plus its 16px inset (1b); the sidebar is 340px open
 * and 96px collapsed (1a).
 */
const DETAIL_PANEL_GUTTER_PX = 16
const SIDEBAR_OPEN_PX = 340
const SIDEBAR_COLLAPSED_PX = 96

/**
 * How far the selected planet has to move before the camera goes after it, in
 * world units (a planet's radius is 1). Adding or ending a session renumbers
 * its cluster's spiral and nudges everything in it by a fraction of a planet;
 * chasing those would leave the map twitching. A retag is a whole cluster
 * away, so it clears this by an order of magnitude.
 */
const FOLLOW_MIN_DISTANCE = 1.5

/** Imperatively syncs a plain `CameraState` onto the live three.js orthographic camera every frame. */
function CameraRig({ camera: camState }: { camera: CameraState }) {
  const { camera } = useThree()

  useFrame(() => {
    camera.position.x = camState.x
    camera.position.y = camState.y
    const ortho = camera as unknown as OrthographicCamera
    if (ortho.zoom !== camState.zoom) {
      ortho.zoom = camState.zoom
      ortho.updateProjectionMatrix()
    }
  })

  return null
}

/**
 * A cluster's label, tracking the clump per frame: anchored above the
 * topmost BONDED body of its tag, read straight off the simulation the same
 * way the planets read their own positions. Falls back to the scene model's
 * anchor when the sim has no bodies for the tag yet (first frame).
 *
 * `Html` reprojects from its parent's world matrix every frame, so writing
 * the wrapping group's position is all it takes.
 */
function ClusterLabel({ label, simRef }: { label: SceneLabel; simRef: RefObject<SimState> }) {
  const groupRef = useRef<Group>(null)

  useFrame(() => {
    if (!groupRef.current) return
    let top: SimBody | null = null
    for (const body of simRef.current.bodies.values()) {
      if (body.tagId !== label.tagId || body.mode !== 'hold') continue
      if (!top || body.y + body.r > top.y + top.r) top = body
    }
    if (top) groupRef.current.position.set(top.x, top.y + top.r + LABEL_MARGIN, 0)
    else groupRef.current.position.set(label.x, label.y, 0)
  })

  return (
    <group ref={groupRef} position={[label.x, label.y, 0]}>
      {/* zIndexRange keeps map text under the z-10 side panels and z-50 dialogs (drei's default range is in the millions). */}
      <Html center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
        <span
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 10,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: `oklch(80% .13 ${label.hue} / .45)`,
            whiteSpace: 'nowrap',
          }}
        >
          {label.text}
        </span>
      </Html>
    </group>
  )
}

/** The ring-flash duration on absorption (canvas 4a script: `this.flash = 0.45`). */
const ABSORB_FLASH_SEC = 0.45

/**
 * Steps the spring simulation once per frame, ahead of every planet's own
 * frame callback (negative priority), and turns absorption events into the
 * hole's ring flash. Under reduced motion the sim was already settled
 * synchronously at reconcile time, so there is nothing to animate here.
 */
function SimStepper({
  simRef,
  flashRef,
  reduced,
}: {
  simRef: RefObject<SimState>
  flashRef: MutableRefObject<number>
  reduced: boolean
}) {
  useFrame((_, delta) => {
    if (reduced) return
    const events = stepSimulation(simRef.current, delta)
    if (events.absorbed.length > 0) flashRef.current = ABSORB_FLASH_SEC
  }, -1)
  return null
}

/**
 * Eases the camera to a world position over `BODY_MOVE_MS` — the same
 * duration and curve the planets walk on, so the map and the view arrive
 * together.
 *
 * Driven by `requestAnimationFrame` into `setCamera` rather than by a tween
 * inside `CameraRig`: the camera state is what the HUD readout and every
 * subsequent gesture are computed from, so it has to actually BE at the new
 * place when the pan ends, not merely look like it. A per-frame `setCamera`
 * is exactly what dragging the map already does.
 *
 * `cancel` is the other half of the contract: any pointer or wheel gesture
 * abandons the pan where it stands. A camera that keeps sliding under a hand
 * already on the map is a fight, not a feature.
 */
function usePanTo(setCamera: (next: (cam: CameraState) => CameraState) => void) {
  const tween = useRef(createPointTween(0, 0, BODY_MOVE_MS))
  const frame = useRef(0)
  const lastMs = useRef(0)

  const cancel = useCallback(() => {
    if (frame.current !== 0) cancelAnimationFrame(frame.current)
    frame.current = 0
    tween.current.x.active = false
    tween.current.y.active = false
  }, [])

  useEffect(() => cancel, [cancel])

  const panTo = useCallback(
    (from: Position, to: Position) => {
      cancel()
      const pt = tween.current
      // Seed both ends: `retargetPointTween` interpolates from wherever the
      // tween currently is, which for a fresh pan must be the live camera.
      pt.x.value = from.x
      pt.y.value = from.y
      retargetPointTween(pt, to.x, to.y, prefersReducedMotion())

      const step = (nowMs: number) => {
        const delta = (nowMs - lastMs.current) / 1000
        lastMs.current = nowMs
        advancePointTween(pt, delta)
        // Functional update, so a zoom that lands mid-pan keeps its zoom.
        setCamera((cam) => ({ ...cam, x: pt.x.value, y: pt.y.value }))
        frame.current = pt.x.active || pt.y.active ? requestAnimationFrame(step) : 0
      }

      lastMs.current = performance.now()
      frame.current = requestAnimationFrame(step)
    },
    [cancel, setCamera]
  )

  return { panTo, cancel }
}

/**
 * Space backdrop, verbatim from artboard 1a: nebula wash + two star layers
 * as plain DOM behind the transparent WebGL canvas (the design builds them
 * from CSS gradients, so we reuse those exact declarations in theme.css).
 */
function SpaceBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="orbital-nebula absolute inset-0" />
      <div className="orbital-stars-far absolute inset-0" />
      <div className="orbital-stars-near absolute inset-0" />
    </div>
  )
}

/** True while focus sits in a text input/textarea/contenteditable — global shortcuts should not fire there. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

export function SpaceMap() {
  const model = useSceneModel()
  const select = useOrbital((s) => s.select)
  const setDialog = useOrbital((s) => s.setDialog)
  // Appearance → default planet size (canvas 5a). Premultiplied into each
  // planet's `scale` prop at the call site below, so `sceneModel`/`layout`
  // never see it — orbit radii and cluster spacing stay put by design.
  const planetScale = useOrbital((s) => parsePlanetScale(s.settings))
  const scaleLabels = useOrbital((s) => s.settings.map_scale_labels === 'true')
  const labelFont = labelFontPx(planetScale, scaleLabels)
  // Live panel width for the follow inset and the right-anchored overlays —
  // the drag handle moves it, and while it is held (`resizingPanel`) the
  // overlays drop their transition so they track the pointer with the panel.
  const detailPanelWidth = useOrbital((s) => parseDetailPanelWidth(s.settings, window.innerWidth))
  const resizingPanel = useOrbital((s) => s.ui.resizingPanel ?? false)
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const sidebarCollapsed = useOrbital((s) => s.ui.sidebarCollapsed)
  const errorsUnseen = useOrbital((s) => s.errorsUnseen)
  const errorLogOpen = useOrbital((s) => s.ui.dialog === 'errors')
  // 24px clear of the open panel and its 16px inset; the export's own edge
  // inset (right:24px) when nothing is selected. No transition while the
  // drag handle is held — the overlays track the pointer with the panel.
  const overlayRightPx = selectedId ? detailPanelWidth + DETAIL_PANEL_GUTTER_PX + 24 : 24
  const overlayTransition = resizingPanel
    ? ''
    : 'transition-[right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]'
  const setSessionDismissed = useOrbital((s) => s.setSessionDismissed)
  const setTagAnchor = useOrbital((s) => s.setTagAnchor)
  const revealHistory = useOrbital((s) => s.revealHistory)

  // --- Spring simulation (spec 2026-09-18-tag-clusters-design § 1-2) --------
  // The sim state lives in a ref and is reconciled against every fresh scene
  // model DURING render (deliberately — bodies must exist before the planets
  // that read them render; the reconcile is idempotent, so StrictMode's
  // double-render is harmless). Motion happens in <SimStepper>'s frame loop;
  // under reduced motion the sim is settled synchronously instead and
  // renders statically.
  const simRef = useRef<SimState>(null as unknown as SimState)
  if (simRef.current === null) simRef.current = createSimulation()
  const holeFlashRef = useRef(0)
  const reduced = prefersReducedMotion()
  useMemo(() => {
    const input: SimInput = {
      bodies: model.planets.map((p) => ({
        id: p.session.id,
        tagId: p.tagId,
        x: p.x,
        y: p.y,
        r: p.scale * PLANET_BASE_RADIUS,
        live: p.session.status === 'working' || p.session.status === 'needs_input',
        released: p.released,
      })),
      anchors: model.anchors.map(({ tagId, x, y }) => ({ tagId, x, y })),
      hole: { x: model.hole.x, y: model.hole.y },
    }
    reconcileSimulation(simRef.current, input)
    if (reduced) settleSimulation(simRef.current)
  }, [model, reduced])

  const [camera, setCamera] = useState<CameraState>(INITIAL_CAMERA)
  /** Read by the follow effect, which needs where the camera IS without re-running whenever it moves. */
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const { panTo, cancel: cancelPan } = usePanTo(setCamera)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number; captured: boolean } | null>(null)
  /** Set true once a drag crosses `DRAG_THRESHOLD_PX`; the click handler below checks this to ignore the trailing click a drag-release produces. Reset on the next pointerdown, not on pointerup — the native `click` event fires AFTER pointerup, so it must still see this drag's `true`. */
  const draggedRef = useRef(false)

  /**
   * A pending/engaged BODY drag (canvas 4a): pointer-down landed on a planet,
   * so the pointer belongs to that body, not to the pan. Below the movement
   * threshold the gesture stays a click (select); past it the body pins to
   * the pointer and its clump trails after it through the barycentre spring.
   */
  const bodyDragRef = useRef<{
    id: string
    pointerId: number
    startX: number
    startY: number
    engaged: boolean
  } | null>(null)

  const handleSelect = useCallback(
    (id: string) => {
      if (draggedRef.current) return
      void select(id)
    },
    [select]
  )

  const handleBodyPointerDown = useCallback((id: string, e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0) return
    bodyDragRef.current = {
      id,
      pointerId: e.nativeEvent.pointerId,
      startX: e.nativeEvent.clientX,
      startY: e.nativeEvent.clientY,
      engaged: false,
    }
  }, [])

  /** The dragged pointer's world position, for pinning the sim body under it. */
  const pointerToWorld = useCallback((e: ReactPointerEvent<HTMLDivElement>): Position => {
    const rect = e.currentTarget.getBoundingClientRect()
    return screenToWorld(
      cameraRef.current,
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      { width: rect.width, height: rect.height }
    )
  }, [])

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      // A hand on the map outranks a pan in flight.
      cancelPan()
      draggedRef.current = false
      // The three.js pointer-down on a planet ran first (the canvas is a
      // child of this container): that pointer is dragging a BODY, so the
      // map must not also pan under it.
      if (bodyDragRef.current?.pointerId === e.pointerId) return
      dragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, captured: false }
    },
    [cancelPan]
  )

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const bodyDrag = bodyDragRef.current
      if (bodyDrag && bodyDrag.pointerId === e.pointerId) {
        if (!bodyDrag.engaged) {
          // Same click-jitter threshold as the pan: below it the gesture is
          // still a click on the planet.
          if (
            Math.abs(e.clientX - bodyDrag.startX) < DRAG_THRESHOLD_PX &&
            Math.abs(e.clientY - bodyDrag.startY) < DRAG_THRESHOLD_PX
          ) {
            return
          }
          bodyDrag.engaged = true
          draggedRef.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
        }
        dragSimBody(simRef.current, bodyDrag.id, pointerToWorld(e))
        // Reduced motion renders the sim statically, so a drag converges the
        // field synchronously instead of animating toward it.
        if (reduced) settleSimulation(simRef.current)
        return
      }

      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      const dx = e.clientX - drag.lastX
      const dy = e.clientY - drag.lastY

      if (!drag.captured) {
        // Don't capture the pointer (or count this as a drag) until it's
        // actually moved past the click-jitter threshold — capturing
        // eagerly on pointerdown steals the native click that would
        // otherwise fire on a Planet mesh for a plain click, breaking
        // click-to-select.
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
        drag.captured = true
        draggedRef.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
      }

      drag.lastX = e.clientX
      drag.lastY = e.clientY
      setCamera((cam) => applyPan(cam, dx, dy))
    },
    [pointerToWorld, reduced]
  )

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const bodyDrag = bodyDragRef.current
      if (bodyDrag && bodyDrag.pointerId === e.pointerId) {
        bodyDragRef.current = null
        if (bodyDrag.engaged) {
          e.currentTarget.releasePointerCapture(e.pointerId)
          const sim = simRef.current
          // Releasing an idle/ended body inside the halo cuts its bond —
          // absorption, with the 10s undo toast. A working body is never
          // absorbable: it just springs back (the halo repels it). The same
          // predicate drives the hole's armed drop-target signal, so what
          // the hole promises on release is exactly what happens. Any other
          // drop re-homes the clump: the tag's anchor moves to the release
          // point (persisted), so the dragged body stays put and its mates
          // fly to it — except near the hole, where `rehomeTarget` declines
          // and the clump drifts back to its old home. Both read BEFORE
          // dragSimBody(null): they require an active drag.
          const factor = bodyZoomFactor(cameraRef.current.zoom)
          const drop = holeDropState(sim, bodyDrag.id, factor)
          const rehome = rehomeTarget(sim, bodyDrag.id, factor)
          dragSimBody(sim, bodyDrag.id, null)
          if (drop === 'armed') void setSessionDismissed(bodyDrag.id, true)
          else if (rehome) void setTagAnchor(rehome.tagId, { x: rehome.x, y: rehome.y })
          if (reduced) settleSimulation(simRef.current)
        }
        return
      }

      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      if (drag.captured) e.currentTarget.releasePointerCapture(e.pointerId)
      dragRef.current = null
    },
    [reduced, setSessionDismissed, setTagAnchor]
  )

  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      cancelPan()
      // Read the geometry out here, not inside the updater: React may run the
      // updater after the event has been handed back, when `currentTarget` is
      // already null.
      const rect = e.currentTarget.getBoundingClientRect()
      const pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const viewport = { width: rect.width, height: rect.height }
      setCamera((cam) => zoomAt(cam, zoomFromWheel(cam.zoom, e.deltaY, e.deltaMode), pointer, viewport))
    },
    [cancelPan]
  )

  const zoomIn = useCallback(() => {
    cancelPan()
    setCamera((cam) => applyZoom(cam, ZOOM_STEP))
  }, [cancelPan])
  const zoomOut = useCallback(() => {
    cancelPan()
    setCamera((cam) => applyZoom(cam, -ZOOM_STEP))
  }, [cancelPan])

  const handleFit = useCallback(() => {
    cancelPan()
    // The hole is part of the map — fit frames it with the planets, so the
    // history landmark is never fitted out of view.
    const positions: Position[] = [
      ...model.planets.map((p) => ({ x: p.x, y: p.y })),
      { x: model.hole.x, y: model.hole.y },
    ]
    const rect = containerRef.current?.getBoundingClientRect()
    const viewport = {
      width: rect?.width ?? window.innerWidth,
      height: rect?.height ?? window.innerHeight,
    }
    setCamera(fitView(positions, viewport))
  }, [cancelPan, model.planets, model.hole.x, model.hole.y])

  const handleHoleOpen = useCallback(() => {
    // The click a drag-release produces must not also open the sidebar.
    if (draggedRef.current) return
    revealHistory()
  }, [revealHistory])

  /**
   * Follows the selected planet when the LAYOUT moves it — which in practice
   * means retagging, the one action that sends a session to the far side of
   * the map. Without this the planet you are reading about walks off-screen
   * and you have to go find it.
   *
   * Only a planet that was ALREADY selected is followed: selecting a
   * different session is the user pointing at something they can evidently
   * see, and hauling the camera there would take the rest of the map away
   * from them for no reason.
   */
  const followed = model.planets.find((p) => p.selected && !p.released)
  const followedId = followed?.session.id
  const followedX = followed?.x
  const followedY = followed?.y
  const lastFollowed = useRef<{ id: string; x: number; y: number } | null>(null)

  useEffect(() => {
    if (followedId === undefined || followedX === undefined || followedY === undefined) {
      lastFollowed.current = null
      return
    }
    const previous = lastFollowed.current
    lastFollowed.current = { id: followedId, x: followedX, y: followedY }
    if (!previous || previous.id !== followedId) return
    if (Math.hypot(followedX - previous.x, followedY - previous.y) < FOLLOW_MIN_DISTANCE) return

    const cam = cameraRef.current
    const target = centerOn(cam, { x: followedX, y: followedY }, {
      left: sidebarCollapsed ? SIDEBAR_COLLAPSED_PX : SIDEBAR_OPEN_PX,
      // The panel is open whenever something is selected, and something is
      // selected whenever there is a planet to follow. Its width is live —
      // a dragged-wider panel must keep the followed planet clear of it.
      right: detailPanelWidth + DETAIL_PANEL_GUTTER_PX,
    })
    panTo({ x: cam.x, y: cam.y }, { x: target.x, y: target.y })
  }, [followedId, followedX, followedY, panTo, sidebarCollapsed, detailPanelWidth])

  // ⌥N / Alt+N opens the new-session dialog, matching the floating
  // button's shortcut hint. Not ⌘N: browsers reserve that for a new window
  // at the application level, so the page never sees it. Matched on e.code
  // because on a US layout ⌥N is the dead key for a combining tilde and
  // e.key arrives as '˜' — the physical key is what is meant. Ignored while
  // the user is typing somewhere (a search box, a dialog field), where ⌥N
  // is a character someone may genuinely be entering.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.code !== 'KeyN') return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      setDialog('new')
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setDialog])

  const zoomPercent = Math.round(camera.zoom)
  const camX = Math.round(camera.x)
  const camY = Math.round(camera.y)

  /**
   * The aggregate readout. ENDED is plain text again: the 2a/2b suppression
   * toggle is gone — hiding ended sessions is the hole's job now (they fall
   * in after the release delay), so a second hide control would compete with
   * it (spec 2026-09-18-tag-clusters-design § 6).
   */
  const aggregateLine = useMemo(() => {
    const { working, needs_input: needsInput, idle, ended } = model.counts
    const segments = [
      `${working} WORKING`,
      ...(needsInput > 0 ? [`${needsInput} NEEDS INPUT`] : []),
      `${idle} IDLE`,
      `${ended} ENDED`,
    ]
    return segments.join(' · ')
  }, [model.counts])

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-space"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
    >
      <SpaceBackdrop />
      {/* `flat` is R3F's name for `NoToneMapping`. Without it R3F defaults the
          renderer to ACES Filmic, whose signature — saturated bright colours
          desaturating near the top of the range — greyed out every hue the
          canvas specifies (the export is plain CSS in a browser, tone-mapped
          by nothing). See `docs/fixes/aces-tone-mapping-desaturates-the-map.md`.
          Do NOT add `linear` alongside it: that switches the output colour
          space, and the oklch → linear-sRGB path is already correct. */}
      <Canvas flat orthographic camera={{ zoom: INITIAL_CAMERA.zoom, position: [0, 0, 100] }}>
        <CameraRig camera={camera} />
        <SimStepper simRef={simRef} flashRef={holeFlashRef} reduced={reduced} />
        <ambientLight intensity={0.6} />

        {model.planets.map((planet) => (
          <Planet
            key={planet.session.id}
            session={planet.session}
            hue={planet.hue}
            x={planet.x}
            y={planet.y}
            // Split, not premultiplied: the tier half tweens on a state
            // change, the slider half must track a drag 1:1 (see PlanetProps).
            scale={planet.scale}
            scaleMultiplier={planetScale}
            selected={planet.selected}
            modelFamily={planet.modelFamily}
            labelTitlePx={labelFont.title}
            labelFamilyPx={labelFont.family}
            onClick={handleSelect}
            simBody={simRef.current.bodies.get(planet.session.id)}
            onBodyPointerDown={handleBodyPointerDown}
          />
        ))}

        {model.moons.map((moon) => (
          <Moon
            key={`${moon.sessionId}:${moon.subagent.id}`}
            subagent={moon.subagent}
            hue={moon.hue}
            parentX={moon.parentX}
            parentY={moon.parentY}
            orbitRadius={moon.orbitRadius}
            phase={moon.phase}
            bodyScale={planetScale}
            parentBody={simRef.current.bodies.get(moon.sessionId)}
          />
        ))}

        {model.labels.map((label) => (
          <ClusterLabel key={label.tagId} label={label} simRef={simRef} />
        ))}

        <Hole
          hole={model.hole}
          flashRef={holeFlashRef}
          simRef={simRef}
          dragRef={bodyDragRef}
          onOpen={handleHoleOpen}
        />
      </Canvas>

      {/* Plain-DOM HUD overlay, outside the Canvas. `z-6` is load-bearing: the
          map's own labels are positioned with `zIndexRange` up to 5, and a
          positive z-index paints above a later sibling whose z-index is auto —
          so without it, planet titles print straight through the New session
          button and the zoom stack. Still under the z-10 panels and z-50
          dialogs. */}
      <div className="pointer-events-none absolute inset-0 z-[6]">
        {/* Aggregate readout (1a, right:24px/top:24px), plain text end to end.
            It tracks the detail panel on the same 420ms curve as the zoom
            stack below — otherwise the panel slides in over the top of it. */}
        <div
          data-overlay="aggregate"
          className={[
            'pointer-events-none absolute top-6 flex flex-col items-end gap-2',
            overlayTransition,
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ right: overlayRightPx }}
        >
          <div className="flex items-center gap-2 font-mono text-[10.5px] tracking-[0.1em] text-text-muted">
            <span>{aggregateLine}</span>
          </div>
        </div>

        {/* The camera readout tracks the sidebar rather than the viewport edge:
            the export animates `left` between 340px (expanded) and 96px
            (collapsed) on the same 420ms curve as the panel width. */}
        <div
          className={[
            'pointer-events-none absolute bottom-6 font-mono text-[10.5px] tracking-[0.08em] text-text-muted/70',
            'transition-[left] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]',
            sidebarCollapsed ? 'left-24' : 'left-[340px]',
          ].join(' ')}
        >
          {zoomPercent}% · x {camX} y {camY}
        </div>

        {/* Zoom column per artboard 1a (right:24px); an open panel moves it
            24px clear of the panel's live width + 16px inset. The errors
            trigger rides on top of the joined zoom stack so the whole column
            tracks the panel as one. */}
        <div
          data-overlay="zoom-column"
          className={[
            'pointer-events-auto absolute bottom-6 flex flex-col items-stretch gap-2',
            overlayTransition,
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ right: overlayRightPx }}
        >
          {/* The one always-there way into the error log — canvas 5a/5c.
              Same shell as the zoom stack, 8px above it, never joined to it.
              Nothing unseen → the glyph drops to muted ink and the badge is
              absent; open → accent frame and ring. The badge red is
              oklch(60% .2 25), precomputed to #de3b3d, and is the only red
              on the map. */}
          <button
            type="button"
            aria-label={errorsUnseen > 0 ? `Error log — ${errorsUnseen} unseen` : 'Error log'}
            title="Error log"
            onClick={() => setDialog('errors')}
            className={[
              'relative grid h-[34px] w-[34px] place-items-center rounded-[9px] border bg-[rgba(10,14,24,.7)] text-base font-bold leading-none backdrop-blur-[16px] transition-colors',
              errorLogOpen
                ? 'border-accent/50 text-text-bright shadow-[0_0_0_3px_rgba(89,228,243,.1)]'
                : [
                    'border-[rgba(150,205,255,.16)] hover:border-[rgba(150,205,255,.3)] hover:bg-[rgba(150,205,255,.1)] hover:text-white',
                    errorsUnseen > 0 ? 'text-text-bright' : 'text-[rgba(200,220,245,.6)]',
                  ].join(' '),
            ].join(' ')}
          >
            <span aria-hidden>!</span>
            {errorsUnseen > 0 && (
              <span
                aria-hidden
                className={[
                  'absolute -top-1.5 grid h-4 min-w-[16px] place-items-center rounded-full border border-[rgba(2,4,9,.8)] bg-[#de3b3d] font-mono text-[9.5px] font-medium tracking-[0.02em] text-white',
                  // The wider 99+ badge hangs 4px further out (5c).
                  errorsUnseen > 99 ? '-right-2.5 px-[5px]' : '-right-1.5 px-1',
                ].join(' ')}
              >
                {errorsUnseen > 99 ? '99+' : errorsUnseen}
              </span>
            )}
          </button>

          <div className="flex flex-col overflow-hidden rounded-[9px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,14,24,.7)] backdrop-blur-[16px]">
            <button
              type="button"
              aria-label="Zoom in"
              onClick={zoomIn}
              className="grid h-[34px] w-[34px] place-items-center border-b border-[rgba(150,205,255,.1)] text-base text-text-bright hover:bg-white/5"
            >
              +
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              onClick={zoomOut}
              className="grid h-[34px] w-[34px] place-items-center border-b border-[rgba(150,205,255,.1)] text-base text-text-bright hover:bg-white/5"
            >
              −
            </button>
            <button
              type="button"
              aria-label="Fit view"
              onClick={handleFit}
              className="grid h-[34px] w-[34px] place-items-center text-sm text-text-bright hover:bg-white/5"
            >
              ⌖
            </button>
          </div>
        </div>

        <Button
          variant="cta"
          size="lg"
          className="pointer-events-auto absolute bottom-6 left-1/2 -translate-x-1/2"
          onClick={() => setDialog('new')}
        >
          <span aria-hidden className="text-base leading-none text-accent">+</span>
          New session
          <span className="rounded border border-[rgba(150,205,255,.2)] px-1.5 py-0.5 font-mono text-[10px] text-[rgba(200,220,245,.7)]">
            ⌥N
          </span>
        </Button>

        <div
          className="orbital-sloth pointer-events-none absolute"
          style={{ left: `${SLOTH_LEFT_PERCENT}%`, top: `${SLOTH_TOP_PERCENT}%`, width: 16, opacity: 0.7 }}
        >
          <div className="orbital-sloth-bob">
            <img
              src="/sloth.png"
              alt=""
              style={{
                display: 'block',
                width: 16,
                height: 'auto',
                filter: 'drop-shadow(0 0 4px oklch(80% .13 210 / .35))',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
