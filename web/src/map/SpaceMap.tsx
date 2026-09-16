import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { OrthographicCamera } from 'three'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { Planet } from './Planet'
import { Moon } from './Moon'
import { useSceneModel } from './useSceneModel'
import { applyPan, applyZoom, fitView, zoomAt, zoomFromWheel, type CameraState } from './camera'

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
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const sidebarCollapsed = useOrbital((s) => s.ui.sidebarCollapsed)

  const [camera, setCamera] = useState<CameraState>(INITIAL_CAMERA)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number; captured: boolean } | null>(null)
  /** Set true once a drag crosses `DRAG_THRESHOLD_PX`; the click handler below checks this to ignore the trailing click a drag-release produces. Reset on the next pointerdown, not on pointerup — the native `click` event fires AFTER pointerup, so it must still see this drag's `true`. */
  const draggedRef = useRef(false)

  const handleSelect = useCallback(
    (id: string) => {
      if (draggedRef.current) return
      void select(id)
    },
    [select]
  )

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    dragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, captured: false }
    draggedRef.current = false
  }, [])

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
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
  }, [])

  const handlePointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    if (drag.captured) e.currentTarget.releasePointerCapture(e.pointerId)
    dragRef.current = null
  }, [])

  const handleWheel = useCallback((e: ReactWheelEvent<HTMLDivElement>) => {
    // Read the geometry out here, not inside the updater: React may run the
    // updater after the event has been handed back, when `currentTarget` is
    // already null.
    const rect = e.currentTarget.getBoundingClientRect()
    const pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    const viewport = { width: rect.width, height: rect.height }
    setCamera((cam) => zoomAt(cam, zoomFromWheel(cam.zoom, e.deltaY, e.deltaMode), pointer, viewport))
  }, [])

  const zoomIn = useCallback(() => setCamera((cam) => applyZoom(cam, ZOOM_STEP)), [])
  const zoomOut = useCallback(() => setCamera((cam) => applyZoom(cam, -ZOOM_STEP)), [])

  const handleFit = useCallback(() => {
    const positions = model.planets.map((p) => ({ x: p.x, y: p.y }))
    const rect = containerRef.current?.getBoundingClientRect()
    const viewport = {
      width: rect?.width ?? window.innerWidth,
      height: rect?.height ?? window.innerHeight,
    }
    setCamera(fitView(positions, viewport))
  }, [model.planets])

  // ⌘N / Ctrl+N opens the new-session dialog, matching the floating
  // button's shortcut hint — but not while the user is typing somewhere
  // (a search box, a dialog field), where "n" is just a letter.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'n') return
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
      <Canvas orthographic camera={{ zoom: INITIAL_CAMERA.zoom, position: [0, 0, 100] }}>
        <CameraRig camera={camera} />
        <ambientLight intensity={0.6} />

        {model.planets.map((planet) => (
          <Planet
            key={planet.session.id}
            session={planet.session}
            hue={planet.hue}
            x={planet.x}
            y={planet.y}
            scale={planet.scale}
            selected={planet.selected}
            onClick={handleSelect}
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
          />
        ))}

        {/* zIndexRange keeps map text under the z-10 side panels and z-50 dialogs (drei's default range is in the millions). */}
        {model.labels.map((label) => (
          <Html key={label.tagId} position={[label.x, label.y, 0]} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
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
        ))}
      </Canvas>

      {/* Plain-DOM HUD overlay, outside the Canvas. `z-6` is load-bearing: the
          map's own labels are positioned with `zIndexRange` up to 5, and a
          positive z-index paints above a later sibling whose z-index is auto —
          so without it, planet titles print straight through the New session
          button and the zoom stack. Still under the z-10 panels and z-50
          dialogs. */}
      <div className="pointer-events-none absolute inset-0 z-[6]">
        <div className="pointer-events-none absolute right-6 top-6 font-mono text-[10.5px] tracking-[0.1em] text-text-muted">
          {aggregateLine}
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

        {/* Joined zoom stack per artboard 1a (right:24px); 1b moves it to
            right:490px — 24px clear of the 450px detail panel's own 16px inset. */}
        <div
          className={[
            'pointer-events-auto absolute bottom-6 flex flex-col overflow-hidden rounded-[9px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,14,24,.7)] backdrop-blur-[16px] transition-[right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]',
            selectedId ? 'right-[490px]' : 'right-6',
          ].join(' ')}
        >
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

        <Button
          variant="cta"
          size="lg"
          className="pointer-events-auto absolute bottom-6 left-1/2 -translate-x-1/2"
          onClick={() => setDialog('new')}
        >
          <span aria-hidden className="text-base leading-none text-accent">+</span>
          New session
          <span className="rounded border border-[rgba(150,205,255,.2)] px-1.5 py-0.5 font-mono text-[10px] text-[rgba(200,220,245,.7)]">
            ⌘N
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
