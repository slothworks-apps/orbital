import { memo, useCallback, useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from 'react'
import { Html } from '@react-three/drei'
import { useThree, type ThreeEvent } from '@react-three/fiber'
import { create } from 'zustand'
import type * as THREE from 'three'
import { useOrbital } from '../store/store'
import { useLimitsSnapshot } from '../lib/useLimitsSnapshot'
import { useNow } from '../lib/useNow'
import { sunDiscGradient, sunStyle, type SunPosition } from '../lib/limitSuns'
import { estimateLine, extraUsageValue, formatResetShort, limitSeverity } from '../lib/limits'
import type { LimitSeverity } from '../lib/types'
import { estimateWords } from '../limits/accounts'
import { ClaudeDirMark } from '../ui/ClaudeDirMark'
import { POPUP_SHELL } from '../ui/usePopupPosition'
import { bodyZoomFactor, type CameraState } from './camera'
import { useMapFrame } from './FrameBudget'
import { mapSuns, sunCardPlacement, SUN_CARD_WIDTH_PX, SUN_PX, type MapSun } from './sunModel'
import { sunLook } from './sunVisual'
import {
  BODY_MOVE_MS,
  advancePointTween,
  createPointTween,
  prefersReducedMotion,
  retargetPointTween,
} from './transition'

/**
 * The limit suns on the map (spec 2026-10-20-limit-suns-design § 4; canvas
 * `Feature - Limit sun` 60a, 60b, 60f). Each sun is the canvas's own CSS,
 * drawn through drei's `Html` into a layer UNDER the WebGL canvas, so the
 * planets draw over it (60f SIZE & LAYER) and its cross-fades run as CSS
 * transitions, without the map drawing a frame for them. An invisible disc
 * in the scene takes the pointer, under every planet's own.
 *
 * Not part of the simulation: nothing pushes on it, nothing is dropped on
 * it. `SpaceMap` owns the press (a click opens Limits, a drag moves it) and
 * the hover card; what they share with the scene is `useSunState`.
 */

/** 60a: the disc, in canvas px at 100 % zoom (`width:40px`). */
const DISC_PX = 40
/** 60a: the week arc's outer edge, `inset:-12px` around the disc. */
const ARC_OUT_PX = 12
/** 60b: the hover ring, `inset:-13px`. */
export const SUN_RING_OUT_PX = 13
/** 60a: the halo, `inset:-30px`; the corona, `inset:-7px`. */
const HALO_OUT_PX = 30
const CORONA_OUT_PX = 7
/** 60b: the label's top, `top:62px` from the 40 px box, as a drop below the centre. */
const LABEL_DROP_PX = 62 - DISC_PX / 2
/** 60f IN SPACE: the label stays this size on screen while the sun zooms. */
const LABEL_FONT_PX = 10.5
/** 60f HOVER: the ring's fade. */
const RING_FADE_MS = 160
/** 60f STYLE: every change of light cross-fades over this. */
const CROSS_FADE_MS = 1200
/** 60f HOVER: the card shows after the pointer has rested this long. */
const CARD_DELAY_MS = 300
/** The stale rule turns on time alone, so the suns re-read the clock this often. */
const CLOCK_MS = 60_000

/** Under every planet layer (`Planet`'s halo sits lowest, at a small negative z): the planet takes a press where the two overlap. */
const SUN_Z = -0.05
/** The disc and its week arc, in world units before the counter-zoom: the press target, and what fit keeps in view. */
export const SUN_REACH = (DISC_PX / 2 + ARC_OUT_PX) * SUN_PX

const MONO = "'JetBrains Mono', ui-monospace, monospace"

/** A press on a sun, held by `SpaceMap` until it is a click or a drag. */
export interface SunPress {
  key: string
  pointerId: number
  startX: number
  startY: number
  /** Where the sun was when pressed, and where the pointer was in the world, so a drag keeps the grab point. */
  origin: SunPosition
  grab: SunPosition
  engaged: boolean
  /** The sun's position while dragged. */
  x: number
  y: number
}

interface SunState {
  /** The suns as last drawn — what a press, a fit and the card read. */
  suns: MapSun[]
  /** The sun under the pointer: its ring shows. */
  hovered: string | null
  /** The sun whose card shows, `CARD_DELAY_MS` after it was hovered. */
  card: string | null
  /** The sun being dragged: its ring stays, the card goes. */
  dragging: string | null
}

export const useSunState = create<SunState>(() => ({ suns: [], hovered: null, card: null, dragging: null }))

let cardTimer: ReturnType<typeof setTimeout> | null = null

function hoverSun(key: string | null): void {
  if (cardTimer !== null) clearTimeout(cardTimer)
  cardTimer = null
  useSunState.setState({ hovered: key, card: null })
  if (key === null) return
  cardTimer = setTimeout(() => {
    cardTimer = null
    if (useSunState.getState().hovered === key && !useSunState.getState().dragging) useSunState.setState({ card: key })
  }, CARD_DELAY_MS)
}

/** A drag took the sun: the card goes, the ring stays on it. */
export function startSunDrag(key: string): void {
  if (cardTimer !== null) clearTimeout(cardTimer)
  cardTimer = null
  useSunState.setState({ dragging: key, card: null })
}

export function endSunDrag(): void {
  useSunState.setState({ dragging: null })
}

/** CSS px per canvas px at this zoom: the planets' counter-zoom and size setting, so the sun keeps below the smallest planet. */
function sunScreenScale(zoom: number, planetScale: number): number {
  return bodyZoomFactor(zoom) * planetScale * zoom * SUN_PX
}

export interface LimitSunsProps {
  /** The trash's position: the default row is placed against the field it bounds. */
  hole: SunPosition
  planetScale: number
  /** The DOM layer under the canvas the suns are drawn into. */
  layerRef: RefObject<HTMLDivElement | null>
  pressRef: RefObject<SunPress | null>
  onPress: (sun: MapSun, e: ThreeEvent<PointerEvent>) => void
}

/**
 * Every sun, inside the map's `Canvas`; mounted only while Labs → Limit suns
 * is on. Memoised: a pan re-renders the map on every move, and the suns have
 * nothing to change for it — the frame loop moves them.
 */
export const LimitSuns = memo(function LimitSuns({ hole, planetScale, layerRef, pressRef, onPress }: LimitSunsProps) {
  const { snapshot } = useLimitsSnapshot()
  const settings = useOrbital((s) => s.settings)
  const now = useNow(true, CLOCK_MS)
  const style = sunStyle(settings)
  const suns = useMemo(() => mapSuns(snapshot, settings, hole, now), [snapshot, settings, hole, now])

  useEffect(() => {
    useSunState.setState((s) => ({
      suns,
      hovered: suns.some((x) => x.key === s.hovered) ? s.hovered : null,
      card: suns.some((x) => x.key === s.card) ? s.card : null,
    }))
  }, [suns])
  useEffect(
    () => () => {
      hoverSun(null)
      useSunState.setState({ suns: [], dragging: null })
    },
    []
  )

  return (
    <>
      {suns.map((sun) => (
        <LimitSun
          key={sun.key}
          sun={sun}
          style={style}
          planetScale={planetScale}
          layerRef={layerRef}
          pressRef={pressRef}
          onPress={onPress}
        />
      ))}
    </>
  )
})

function LimitSun({
  sun,
  style,
  planetScale,
  layerRef,
  pressRef,
  onPress,
}: {
  sun: MapSun
  style: ReturnType<typeof sunStyle>
  planetScale: number
  layerRef: RefObject<HTMLDivElement | null>
  pressRef: RefObject<SunPress | null>
  onPress: (sun: MapSun, e: ThreeEvent<PointerEvent>) => void
}) {
  const gl = useThree((s) => s.gl)
  const move = useRef(createPointTween(sun.position.x, sun.position.y, BODY_MOVE_MS)).current
  const groupRef = useRef<THREE.Group>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const labelRef = useRef<HTMLDivElement | null>(null)
  /** The scale last worked out, and the one the DOM wears: `Html` mounts its content a beat after the scene. */
  const scale = useRef(0)
  const applied = useRef(-1)
  const ringOn = useSunState((s) => s.hovered === sun.key || s.dragging === sun.key)
  const dragging = useSunState((s) => s.dragging === sun.key)
  const look = useMemo(() => sunLook(style, sun.reading, sun.color, sun.stale), [style, sun.reading, sun.color, sun.stale])
  const reduced = prefersReducedMotion()

  // A sun without a stored position walks with the field, like the trash; a
  // dropped one is already where it was put.
  useEffect(() => {
    retargetPointTween(move, sun.position.x, sun.position.y, reduced)
  }, [move, sun.position.x, sun.position.y, reduced])

  const applyScale = useCallback(() => {
    const body = bodyRef.current
    const label = labelRef.current
    if (!body || !label || applied.current === scale.current) return
    body.style.transform = `scale(${scale.current})`
    label.style.top = `${LABEL_DROP_PX * scale.current}px`
    applied.current = scale.current
  }, [])
  const setBody = useCallback(
    (el: HTMLDivElement | null) => {
      bodyRef.current = el
      applied.current = -1
      applyScale()
    },
    [applyScale]
  )
  const setLabel = useCallback(
    (el: HTMLDivElement | null) => {
      labelRef.current = el
      applied.current = -1
      applyScale()
    },
    [applyScale]
  )

  useMapFrame((state, delta) => {
    const group = groupRef.current
    if (!group) return false
    const press = pressRef.current
    let moving = false
    if (press?.key === sun.key && press.engaged) {
      retargetPointTween(move, press.x, press.y, true)
      group.position.set(press.x, press.y, SUN_Z)
    } else {
      moving = advancePointTween(move, delta)
      group.position.set(move.x.value, move.y.value, SUN_Z)
    }
    const zoom = state.camera.zoom
    group.scale.setScalar(bodyZoomFactor(zoom) * planetScale)
    scale.current = sunScreenScale(zoom, planetScale)
    applyScale()
    return moving
  })

  useEffect(() => {
    gl.domElement.style.cursor = dragging ? 'grabbing' : ringOn ? 'grab' : ''
  }, [gl, ringOn, dragging])
  useEffect(
    () => () => {
      gl.domElement.style.cursor = ''
    },
    [gl]
  )

  // Only the frontmost thing under the pointer counts: a planet over the sun
  // takes the hover and the press (60f SIZE & LAYER, under the planets).
  const frontmost = (e: ThreeEvent<PointerEvent>) => e.intersections[0]?.object === e.object
  const handleOver = (e: ThreeEvent<PointerEvent>) => {
    if (frontmost(e) && e.buttons === 0 && !pressRef.current) hoverSun(sun.key)
  }
  const handleOut = () => {
    if (useSunState.getState().hovered === sun.key) hoverSun(null)
  }
  const handleDown = (e: ThreeEvent<PointerEvent>) => {
    if (e.nativeEvent.button !== 0 || !frontmost(e)) return
    onPress(sun, e)
  }

  const fade = (props: string, ms: number) =>
    reduced ? undefined : props.split(',').map((p) => `${p} ${ms}ms ease`).join(',')

  return (
    <group ref={groupRef} position={[move.x.value, move.y.value, SUN_Z]}>
      <mesh visible={false} onPointerOver={handleOver} onPointerOut={handleOut} onPointerDown={handleDown}>
        <circleGeometry args={[SUN_REACH, 32]} />
      </mesh>
      <Html portal={layerRef as MutableRefObject<HTMLElement>} zIndexRange={[0, 0]} style={{ pointerEvents: 'none' }}>
        <div style={{ position: 'relative', width: 0, height: 0 }}>
          <div
            ref={setBody}
            style={{
              position: 'absolute',
              left: -DISC_PX / 2,
              top: -DISC_PX / 2,
              width: DISC_PX,
              height: DISC_PX,
              transformOrigin: '50% 50%',
              transform: `scale(${scale.current})`,
            }}
          >
            <span
              style={{
                position: 'absolute',
                inset: -HALO_OUT_PX,
                borderRadius: '50%',
                background: look.haloBg,
                opacity: look.haloOp,
                transition: fade('opacity', CROSS_FADE_MS),
              }}
            />
            <span
              style={{
                position: 'absolute',
                inset: -CORONA_OUT_PX,
                borderRadius: '50%',
                boxShadow: look.coronaShadow,
                opacity: look.coronaOp,
                transition: fade('opacity', CROSS_FADE_MS),
              }}
            />
            <span
              style={{
                position: 'absolute',
                inset: -ARC_OUT_PX,
                borderRadius: '50%',
                background: look.arcBg,
                opacity: look.arcOp,
                mask: 'radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1.5px))',
                WebkitMask: 'radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 1.5px))',
              }}
            />
            <span
              style={{
                position: 'absolute',
                inset: -SUN_RING_OUT_PX,
                borderRadius: '50%',
                border: '1px solid rgba(150,205,255,.32)',
                opacity: ringOn ? 1 : 0,
                transition: fade('opacity', RING_FADE_MS),
              }}
            />
            <span
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                overflow: 'hidden',
                boxSizing: 'border-box',
                background: look.disc,
                border: `1px ${look.rimStyle} ${look.rimInk}`,
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: -1,
                  bottom: -1,
                  width: 'calc(100% + 2px)',
                  left: `${look.shadowLeft}%`,
                  borderRadius: '50%',
                  background: 'oklch(15% .01 250)',
                  opacity: look.shadowOp,
                  transition: fade('left,opacity', CROSS_FADE_MS),
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'repeating-linear-gradient(135deg,rgba(200,215,235,.22) 0 1.2px,transparent 1.2px 5px)',
                  opacity: look.hatchOp,
                  transition: fade('opacity', CROSS_FADE_MS),
                }}
              />
            </span>
          </div>
          <div
            ref={setLabel}
            style={{
              position: 'absolute',
              left: 0,
              top: LABEL_DROP_PX * scale.current,
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              whiteSpace: 'nowrap',
              fontFamily: MONO,
              fontSize: LABEL_FONT_PX,
              letterSpacing: '.04em',
              color: look.ink,
            }}
          >
            {sun.tiles.map((t) => (
              <span key={t} style={TILE_STYLE}>
                {t}
              </span>
            ))}
            {sun.stale ? `last read ${sun.readClock}` : sun.reading.label}
          </div>
        </div>
      </Html>
    </group>
  )
}

