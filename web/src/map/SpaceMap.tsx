import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { Group, OrthographicCamera } from 'three'
import {
  useOrbital,
  parsePlanetScale,
  mapStatePills,
  parseDetailPanelWidth,
  parseSidebarWidth,
  parseContextThresholds,
  resolvePanelPairWidths,
  showCompactBadge,
  showContext,
  showTrash,
  trashDropFor,
  PANEL_GUTTER_PX,
  SUBAGENT_PANEL_DEFAULT_PX,
} from '../store/store'
import { isReadOnly, sessionStateKey, type SessionStateKey } from '../lib/types'
import { stateColor, stateDot } from '../lib/stateStyle'
import { StateDot } from '../ui/StateDot'
import { reportError } from '../lib/errors'
import { EndDialog } from '../panels/EndDialog'
import { mapTopInset, useWindowChromeEnv } from '../lib/windowChrome'
import type { Subagent } from '../lib/types'
import { holeLabelSizePx, labelFontPx } from './visuals'
import { Button } from '../ui/Button'
import { shortcutLabel } from '../lib/keymap'
import { useCommand } from '../lib/commands'
import { COMPACT_COMMAND, Planet } from './Planet'
import { Moon } from './Moon'
import { Hole } from './Hole'
import { useSceneModel } from './useSceneModel'
import { FrameBudget, useMapFrame } from './FrameBudget'
import { FrameScheduler, frameCap, parseMapFps } from './frameSchedule'
import { useDocumentHidden, useWindowFocused } from '../lib/useWindowFocused'
import type { SceneLabel } from './sceneModel'
import { LABEL_MARGIN } from './layout'
import {
  HOLE_DROP_RADIUS,
  createSimulation,
  dragSimBody,
  holeDropState,
  planetOutline,
  settledCopy,
  rehomeTarget,
  reconcileSimulation,
  settleSimulation,
  simulationAwake,
  stepSimulation,
  type SimBody,
  type SimInput,
  type SimState,
} from './simulation'
import {
  BODY_MOVE_MS,
  advancePointTween,
  advanceTween,
  createPointTween,
  createTween,
  prefersReducedMotion,
  retargetPointTween,
  retargetTween,
} from './transition'
import {
  applyPan,
  bodyZoomFactor,
  centerOn,
  clampZoom,
  fitViewTo,
  screenToWorld,
  zoomAt,
  zoomFromWheel,
  type CameraState,
  type FitBody,
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
/**
 * How long one press of the +/- buttons takes to arrive. Not a canvas value
 * (the export draws no zoom animation): it is the duration the map's own
 * chrome already moves on — the overlay transition beside the zoom stack —
 * whose curve is `easeMotion`. Deliberately shorter than `BODY_MOVE_MS`:
 * this is a button pressed four times in a row, not a body walking to a new
 * home.
 */
const ZOOM_STEP_MS = 420
/**
 * How long the fit flight takes. Longer than one zoom step and matched to
 * `BODY_MOVE_MS` instead, for the same reason that constant is what it is:
 * this move crosses the whole map, and the eye has to be able to follow
 * where the view went. Unlike a zoom step it is not a button anyone presses
 * four times in a row — pressing fit again lands on the same frame.
 */
const FIT_FLIGHT_MS = BODY_MOVE_MS
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
 * Map width the panels sit on, in CSS pixels — what `centerOn` and `fitView`
 * keep the sessions clear of. Both panels are live now (drag handles,
 * `detail_panel_width` / `sidebar_width`): the detail panel adds its
 * `PANEL_GUTTER_PX` edge inset (1b), and the sidebar its own 16px inset plus
 * a 24px gutter, which is where the collapsed rail's 96px (16 + 56 + 24)
 * comes from too (1a).
 *
 * With the subagent panel open too, `PANEL_GUTTER_PX` does double duty as
 * the gutter BETWEEN the two right-hand panels — "the 16px gutter is the
 * same as every other gutter" (Feature - Subagent panel 11b/11d) — so the
 * right inset below adds it a second time. Imported from `store.ts` (fix
 * round 1) rather than re-declared locally: `resolvePanelPairWidths` now
 * folds this same 16px into its own 75% ceiling check, and a private copy
 * here that ever drifted from that one would make the ceiling a statement
 * about a number the screen does not actually draw.
 */
const SIDEBAR_GUTTER_PX = 40
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

  // Never moving by itself: every camera change is a `setCamera`, and the
  // render that brings it here asks for a frame (`FrameBudget`).
  useMapFrame(() => {
    camera.position.x = camState.x
    camera.position.y = camState.y
    const ortho = camera as unknown as OrthographicCamera
    if (ortho.zoom !== camState.zoom) {
      ortho.zoom = camState.zoom
      ortho.updateProjectionMatrix()
    }
    return false
  })

  return null
}

/**
 * A cluster's label, tracking the clump per frame: anchored above the
 * topmost body of its tag that stays (not one fading off the map, `leaving`),
 * read straight off the simulation the same way the planets read their own
 * positions. Measured from the top of the body's drawn box (`extent`), so
 * the label clears a reticle or a pill rather than the bare planet. Falls
 * back to the scene model's anchor when the sim has no bodies for the tag
 * yet (first frame).
 *
 * `Html` reprojects from its parent's world matrix every frame, so writing
 * the wrapping group's position is all it takes.
 */
