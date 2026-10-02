import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { mapStatePills, showCompactBadge, showTrash, trashDropFor, useOrbital } from '../../store/store'
import { sendCompactAware, useCompactionUi } from '../../store/compaction'
import { isReadOnly } from '../../lib/types'
import { reportError } from '../../lib/errors'
import { useDocumentHidden, useWindowFocused } from '../../lib/useWindowFocused'
import { useSceneModel } from '../useSceneModel'
import { applyPan, bodyZoomFactor, clampZoom, fitViewTo, screenToWorld, zoomAt, zoomFromWheel, type CameraState } from '../camera'
import { frameCap, parseMapFps } from '../frameSchedule'
import { HOLE_DROP_RADIUS } from '../simulation'
import { prefersReducedMotion } from '../transition'
import { COMPACT_COMMAND } from '../Planet'
import { MapShell, useMapInsets } from '../shell/MapShell'
import { ArchipelagoScene, type DropState } from './scene'

const DRAG_THRESHOLD_PX = 3
const ZOOM_STEP = 1.3

type Gesture =
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number; startX: number; startY: number; moved: boolean }
  | { kind: 'ship'; pointerId: number; id: string; startX: number; startY: number; moved: boolean }
  | { kind: 'island'; pointerId: number; tagId: number; grab: { x: number; y: number }; startX: number; startY: number; moved: boolean }

/**
 * The Archipelago theme (spec 2026-10-01-map-themes-design § 3): tag clusters
 * as islands, sessions as ships, subagents as rowboats, history as a
 * lighthouse. The drawing lives in `ArchipelagoScene`; this component wires it
 * to the store, the camera and the pointer, the way `SpaceMap` wires planets.
 */