/** 60a: a directory tile in the sun's label — opaque, ringed in the space's black, so it holds over stars. */
const TILE_STYLE = {
  display: 'inline-grid',
  placeItems: 'center',
  flex: 'none',
  boxSizing: 'border-box',
  minWidth: 12,
  height: 12,
  padding: '0 2px',
  borderRadius: 3.5,
  background: 'oklch(34% .012 250)',
  boxShadow: '0 0 0 1.5px #05070d',
  fontSize: 7.5,
  fontWeight: 600,
  lineHeight: 1,
  color: '#eef4fc',
} as const

/** 60b: a row's fill by its ink step, LIMIT REACHED included. */
const FILL: Record<LimitSeverity | 'reached', string> = {
  normal: 'rgba(150,205,255,.42)',
  warning: 'rgba(214,230,248,.72)',
  critical: '#e8eef8',
  reached: '#e8eef8',
}

/**
 * The hover card (60b), in the map's HUD: the shared dropdown shell, placed
 * beside the sun, taking no pointer. Every window of the account, model
 * windows and extra usage included, with its reset and estimate.
 */
export function LimitSunCard({
  camera,
  planetScale,
  containerRef,
}: {
  camera: CameraState
  planetScale: number
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const sun = useSunState((s) => (s.card ? (s.suns.find((x) => x.key === s.card) ?? null) : null))
  if (!sun) return null
  const rect = containerRef.current?.getBoundingClientRect()
  const viewport = { width: rect?.width ?? window.innerWidth, height: rect?.height ?? window.innerHeight }
  const at = {
    x: (sun.position.x - camera.x) * camera.zoom + viewport.width / 2,
    y: viewport.height / 2 - (sun.position.y - camera.y) * camera.zoom,
  }
  const ringPx = (DISC_PX / 2 + SUN_RING_OUT_PX) * sunScreenScale(camera.zoom, planetScale)
  const { left, top } = sunCardPlacement(at, ringPx, viewport)
  const now = Date.now()
  const reading = sun.group.reading
  const extra = reading.extraUsage?.enabled ? reading.extraUsage : null

  return (
    <div
      data-limit-sun-card
      className={['orbital-popover-in pointer-events-none absolute flex flex-col gap-0.5 text-[#e8eef8]', POPUP_SHELL].join(' ')}
      style={{ left, top, width: SUN_CARD_WIDTH_PX, boxSizing: 'border-box', padding: '12px 14px 10px' }}
    >
      <div className="flex items-center gap-1.5 pb-2">
        <span className="block size-2.5 flex-none rounded-full" style={{ background: sunDiscGradient(sun.color) }} />
        {sun.tiles.map((t) => (
          <ClaudeDirMark key={t} mono={t} />
        ))}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-bold">{sun.title}</span>
        <span className="font-mono text-[10px] text-[rgba(160,190,225,.55)]">
          {sun.stale ? `last read ${sun.readClock}` : `read ${sun.readClock}`}
        </span>
      </div>
      {reading.windows.map((w, i) => {
        const line = estimateLine(w, sun.stale, now)
        return (
          <CardRow
            key={`${w.kind}:${w.label}:${i}`}
            name={w.label}
            value={`${Math.round(w.percent)}%`}
            percent={w.percent}
            fill={FILL[w.percent >= 100 ? 'reached' : limitSeverity(w.severity)]}
            reset={`resets ${formatResetShort(w.resetsAt, now)}`}
            estimate={sun.stale ? (line ? { before: '—', at: '', after: '', lit: false } : null) : line ? estimateWords(line) : null}
            dim={sun.stale}
          />
        )
      })}
      {extra && (
        <CardRow
          name="Extra usage"
          value={extraUsageValue(extra) ?? '—'}
          percent={extra.percent ?? 0}
          fill={FILL.normal}
          reset={null}
          estimate={null}
          dim={sun.stale}
        />
      )}
      <div className="border-t border-[rgba(150,205,255,.08)] pt-2 font-mono text-[9.5px] tracking-[0.06em] text-[rgba(160,190,225,.45)]">
        click: open Limits · drag: move
      </div>
    </div>
  )
}

function CardRow({
  name,
  value,
  percent,
  fill,
  reset,
  estimate,
  dim,
}: {
  name: string
  value: string
  percent: number
  fill: string
  reset: string | null
  estimate: ReturnType<typeof estimateWords> | null
  dim: boolean
}) {
  return (
    <div
      className="flex flex-col gap-[5px] border-t border-[rgba(150,205,255,.08)] py-2"
      // 60b: a stale account's rows at .6.
      style={{ opacity: dim ? 0.6 : 1 }}
    >
      <div className="flex items-baseline gap-2">
        <span className="flex-1 text-xs font-semibold">{name}</span>
        <span className="font-mono text-xs">{value}</span>
      </div>
      <div className="h-[3px] overflow-hidden rounded-[2px] bg-[rgba(150,205,255,.1)]">
        <span
          className="block h-full rounded-[2px]"
          style={{ width: `${Math.min(Math.max(percent, 0), 100)}%`, background: fill }}
        />
      </div>
      <div className="flex gap-2 font-mono text-[10px] text-[rgba(160,190,225,.6)]">
        <span>{reset ?? ''}</span>
        <span className="flex-1" />
        {estimate && (
          <span style={{ color: estimate.lit ? 'rgba(160,190,225,.75)' : 'rgba(160,190,225,.55)' }}>
            {estimate.before}
            <span className="text-[#e8eef8]">{estimate.at}</span>
            {estimate.after}
          </span>
        )}
      </div>
    </div>
  )
}
