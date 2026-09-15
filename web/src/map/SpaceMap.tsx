import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Html, Stars } from '@react-three/drei'
import type { OrthographicCamera } from 'three'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { Planet } from './Planet'
import { Moon } from './Moon'
import { useSceneModel } from './useSceneModel'
import { applyPan, applyZoom, fitView, zoomFromWheel, type CameraState } from './camera'

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

/** Faint nebula gradient behind the starfield, per artboard 1a. */
function NebulaBackdrop() {
  return (
    <mesh position={[0, 0, -50]}>
      <planeGeometry args={[600, 600]} />
      <meshBasicMaterial color="#0f1830" transparent opacity={0.35} depthWrite={false} />
    </mesh>
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
    setCamera((cam) => ({ ...cam, zoom: zoomFromWheel(cam.zoom, e.deltaY, e.deltaMode) }))
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
      <Canvas orthographic camera={{ zoom: INITIAL_CAMERA.zoom, position: [0, 0, 100] }}>
        <CameraRig camera={camera} />
        <ambientLight intensity={0.6} />
        <Stars radius={80} depth={40} count={1200} factor={2} saturation={0} fade speed={0.25} />
        <NebulaBackdrop />

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

        {model.labels.map((label) => (
          <Html key={label.tagId} position={[label.x, label.y, 0]} center style={{ pointerEvents: 'none' }}>
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

      {/* Plain-DOM HUD overlay, outside the Canvas. */}
      <div className="pointer-events-none absolute inset-0">
        <div className="pointer-events-none absolute right-6 top-6 font-mono text-[10.5px] tracking-[0.1em] text-text-muted">
          {aggregateLine}
        </div>

        <div className="pointer-events-none absolute bottom-6 left-6 font-mono text-[10.5px] tracking-[0.08em] text-text-muted/70">
          {zoomPercent}% · x {camX} y {camY}
        </div>

        <div className="pointer-events-auto absolute bottom-6 right-6 flex gap-2">
          <Button variant="ghost" size="sm" aria-label="Zoom out" onClick={zoomOut}>
            −
          </Button>
          <Button variant="ghost" size="sm" aria-label="Fit view" onClick={handleFit}>
            fit
          </Button>
          <Button variant="ghost" size="sm" aria-label="Zoom in" onClick={zoomIn}>
            +
          </Button>
        </div>

        <Button
          className="pointer-events-auto absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full"
          onClick={() => setDialog('new')}
        >
          + New session
          <span className="font-mono text-[10px] text-text-muted">⌘N</span>
        </Button>

        <div
          className="orbital-sloth pointer-events-none absolute"
          style={{ left: `${SLOTH_LEFT_PERCENT}%`, top: `${SLOTH_TOP_PERCENT}%`, width: 16, opacity: 0.7 }}
        >
          <div className="orbital-sloth-bob">
            <img
              src="/sloth.svg"
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