function ClusterLabel({
  label,
  simRef,
  leaving,
}: {
  label: SceneLabel
  simRef: RefObject<SimState>
  leaving: ReadonlySet<string>
}) {
  const groupRef = useRef<Group>(null)

  // Moves only with the bodies, whose motion `SimStepper` already reports.
  useMapFrame(() => {
    if (!groupRef.current) return false
    let top: SimBody | null = null
    for (const body of simRef.current.bodies.values()) {
      if (body.tagId !== label.tagId || leaving.has(body.id)) continue
      if (!top || body.y + body.extent.top > top.y + top.extent.top) top = body
    }
    if (top) groupRef.current.position.set(top.x, top.y + top.extent.top + LABEL_MARGIN, 0)
    else groupRef.current.position.set(label.x, label.y, 0)
    return false
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

/** The trash's ring flash when a drop ends a session (canvas 4a script: `this.flash = 0.45`). */
const TRASH_FLASH_SEC = 0.45

/**
 * Steps the spring simulation once per frame, ahead of every planet's own
 * frame callback (negative priority). Under reduced motion the sim was
 * already settled synchronously at reconcile time, so there is nothing to
 * animate here.
 *
 * Steps even when every body sleeps, so a reconcile that changed a home
 * without waking anyone still wakes the bodies it pulls on; reports motion
 * only while something is awake.
 */
function SimStepper({ simRef, reduced }: { simRef: RefObject<SimState>; reduced: boolean }) {
  useMapFrame((_, delta) => {
    if (reduced) return false
    // No camera zoom: the springs measure every outline at OUTLINE_ZOOM,
    // so zooming never moves anything.
    stepSimulation(simRef.current, delta)
    return simulationAwake(simRef.current)
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
 * Eases camera zoom by a step, for the +/- buttons — the same
 * `requestAnimationFrame` into `setCamera` shape as `usePanTo`, and for the
 * same reason: the zoom is what the HUD readout and every following gesture
 * are computed from, so it has to actually BE there when the run ends, not
 * merely look like it.
 *
 * Interpolated in LOG space, because zoom is multiplicative — `zoomFromWheel`
 * already treats it that way. A linear ramp from 20 to 40 doubles the map in
 * the first half of the run and adds a third in the second; a log ramp covers
 * the same proportion of the change in every frame, which is what reads as
 * one smooth move.
 *
 * `cancel` is the same contract as `usePanTo`'s: any pointer or wheel gesture
 * abandons the run where it stands rather than fighting the hand on the map.
 */
function useZoomTo(setCamera: (next: (cam: CameraState) => CameraState) => void) {
  const tween = useRef(createTween(Math.log(INITIAL_CAMERA.zoom), ZOOM_STEP_MS))
  /** Where the run in flight is HEADED — what a second press builds on. */
  const target = useRef(INITIAL_CAMERA.zoom)
  const frame = useRef(0)
  const lastMs = useRef(0)

  const cancel = useCallback(() => {
    if (frame.current !== 0) cancelAnimationFrame(frame.current)
    frame.current = 0
    tween.current.active = false
  }, [])

  useEffect(() => cancel, [cancel])

  const zoomBy = useCallback(
    (delta: number, from: number) => {
      // A second press while the first is still running extends it instead of
      // restarting from where the animation currently stands — otherwise
      // tapping + repeatedly would crawl, each press re-aiming at a target
      // only one step past the middle of the last run.
      const running = frame.current !== 0
      if (!running) {
        tween.current.value = Math.log(from)
        tween.current.to = tween.current.value
        target.current = from
      }
      const to = clampZoom(target.current + delta)
      if (to === target.current) return
      target.current = to
      retargetTween(tween.current, Math.log(to), ZOOM_STEP_MS, prefersReducedMotion())
      if (running) return

      const step = (nowMs: number) => {
        const delta = (nowMs - lastMs.current) / 1000
        lastMs.current = nowMs
        advanceTween(tween.current, delta)
        // Exactly the target once the run is over: exp(log(x)) is only
        // x to within a rounding error, and the HUD reads this number.
        const zoom = tween.current.active ? Math.exp(tween.current.value) : target.current
        // Functional update, so a pan that lands mid-zoom keeps its position.
        setCamera((cam) => ({ ...cam, zoom }))
        frame.current = tween.current.active ? requestAnimationFrame(step) : 0
      }

      lastMs.current = performance.now()
      frame.current = requestAnimationFrame(step)
    },
    [setCamera]
  )

  return { zoomBy, cancel }
}

/**
 * Flies the camera to a complete state — position AND zoom together — for
 * fit, which is the only control that sets all three at once.
 *
 * It used to just `setCamera` the fitted state, and the jump was the problem:
 * fit reframes the whole map, so the cut gives no clue whether the view moved
 * left or zoomed out, and the planets you were looking at have to be found
 * again from scratch. Flown, the same reframe shows its own direction.
 *
 * Same `requestAnimationFrame` into `setCamera` shape as `usePanTo` and
 * `useZoomTo`, for the same reason (the HUD readout and every following
 * gesture read this state, so the camera must actually BE there when the run
 * ends), and zoom is interpolated in LOG space for the same reason too: it is
 * multiplicative, and a linear ramp spends most of the run barely moving.
 * Both axes and the zoom share one duration and curve, so the flight reads as
 * a single move rather than a pan racing a zoom.
 *
 * `cancel` is the same contract as the other two: a hand on the map abandons
 * the flight where it stands.
 */
function useFlyTo(setCamera: (next: CameraState) => void) {
  const pos = useRef(createPointTween(0, 0, FIT_FLIGHT_MS))
  const zoom = useRef(createTween(Math.log(INITIAL_CAMERA.zoom), FIT_FLIGHT_MS))
  /** Where the flight is headed — the exact state it has to land on. */
  const target = useRef<CameraState>(INITIAL_CAMERA)
  const frame = useRef(0)
  const lastMs = useRef(0)

  const cancel = useCallback(() => {
    if (frame.current !== 0) cancelAnimationFrame(frame.current)
    frame.current = 0
    pos.current.x.active = false
    pos.current.y.active = false
    zoom.current.active = false
  }, [])

  useEffect(() => cancel, [cancel])

  const flyTo = useCallback(
    (from: CameraState, to: CameraState) => {
      cancel()
      target.current = to
      const pt = pos.current
      const zt = zoom.current
      // Seed every tween at the live camera, both ends: `retarget*` reads
      // `to` to decide whether there is anything to do, so a flight back to
      // a state this hook flew to before would otherwise be a no-op.
      pt.x.value = from.x
      pt.x.to = from.x
      pt.y.value = from.y
      pt.y.to = from.y
      zt.value = Math.log(from.zoom)
      zt.to = zt.value
      const reduced = prefersReducedMotion()
      retargetPointTween(pt, to.x, to.y, reduced)
      retargetTween(zt, Math.log(to.zoom), FIT_FLIGHT_MS, reduced)
      // Already there on every axis — nothing to animate, but the camera
      // still has to be exactly the fitted state.
      if (!pt.x.active && !pt.y.active && !zt.active) {
        setCamera(to)
        return
      }

      const step = (nowMs: number) => {
        // Seeded from the first FRAME's own timestamp, not from
        // `performance.now()` at launch: the two share an origin in a browser
        // but are not required to, and where they don't (jsdom) a launch-time
        // seed makes the first delta wildly negative and the flight stalls.
        const delta = lastMs.current === 0 ? 0 : (nowMs - lastMs.current) / 1000
        lastMs.current = nowMs
        advancePointTween(pt, delta)
        advanceTween(zt, delta)
        const running = pt.x.active || pt.y.active || zt.active
        // Exactly the target once the run is over: exp(log(x)) is only x to
        // within a rounding error, and the HUD reads this number.
        setCamera(
          running
            ? { x: pt.x.value, y: pt.y.value, zoom: Math.exp(zt.value) }
            : target.current
        )
        frame.current = running ? requestAnimationFrame(step) : 0
      }

      lastMs.current = 0
      frame.current = requestAnimationFrame(step)
    },
    [cancel, setCamera]
  )

  return { flyTo, cancel }
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

export function SpaceMap() {
  const model = useSceneModel()
  const select = useOrbital((s) => s.select)
  const setDialog = useOrbital((s) => s.setDialog)
  const openSubagent = useOrbital((s) => s.openSubagent)
  // A primitive, not the `subagentPanel` object itself: that object grows a
  // new `messages` array on every live WS append, and subscribing to it
  // directly here would re-render the whole map (every planet AND moon) on
  // every subagent transcript line. `activePanelKey` only changes when
  // WHICH agent is open changes, which is the one thing a moon's `active`
  // treatment (canvas 11e) actually needs to know.
  const activePanelKey = useOrbital((s) =>
    s.subagentPanel ? `${s.subagentPanel.sessionId}:${s.subagentPanel.subagent.id}` : null
  )
  // Appearance → default planet size (canvas 5a). Premultiplied into each
  // planet's `scale` prop at the call site below, so `sceneModel`/`layout`
  // never see it — orbit radii and cluster spacing stay put by design.
  const planetScale = useOrbital((s) => parsePlanetScale(s.settings))
  const scaleLabels = useOrbital((s) => s.settings.map_scale_labels === 'true')
  const labelFont = labelFontPx(planetScale, scaleLabels)
  // Appearance → MAP → state on the map (ADR state-labels-are-dots-first-on-the-map).
  // Read by the pills AND by the outlines below, so switching it respaces
  // the map live around the pills it now draws.
  const pillMode = useOrbital((s) => mapStatePills(s.settings))
  // Context arc settings (spec `context-fill-arc`). The fill itself is
  // already settings-gated in the scene model; these two are what only the
  // drawing needs — where the threshold marks sit, and whether the
  // `/compact` pill may show at all.
  //
  // Selected as the whole `settings` object and parsed in a `useMemo`, NOT
  // as `useOrbital((s) => parseContextThresholds(s.settings))`: that
  // selector would allocate a fresh object on every call and never settle —
  // the same trap `useSceneModel` documents at length.
  const settings = useOrbital((s) => s.settings)
  const contextThresholds = useMemo(() => parseContextThresholds(settings), [settings])
  const compactBadgeAllowed = showContext(settings) && showCompactBadge(settings)

  // Frame budget (spec 2026-09-24-map-frame-budget-design): the canvas draws
  // only while something moves, capped by the focused or background rate,
  // and not at all while the window is hidden. Created once; the settings
  // and the window state only move its cap.
  const [scheduler] = useState(
    () =>
      new FrameScheduler({
        now: () => performance.now(),
        requestFrame: (tick) => requestAnimationFrame(tick),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
      })
  )
  useEffect(() => () => scheduler.dispose(), [scheduler])
  const windowFocused = useWindowFocused(true)
  const documentHidden = useDocumentHidden()
  const mapFps = useMemo(() => parseMapFps(settings), [settings])
  const cap = frameCap(mapFps, { focused: windowFocused, hidden: documentHidden })
  useEffect(() => scheduler.setCap(cap), [scheduler, cap])
  // Coming back to the window gets a frame even when the cap did not change
  // (both rates equal): whatever changed while nobody looked is drawn now.
  useEffect(() => {
    if (windowFocused && !documentHidden) scheduler.request()
  }, [scheduler, windowFocused, documentHidden])
  const sendPrompt = useOrbital((s) => s.sendPrompt)
  // Live panel width for the follow inset and the right-anchored overlays —
  // the drag handle moves it, and while it is held (`resizingPanel`) the
  // overlays drop their transition so they track the pointer with the panel.
  //
  // `rawDetailPanelWidth` is the single-panel-clamped nominal width, exactly
  // as it always was. With the subagent panel open, `resolvePanelPairWidths`
  // (task 8: spec § 8 "Layout") resolves what each panel is ACTUALLY drawn
  // at once the 75% pair ceiling has had its say — `detailPanelWidth` below
  // is that resolved value, unchanged from `rawDetailPanelWidth` whenever
  // the subagent panel is closed (requirement 1: the single-panel case does
  // not regress).
  const rawDetailPanelWidth = useOrbital((s) => parseDetailPanelWidth(s.settings, window.innerWidth))
  const subagentPanelOpen = useOrbital((s) => s.subagentPanel !== null)
  const pairWidths = useMemo(
    () =>
      subagentPanelOpen
        ? resolvePanelPairWidths(rawDetailPanelWidth, SUBAGENT_PANEL_DEFAULT_PX, window.innerWidth)
        : { detailWidthPx: rawDetailPanelWidth, subagentWidthPx: 0 },
    [subagentPanelOpen, rawDetailPanelWidth]
  )
  const detailPanelWidth = pairWidths.detailWidthPx
  const sidebarWidth = useOrbital((s) => parseSidebarWidth(s.settings, window.innerWidth))
  const resizingPanel = useOrbital((s) => s.ui.resizingPanel ?? false)
  const selectedId = useOrbital((s) => s.ui.selectedId)
  // Replaced wholesale by every push from main, so the reference is stable
  // between pushes and needs no shallow compare.
  const detachedIds = useOrbital((s) => s.detachedIds)
  const sidebarCollapsed = useOrbital((s) => s.ui.sidebarCollapsed)
  const errorsUnseen = useOrbital((s) => s.errorsUnseen)
  const errorLogOpen = useOrbital((s) => s.ui.dialog === 'errors')
  // How much of the right edge the docked panel(s) occupy, detail panel
  // width plus its 16px gutter — and, with the subagent panel open, ITS
  // width plus a second 16px gutter on top of that (the same constant
  // reused as the inter-panel gutter, per the canvas note above). Zero when
  // the subagent panel is closed, so this is a no-op in the regression
  // case.
  const rightPanelsChromePx =
    detailPanelWidth +
    PANEL_GUTTER_PX +
    (subagentPanelOpen ? pairWidths.subagentWidthPx + PANEL_GUTTER_PX : 0)
  // 24px clear of the open panel(s) and their edge inset; the export's own
  // edge inset (right:24px) when nothing is selected. No transition while
  // the drag handle is held — the overlays track the pointer with the
  // panel.
  const overlayRightPx = selectedId ? rightPanelsChromePx + 24 : 24
  // Screen-space chrome the camera helpers keep the sessions clear of. Both
  // sides are live, and the right side only counts when a panel is actually
  // open — nothing is selected, nothing is covering that edge. The top is the
  // desktop window's drag band, which takes clicks meant for the map (canvas
  // `Feature - Main window chrome` 24a); gone in full screen and the browser.
  const windowChrome = useWindowChromeEnv()
  const topInset = mapTopInset(windowChrome)
  const mapInsets = useMemo(
    () => ({
      left: sidebarCollapsed ? SIDEBAR_COLLAPSED_PX : sidebarWidth + SIDEBAR_GUTTER_PX,
      right: selectedId ? rightPanelsChromePx : 0,
      top: topInset,
    }),
    [sidebarCollapsed, sidebarWidth, selectedId, rightPanelsChromePx, topInset]
  )
  const overlayTransition = resizingPanel
    ? ''
    : 'transition-[right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]'
  const overlayLeftTransition = resizingPanel
    ? ''
    : 'transition-[left] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]'
  const trashSession = useOrbital((s) => s.trashSession)
  const setTagAnchor = useOrbital((s) => s.setTagAnchor)
  const revealHistory = useOrbital((s) => s.revealHistory)
  // Appearance → Show trash (spec 2026-09-24-sessions-end-only-by-hand-design
  // § 3). Off: no trash drawn, no halo in the physics, no drop-to-end.
  const trashShown = showTrash(settings)
  /** The session a drop on the trash wants to end mid-turn — its End dialog is open. */
  const [confirmEndId, setConfirmEndId] = useState<string | null>(null)
  const closeConfirmEnd = useCallback(() => setConfirmEndId(null), [])
  const endFromConfirm = useCallback(
    (id: string) => trashSession(id, { undo: false }),
    [trashSession]
  )
  const leavingIds = useMemo(
    () => new Set(model.planets.filter((p) => p.leaving).map((p) => p.session.id)),
    [model]
  )

  // --- Spring simulation (spec 2026-09-18-tag-clusters-design § 1-2) --------
  // The sim state lives in a ref and is reconciled against every fresh scene
  // model DURING render (deliberately — bodies must exist before the planets
  // that read them render; the reconcile is idempotent, so StrictMode's
  // double-render is harmless). Motion happens in <SimStepper>'s frame loop;
  // under reduced motion the sim is settled synchronously instead and
  // renders statically.
  const [camera, setCamera] = useState<CameraState>(INITIAL_CAMERA)
  /** Read by the follow effect, which needs where the camera IS without re-running whenever it moves. */
  const cameraRef = useRef(camera)
  cameraRef.current = camera
  const simRef = useRef<SimState>(null as unknown as SimState)
  if (simRef.current === null) simRef.current = createSimulation()
  const holeFlashRef = useRef(0)
  const reduced = prefersReducedMotion()
  // The reconciled simulation IS the memo's value — it lives in a ref so the
  // frame loop can mutate it without a render, and returning it here is what
  // keeps this a memo rather than a side effect hiding in one.
  const sim = useMemo(() => {
    const font = labelFontPx(planetScale, scaleLabels)
    const input: SimInput = {
      bodies: model.planets.map((p) => ({
        id: p.session.id,
        tagId: p.tagId,
        x: p.x,
        y: p.y,
        r: p.footprint,
        // What the planet draws around itself, sized by the same Appearance
        // settings `Planet` is drawn with below, so the springs keep
        // neighbours clear of the actual label and pill.
        outline: planetOutline({ ...p, gauged: p.contextFill !== null }, planetScale, font, pillMode),
        trash: trashDropFor(p.session.source, p.session.status),
      })),
      anchors: model.anchors.map(({ tagId, x, y }) => ({ tagId, x, y })),
      // The label column too, so resting bodies are kept off it as well as
      // out of the round halo. None at all while the trash is hidden.
      hole: trashShown
        ? { x: model.hole.x, y: model.hole.y, label: holeLabelSizePx(model.hole.count) }
        : null,
    }
    reconcileSimulation(simRef.current, input)
    if (reduced) settleSimulation(simRef.current)
    return simRef.current
  }, [model, reduced, planetScale, scaleLabels, pillMode, trashShown])

  const { panTo, cancel: cancelPan } = usePanTo(setCamera)
  const { zoomBy, cancel: cancelZoom } = useZoomTo(setCamera)
  const { flyTo, cancel: cancelFly } = useFlyTo(setCamera)
  /** A hand on the map — or any camera move of its own — outranks every run in flight. */
  const cancelCameraMotion = useCallback(() => {
    cancelPan()
    cancelZoom()
    cancelFly()
  }, [cancelPan, cancelZoom, cancelFly])
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
  // The dot-mode pill's click. No drag guard: the disc keeps its presses from
  // the map, so no pan can have started on it, and `draggedRef` would only
  // hold whatever the previous gesture left there.
  const handlePillSelect = useCallback((id: string) => void select(id), [select])

  // The moon's own click (task 9, spec § 5 "The moon"). `Moon` never imports
  // the store — this is the same "plain callback prop" shape as `onClick`
  // above, just handed `openSubagent` instead of `select`. It does NOT also
  // call `select` here: `openSubagent` selects the parent session itself, so
  // the two ways in (a moon and the parent transcript's `OPEN →` row) cannot
  // drift apart on which of them remembered to.
  const handleOpenSubagent = useCallback(
    (sessionId: string, subagent: Subagent) => {
      void openSubagent(sessionId, subagent)
    },
    [openSubagent]
  )

  /**
   * Click on empty space deselects. R3F's `onPointerMissed` fires only for a
   * click that intersected no object, so a planet click never reaches it — a
   * DOM `click` handler on the container would, because `Planet`'s
   * `stopPropagation` stops propagation among R3F objects while the native
   * event still bubbles, and it would deselect the planet it had just
   * selected. The `draggedRef` guard keeps a pan released over empty space
   * from clearing the selection.
   */
  const handlePointerMissed = useCallback((e: MouseEvent) => {
    if (e.button !== 0) return
    if (draggedRef.current) return
    useOrbital.setState((s) => (s.ui.selectedId ? { ui: { ...s.ui, selectedId: null } } : s))
  }, [])

  /**
   * The `/compact` pill's click: the same path the composer sends a message
   * on (`sendPrompt`), under the same availability rules — a session live in
   * a terminal is read-only here (the server's 409 is the real backstop),
   * and a session sitting on an open question would have the text swallowed
   * as the ANSWER to it, which is not what a click on this pill means. In
   * either case the click does nothing rather than throwing; `sendPrompt`
   * itself reports any failure past that point as a toast.
   */
  const handleCompact = useCallback(
    (id: string) => {
      const state = useOrbital.getState()
      const session = state.sessions[id]
      if (!session || isReadOnly(session)) return
      if (state.pendingDecisions[id]) return
      void sendPrompt(id, COMPACT_COMMAND)
    },
    [sendPrompt]
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
      cancelCameraMotion()
      draggedRef.current = false
      // The three.js pointer-down on a planet ran first (the canvas is a
      // child of this container): that pointer is dragging a BODY, so the
      // map must not also pan under it.
      if (bodyDragRef.current?.pointerId === e.pointerId) return
      dragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY, captured: false }
    },
    [cancelCameraMotion]
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
        // The sim moves under the pointer without a render to ask for it.
        scheduler.request()
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
    [pointerToWorld, reduced, scheduler]
  )

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const bodyDrag = bodyDragRef.current
      if (bodyDrag && bodyDrag.pointerId === e.pointerId) {
        bodyDragRef.current = null
        if (bodyDrag.engaged) {
          e.currentTarget.releasePointerCapture(e.pointerId)
          const sim = simRef.current
          // Letting go inside the trash's halo (`armed`) does what
          // `trashDropFor` says: an Orbital session with nothing in flight
          // ends at once, with the undo toast; one mid-turn opens the End
          // dialog first and springs back meanwhile. A terminal session's
          // body (`refused`) just springs back. The same predicate drives the
          // trash's drop-target signal, so what it promises on release is
          // exactly what happens. Any other drop re-homes the clump: the
          // tag's anchor moves to the release point (persisted), so the
          // dragged body stays put and its mates fly to it — except near the
          // trash, where `rehomeTarget` declines and the clump drifts back to
          // its old home. Both read BEFORE dragSimBody(null): they require an
          // active drag.
          const factor = bodyZoomFactor(cameraRef.current.zoom)
          const drop = holeDropState(sim, bodyDrag.id, factor)
          const rehome = rehomeTarget(sim, bodyDrag.id, factor)
          const trash = sim.bodies.get(bodyDrag.id)?.trash
          dragSimBody(sim, bodyDrag.id, null)
          if (drop === 'armed' && trash === 'end') {
            holeFlashRef.current = TRASH_FLASH_SEC
            trashSession(bodyDrag.id, { undo: true }).catch((err: unknown) =>
              reportError(err, 'Failed to end the session')
            )
          } else if (drop === 'armed' && trash === 'confirm') setConfirmEndId(bodyDrag.id)
          else if (rehome) void setTagAnchor(rehome.tagId, { x: rehome.x, y: rehome.y })
          if (reduced) settleSimulation(simRef.current)
          scheduler.request()
        }
        return
      }

      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      if (drag.captured) e.currentTarget.releasePointerCapture(e.pointerId)
      dragRef.current = null
    },
    [reduced, trashSession, setTagAnchor, scheduler]
  )

  const handleWheel = useCallback(
    (e: ReactWheelEvent<HTMLDivElement>) => {
      cancelCameraMotion()
      // Read the geometry out here, not inside the updater: React may run the
      // updater after the event has been handed back, when `currentTarget` is
      // already null.
      const rect = e.currentTarget.getBoundingClientRect()
      const pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      const viewport = { width: rect.width, height: rect.height }
      setCamera((cam) => zoomAt(cam, zoomFromWheel(cam.zoom, e.deltaY, e.deltaMode), pointer, viewport))
    },
    [cancelCameraMotion]
  )

  // Only the pan is cancelled here: the zoom run is the one being extended.
  const zoomIn = useCallback(() => {
    cancelPan()
    zoomBy(ZOOM_STEP, cameraRef.current.zoom)
  }, [cancelPan, zoomBy])
  const zoomOut = useCallback(() => {
    cancelPan()
    zoomBy(-ZOOM_STEP, cameraRef.current.zoom)
  }, [cancelPan, zoomBy])

  /**
   * The camera that frames the whole map right now.
   *
   * Frames what each body DRAWS, not just its centre (a planet's
   * `bodyExtent` — moons, label and pill — and the hole's halo): a fit that
   * frames centres leaves whatever is drawn around the outermost ones
   * hanging over the edge, which on the hole is most of it.
   */
  const fitCamera = useCallback(() => {
    // Planets are framed where the simulation will rest them (`settledCopy`):
    // fit runs on the first frame, before the clumps have walked out of
    // their spiral seeds. The layout does not follow the camera (outlines
    // are measured at OUTLINE_ZOOM), so one settled copy serves every zoom
    // the solve tries; only the trash's counter-zoomed halo changes with it.
    // The trash is part of the map when it is shown — fit frames it with the
    // planets, so the history landmark is never fitted out of view.
    const planets: FitBody[] = []
    for (const body of settledCopy(sim).bodies.values()) {
      if (leavingIds.has(body.id)) continue
      // A planet's box enters as its two opposite corners.
      const { left, right, bottom, top } = body.extent
      planets.push({ x: body.x + left, y: body.y + bottom }, { x: body.x + right, y: body.y + top })
    }
    const bodiesAt = (zoom: number): FitBody[] =>
      trashShown
        ? [{ x: model.hole.x, y: model.hole.y, r: HOLE_DROP_RADIUS * bodyZoomFactor(zoom) }, ...planets]
        : planets
    const rect = containerRef.current?.getBoundingClientRect()
    const viewport = {
      width: rect?.width ?? window.innerWidth,
      height: rect?.height ?? window.innerHeight,
    }
    // Fit into the strip the panels leave, not the raw viewport: "show me
    // everything" that parks half the sessions under the sidebar or the
    // detail panel has not shown them.
    return fitViewTo(bodiesAt, viewport, mapInsets)
  }, [sim, model.hole.x, model.hole.y, mapInsets, leavingIds, trashShown])

  const handleFit = useCallback(() => {
    cancelCameraMotion()
    flyTo(cameraRef.current, fitCamera())
  }, [cancelCameraMotion, flyTo, fitCamera])

  /**
   * Fit once per page load, on the first frame that has both sessions to
   * frame and a settled `?session=` restore. A reload used to land on the
   * fixed default camera (origin, zoom 60), which on a map that has grown
   * past that frame means opening to empty space and hunting for your own
   * sessions.
   *
   * Waiting on `urlRestored` is what makes the insets right: the deep link's
   * detail panel opens an effect or two after the sessions land, so fitting
   * the moment planets exist would frame the full viewport and then let that
   * panel open over the result — the very thing fit insets exist to prevent.
   *
   * Deliberately once, not on every layout change: the camera is the user's
   * after they have touched it, and a map that re-fits itself under a moving
   * hand is worse than one that does nothing.
   *
   * Set, not flown (unlike the control): a flight shows where a view MOVED
   * from, and on load there is no view to have moved from — the default
   * camera is an implementation detail nobody has looked at yet, and flying
   * out of it would only advertise it.
   */
  const urlRestored = useOrbital((s) => s.ui.urlRestored ?? false)
  const fittedOnLoad = useRef(false)
  useEffect(() => {
    if (fittedOnLoad.current || !urlRestored || model.planets.length === 0) return
    fittedOnLoad.current = true
    setCamera(fitCamera())
  }, [urlRestored, model.planets.length, fitCamera])

  useCommand('map.fit', handleFit)

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
  const followed = model.planets.find((p) => p.selected && !p.leaving)
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

    // A fit still in flight is abandoned rather than raced: both runs write
    // the whole camera every frame, and the newer intent wins.
    cancelFly()
    const cam = cameraRef.current
    // Both panel widths are live — a dragged-wider panel must keep the
    // followed planet clear of it.
    const target = centerOn(cam, { x: followedX, y: followedY }, mapInsets)
    panTo({ x: cam.x, y: cam.y }, { x: target.x, y: target.y })
  }, [followedId, followedX, followedY, panTo, cancelFly, mapInsets])

  const zoomPercent = Math.round(camera.zoom)
  const camX = Math.round(camera.x)
  const camY = Math.round(camera.y)

  /**
   * The aggregate readout. ENDED is plain text again: the 2a/2b suppression
   * toggle is gone — an ended session leaves the map on its own unless it is
   * pinned (spec 2026-09-24-sessions-end-only-by-hand-design § 3), so the
   * ENDED count is the pinned ones and those still fading out.
   *
   * Each `N WORD` segment wears its state colour, count and word as one token
   * (canvas 24b); NEEDS INPUT carries its breathing dot here too. WAITING
   * sessions stay counted in WORKING — they are still working, through their
   * moons, so the line does not grow a sixth word.
   */
  const aggregateSegments = useMemo(() => {
    const { working, needs_input: needsInput, idle, ended } = model.counts
    // The `needs_input` column splits the same way the pills do
    // (`sessionStateKey`): only the planets with a question parked on them
    // are NEEDS INPUT, an interrupted one says INTERRUPTED, the rest merely
    // finished. Counted off the drawn planets rather than `model.counts`,
    // which knows the status and not the reason — a line reading "3 NEEDS
    // INPUT" over three planets all saying DONE is the very mismatch the
    // pills were fixed to stop telling.
    // Muted planets are left out, as `statusCounts` leaves them out: the
    // readout counts what matches the sidebar filters, not what holds its place.
    let asking = 0
    let interrupted = 0
    for (const p of model.planets) {
      if (p.muted || p.session.status !== 'needs_input') continue
      const key = sessionStateKey(p.session)
      if (key === 'needs_input') asking++
      else if (key === 'interrupted') interrupted++
    }
    const done = needsInput - asking - interrupted
    const segments: Array<{ key: SessionStateKey; text: string }> = [
      { key: 'working', text: `${working} WORKING` },
      ...(asking > 0 ? [{ key: 'needs_input' as const, text: `${asking} NEEDS INPUT` }] : []),
      ...(interrupted > 0 ? [{ key: 'interrupted' as const, text: `${interrupted} INTERRUPTED` }] : []),
      ...(done > 0 ? [{ key: 'done' as const, text: `${done} DONE` }] : []),
      { key: 'idle', text: `${idle} IDLE` },
      { key: 'ended', text: `${ended} ENDED` },
    ]
    return segments
  }, [model.counts, model.planets])

  return (
    <div
      ref={containerRef}
      data-testid="map-surface"
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
          space, and the oklch → linear-sRGB path is already correct.
          `demand`: the canvas draws only when `FrameBudget` or a prop change
          asks for a frame. */}
      <Canvas
        flat
        orthographic
        frameloop="demand"
        camera={{ zoom: INITIAL_CAMERA.zoom, position: [0, 0, 100] }}
        onPointerMissed={handlePointerMissed}
      >
        <FrameBudget scheduler={scheduler}>
          <CameraRig camera={camera} />
          <SimStepper simRef={simRef} reduced={reduced} />
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
              hidden={planet.leaving}
              muted={planet.muted}
              modelFamily={planet.modelFamily}
              labelTitlePx={labelFont.title}
              labelFamilyPx={labelFont.family}
              contextFill={planet.contextFill}
              contextThresholds={contextThresholds}
              showCompactBadge={compactBadgeAllowed}
              onCompact={handleCompact}
              onClick={handleSelect}
              statePills={pillMode}
              onPillClick={handlePillSelect}
              detached={detachedIds.includes(planet.session.id)}
              simBody={sim.bodies.get(planet.session.id)}
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
              parentBody={sim.bodies.get(moon.sessionId)}
              sessionId={moon.sessionId}
              active={`${moon.sessionId}:${moon.subagent.id}` === activePanelKey}
              onOpen={handleOpenSubagent}
              muted={moon.muted}
            />
          ))}

          {model.labels.map((label) => (
            <ClusterLabel key={label.tagId} label={label} simRef={simRef} leaving={leavingIds} />
          ))}

          {trashShown && (
            <Hole
              hole={model.hole}
              flashRef={holeFlashRef}
              simRef={simRef}
              dragRef={bodyDragRef}
              onOpen={handleHoleOpen}
            />
          )}
        </FrameBudget>
      </Canvas>

      {/* A drop on the trash of a session mid-turn asks first (spec
          2026-09-24-sessions-end-only-by-hand-design § 3): the header's own
          End dialog, aimed at the dropped session rather than the selected
          one, and ending it the trash's way — its pin goes with it. */}
      <EndDialog
        open={confirmEndId !== null}
        sessionId={confirmEndId}
        onClose={closeConfirmEnd}
        onEnd={endFromConfirm}
      />

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
            {aggregateSegments.map(({ key, text }, i) => {
              const color = stateColor(key)
              return (
                <Fragment key={key}>
                  {/* 24b: the separators stay muted, at .28. */}
                  {i > 0 && <span className="text-[rgba(160,190,225,.28)]">·</span>}
                  <span data-state={key} className="flex items-center gap-[5px]" style={{ color }}>
                    <StateDot dot={stateDot(key, 'label')} color={color} solidPx={5} hollowPx={6} />
                    {text}
                  </span>
                </Fragment>
              )
            })}
          </div>
        </div>

        {/* The camera readout tracks the sidebar rather than the viewport
            edge: the export animates `left` between the expanded width and
            96px (collapsed) on the same 420ms curve as the panel width. The
            expanded value is live now, so it is inline rather than a class,
            and it drops the transition mid-drag like the right-hand overlays. */}
        <div
          data-overlay="camera-readout"
          style={{ left: mapInsets.left }}
          className={[
            'pointer-events-none absolute bottom-6 font-mono text-[10.5px] tracking-[0.08em] text-text-muted/70',
            overlayLeftTransition,
          ]
            .filter(Boolean)
            .join(' ')}
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
            title={`Error log · ${shortcutLabel('global.errors')}`}
            onClick={() => setDialog('errors')}
            className={[
              'relative grid h-[34px] w-[34px] place-items-center rounded-[9px] border bg-[rgba(10,14,24,.92)] text-base font-bold leading-none transition-colors',
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

          <div className="flex flex-col overflow-hidden rounded-[9px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,14,24,.92)]">
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
              title={`Fit view · ${shortcutLabel('map.fit')}`}
              onClick={handleFit}
              className="grid h-[34px] w-[34px] place-items-center text-sm text-text-bright hover:bg-white/5"
            >
              ⌖
            </button>
          </div>
        </div>

        {/* Centred on the visible strip of map — between the sidebar and the
            open right-hand panels — not on the whole container, whose centre
            lands under the zoom column once the panels are wide. The wrapper
            spans the strip and lets clicks through to the map; it moves on
            the same curve as the other overlays and drops it mid-drag. */}
        <div
          data-overlay="new-session"
          style={{ left: mapInsets.left, right: mapInsets.right }}
          className={[
            'pointer-events-none absolute bottom-6 flex justify-center',
            resizingPanel
              ? ''
              : 'transition-[left,right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <Button
            variant="cta"
            size="lg"
            className="pointer-events-auto"
            onClick={() => setDialog('new')}
          >
            <span aria-hidden className="text-base leading-none text-accent">+</span>
            New session
            <span className="rounded border border-[rgba(150,205,255,.2)] px-1.5 py-0.5 font-mono text-[10px] text-[rgba(200,220,245,.7)]">
              {shortcutLabel('global.new-session')}
            </span>
          </Button>
        </div>

        <div
          className="orbital-sloth pointer-events-none absolute"
          data-paused={windowFocused && !documentHidden ? undefined : ''}
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