export function ArchipelagoMap() {
  const model = useSceneModel()
  const settings = useOrbital((s) => s.settings)
  const urlRestored = useOrbital((s) => s.ui.urlRestored)
  const detachedIds = useOrbital((s) => s.detachedIds)
  const activeBoatKey = useOrbital((s) => (s.subagentPanel ? `${s.subagentPanel.sessionId}:${s.subagentPanel.subagent.id}` : null))
  const select = useOrbital((s) => s.select)
  const openSubagent = useOrbital((s) => s.openSubagent)
  const trashSession = useOrbital((s) => s.trashSession)
  const setTagAnchor = useOrbital((s) => s.setTagAnchor)
  const revealHistory = useOrbital((s) => s.revealHistory)
  const setDialog = useOrbital((s) => s.setDialog)
  const { insets } = useMapInsets()

  const hostRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<ArchipelagoScene | null>(null)
  const camRef = useRef<CameraState>({ x: 0, y: 0, zoom: 60 })
  const flightRef = useRef<CameraState | null>(null)
  const [camera, setCamera] = useState<CameraState>(camRef.current)
  const gestureRef = useRef<Gesture | null>(null)
  const [confirmEndId, setConfirmEndId] = useState<string | null>(null)
  const fittedRef = useRef(false)

  const windowFocused = useWindowFocused(true)
  const documentHidden = useDocumentHidden()
  const cap = frameCap(parseMapFps(settings), { focused: windowFocused, hidden: documentHidden })
  const capRef = useRef(cap)
  capRef.current = cap

  const statePills = mapStatePills(settings)
  const compactBadge = showCompactBadge(settings)
  const trash = showTrash(settings)

  useEffect(() => {
    const scene = new ArchipelagoScene(hostRef.current!)
    sceneRef.current = scene
    return () => {
      scene.destroy()
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    scene.setInput({ model, activeBoatKey, detachedIds, statePills, showCompactBadge: compactBadge, reduced: prefersReducedMotion() })
    scene.setHoleVisible(trash)
  }, [model, activeBoatKey, detachedIds, statePills, compactBadge, trash])

  const viewport = useCallback(() => {
    const r = hostRef.current?.getBoundingClientRect()
    return { width: r?.width ?? 1, height: r?.height ?? 1 }
  }, [])

  const moveCamera = useCallback((next: CameraState) => {
    camRef.current = next
    setCamera(next)
  }, [])

  const fit = useCallback(() => {
    const scene = sceneRef.current
    if (!scene) return
    const bodies = scene.fitBodies()
    if (bodies.length === 0) return
    flightRef.current = fitViewTo(() => bodies, viewport(), insets)
  }, [insets, viewport])

  // Fit once on load, after the URL has restored any selection — as the planet map does.
  useEffect(() => {
    if (fittedRef.current || !urlRestored || model.planets.length === 0) return
    const scene = sceneRef.current
    if (!scene) return
    fittedRef.current = true
    const bodies = scene.fitBodies()
    if (bodies.length) moveCamera(fitViewTo(() => bodies, viewport(), insets))
  }, [urlRestored, model, insets, viewport, moveCamera])

  // The frame loop, under the same cap as the planet map: focused and
  // background fps from settings, nothing at all while the window is hidden.
  useEffect(() => {
    let raf = 0
    let timer = 0
    let last = performance.now()
    let due = 0
    const tick = (now: number) => {
      const c = capRef.current
      if (c <= 0) {
        timer = window.setTimeout(() => (raf = requestAnimationFrame(tick)), 250)
        last = performance.now()
        return
      }
      raf = requestAnimationFrame(tick)
      if (now < due) return
      due = now + 1000 / c - 2
      const dt = (now - last) / 1000
      last = now
      const target = flightRef.current
      if (target) {
        const k = 1 - Math.exp(-dt * 6)
        const cur = camRef.current
        const z = Math.exp(Math.log(cur.zoom) + (Math.log(target.zoom) - Math.log(cur.zoom)) * k)
        const next = { x: cur.x + (target.x - cur.x) * k, y: cur.y + (target.y - cur.y) * k, zoom: z }
        const done = Math.abs(next.x - target.x) < 1e-3 && Math.abs(next.y - target.y) < 1e-3 && Math.abs(z - target.zoom) < 1e-2
        moveCamera(done || prefersReducedMotion() ? target : next)
        if (done) flightRef.current = null
      }
      sceneRef.current?.frame(dt, camRef.current, viewport())
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [moveCamera, viewport])

  const pointerWorld = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const r = hostRef.current!.getBoundingClientRect()
      return screenToWorld(camRef.current, { x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height })
    },
    []
  )

  const selectSession = useCallback(
    (id: string) => {
      const { subagentPanel, taskOutput, closeSubagent, closeTaskOutput } = useOrbital.getState()
      if (subagentPanel) closeSubagent()
      if (taskOutput) closeTaskOutput()
      void select(id)
    },
    [select]
  )

  const dropFor = useCallback(
    (id: string, at: { x: number; y: number }): DropState => {
      const hole = sceneRef.current?.holeAt()
      if (!hole) return 'none'
      const near = Math.hypot(at.x - hole.x, at.y - hole.y) < HOLE_DROP_RADIUS * bodyZoomFactor(camRef.current.zoom)
      if (!near) return 'eligible'
      const s = useOrbital.getState().sessions[id]
      return s && trashDropFor(s.source, s.status) === 'refuse' ? 'refused' : 'armed'
    },
    []
  )

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      flightRef.current = null
      const target = e.target as Element
      if (target.closest('button, [data-action]')) return
      const base = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false }
      const ship = target.closest<HTMLElement | SVGElement>('[data-ship], [data-ship-label]')
      if (ship) {
        const id = (ship as HTMLElement).dataset.ship ?? (ship as HTMLElement).dataset.shipLabel!
        gestureRef.current = { kind: 'ship', id, ...base }
        return
      }
      const island = target.closest<HTMLElement | SVGElement>('[data-island]')
      if (island) {
        const tagId = Number((island as HTMLElement).dataset.island)
        const at = sceneRef.current?.islandAt(tagId)
        const w = pointerWorld(e)
        gestureRef.current = { kind: 'island', tagId, grab: at ? { x: w.x - at.x, y: w.y - at.y } : { x: 0, y: 0 }, ...base }
        return
      }
      gestureRef.current = { kind: 'pan', lastX: e.clientX, lastY: e.clientY, ...base }
    },
    [pointerWorld]
  )

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = gestureRef.current
      if (!g || g.pointerId !== e.pointerId) return
      if (!g.moved) {
        if (Math.abs(e.clientX - g.startX) < DRAG_THRESHOLD_PX && Math.abs(e.clientY - g.startY) < DRAG_THRESHOLD_PX) return
        g.moved = true
        e.currentTarget.setPointerCapture(e.pointerId)
      }
      const scene = sceneRef.current!
      if (g.kind === 'pan') {
        moveCamera(applyPan(camRef.current, e.clientX - g.lastX, e.clientY - g.lastY))
        g.lastX = e.clientX
        g.lastY = e.clientY
      } else if (g.kind === 'ship') {
        const at = pointerWorld(e)
        scene.setDragged({ kind: 'ship', id: g.id, at })
        scene.setDrop(dropFor(g.id, at))
      } else {
        const w = pointerWorld(e)
        scene.setDragged({ kind: 'island', tagId: g.tagId, at: { x: w.x - g.grab.x, y: w.y - g.grab.y } })
      }
    },
    [moveCamera, pointerWorld, dropFor]
  )

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const g = gestureRef.current
      if (!g || g.pointerId !== e.pointerId) return
      gestureRef.current = null
      const scene = sceneRef.current!
      if (g.moved) e.currentTarget.releasePointerCapture(e.pointerId)
      if (!g.moved) {
        // A click.
        const target = e.target as Element
        if (target.closest('[data-hole]')) return revealHistory()
        const boat = target.closest<SVGElement>('[data-boat]')
        if (boat) {
          const [sessionId, subId] = boat.dataset.boat!.split(':')
          const sub = useOrbital.getState().sessions[sessionId]?.subagents.find((s) => s.id === subId)
          if (sub?.toolUseId) void openSubagent(sessionId, sub)
          return
        }
        if (g.kind === 'ship') return selectSession(g.id)
        if (g.kind === 'pan') useOrbital.setState((s) => (s.ui.selectedId ? { ui: { ...s.ui, selectedId: null } } : s))
        return
      }
      const spread = scene.spreadFactor
      if (g.kind === 'ship') {
        const at = pointerWorld(e)
        const drop = dropFor(g.id, at)
        scene.setDragged(null)
        scene.setDrop('none')
        const s = useOrbital.getState().sessions[g.id]
        if (!s) return
        if (drop === 'armed') {
          const how = trashDropFor(s.source, s.status)
          if (how === 'end') trashSession(g.id, { undo: true }).catch((err: unknown) => reportError(err, 'Failed to end the session'))
          else if (how === 'confirm') setConfirmEndId(g.id)
          return
        }
        if (drop === 'refused') return
        // Anywhere else re-homes the island to where the ship was let go.
        const tagId = useOrbital.getState().sessions[g.id] ? model.planets.find((p) => p.session.id === g.id)?.tagId : undefined
        if (tagId !== undefined) void setTagAnchor(tagId, { x: at.x / spread, y: at.y / spread })
      } else if (g.kind === 'island') {
        const w = pointerWorld(e)
        scene.setDragged(null)
        void setTagAnchor(g.tagId, { x: (w.x - g.grab.x) / spread, y: (w.y - g.grab.y) / spread })
      }
    },
    [model, pointerWorld, dropFor, openSubagent, revealHistory, selectSession, setTagAnchor, trashSession]
  )

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const button = (e.target as Element).closest<HTMLElement>('[data-action]')
      if (!button) return
      const id = button.closest<HTMLElement>('[data-ship-label]')?.dataset.shipLabel
      if (!id) return
      if (button.dataset.action === 'compact') {
        const state = useOrbital.getState()
        const session = state.sessions[id]
        if (!session || isReadOnly(session) || state.pendingDecisions[id] || session.compacting) return
        sendCompactAware(id, COMPACT_COMMAND)
      } else if (button.dataset.action === 'compact-failed') {
        useCompactionUi.getState().setReveal(id)
        selectSession(id)
      }
    },
    [selectSession]
  )

  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      flightRef.current = null
      const r = hostRef.current!.getBoundingClientRect()
      const cam = camRef.current
      moveCamera(zoomAt(cam, zoomFromWheel(cam.zoom, e.deltaY, e.deltaMode), { x: e.clientX - r.left, y: e.clientY - r.top }, { width: r.width, height: r.height }))
    },
    [moveCamera]
  )

  const zoomBy = useCallback((f: number) => {
    const base = flightRef.current ?? camRef.current
    flightRef.current = { ...base, zoom: clampZoom(base.zoom * f) }
  }, [])

  const endFromConfirm = useMemo(() => (id: string) => trashSession(id, { undo: false }), [trashSession])

  return (
    <div
      data-testid="map-surface"
      className="relative h-full w-full overflow-hidden bg-[#0a1524]"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
      onClick={handleClick}
    >
      <div ref={hostRef} className="absolute inset-0" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_45%_50%,transparent_55%,rgba(3,7,14,.55))]" />
      <MapShell
        model={model}
        camera={camera}
        onZoomIn={() => zoomBy(ZOOM_STEP)}
        onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
        onFit={fit}
        onNewSession={() => setDialog('new')}
        onErrorsClick={() => setDialog('errors')}
        confirmEndId={confirmEndId}
        onConfirmEndClose={() => setConfirmEndId(null)}
        onConfirmEnd={endFromConfirm}
      />
    </div>
  )
}
