import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { Subagent } from '../lib/types'
import { REFERENCE_ZOOM, bodyDesignPxToScreenPx, bodyZoomFactor } from './camera'
import { useFrameOnRender, useFrameScheduler, useMapFrame } from './FrameBudget'
import { oklchCss, type Oklch } from '../lib/usage'
import {
  MAT_RING_MAX_SCALE,
  MAT_RING_MIN_SCALE,
  MAT_RING_SEC,
  MAT_RING_START_OPACITY,
  MAT_SHELL_MAX_OPACITY,
  MAT_SHELL_MAX_SCALE,
  MAT_SHELL_MIN_OPACITY,
  MAT_SHELL_MIN_SCALE,
  MAT_SHELL_SEC,
  MOON_TICK_COUNT,
  MOON_TICK_LENGTH,
  MOON_TICK_OPACITY,
  MOON_TICK_RADIUS,
  MOON_TICK_WIDTH_DEG,
  easeOut,
  moonVisuals,
  oscillate,
} from './visuals'
import {
  MOON_STATES,
  advanceStateMix,
  advanceTween,
  blendMoon,
  createMoonBlend,
  advancePointTween,
  mutedOpacity,
  STATE_TRANSITION_MS,
  useFadeTween,
  useHueTween,
  usePointTween,
  useScaleTween,
  useStateMix,
} from './transition'
import { glowTexture } from './textures'
import { oklchTagColor, setOklchTagColor, TickRing } from './Planet'
import type { SimBody } from './simulation'

/**
 * Small disc orbiting its parent planet, driven purely by props + an
 * internal `useFrame` clock (`orbitRadius`, `phase`). Still no store/api
 * imports — `onOpen` is a plain callback prop, exactly like `Planet`'s own
 * `onClick`; the store wiring lives in `SpaceMap` (task 9 brief).
 *
 * BINDING rule: hue paints the rim/core; subagent STATE is carried only by
 * `moonVisuals` (disc size, tick spin, core blink, ripple, dashed
 * materializing shell) plus a white ripple/core for needs-input, never by
 * re-hue-ing. Task 9 extends the "white for emphasis" half of that rule to
 * HOVER (canvas 11e: "white rim, brighter core") — same mechanism
 * (`lerp(..., WHITE_COLOR)`), a UI affordance rather than a new state, never
 * a new hue.
 *
 * Geometry is transcribed from the state sheet (artboard 1f in
 * `Orbital.dc.html`, "MOONS · SUBAGENTS" row) and the close-up 1c, where a
 * moon is quoted in absolute px next to a 100px planet body → 0.01 units/px.
 *
 * STATE CHANGES CROSSFADE — see `transition.ts` and the same note at the top
 * of `Planet.tsx`: every layer stays mounted, materials are owned by the
 * component and written from the frame loop, and sizes are driven by SCALING
 * unit geometry rather than by rebuilding geometry per frame.
 *
 * INTERACTIVITY (task 9, spec § 5 "Two ways in", canvas 11e): the hit area,
 * hover ring, active brackets/tether and hover label are all plain DOM,
 * portalled in via drei's `<Html>` exactly like `Planet`'s `CompactBadge` —
 * not three.js geometry. The reason is testability: `<Html>` never mounts
 * under jsdom (no WebGL context, so `Canvas` never reaches the frame that
 * would portal its children — confirmed empirically for this repo's test
 * setup; see `docs/decisions/moon-button-is-a-plain-dom-child-for-
 * testability.md`), so the interactive layer is factored out as
 * `MoonControl`, a store-free, three-free function component that renders on
 * its own with a bare `render(<MoonControl .../>)` — no `<Canvas>` required.
 * `Moon` only decides WHETHER to mount it (`openable`) and wraps it in
 * `<Html>` for positioning.
 *
 * What that DOM layer does NOT get for free is its size. `<Html>` renders in
 * real CSS px, and the counter-zoom (`bodyZoomFactor`) does not hold the
 * moon's apparent screen size constant — it is clamped to 1 from below, so
 * it only slows the shrink on the way out and does nothing at all on the way
 * in (adr: counter-zoom-inflates-the-whole-moon-system). Fixed CSS px here
 * was therefore wrong at every zoom but one. `MoonControl` takes a `scale`
 * instead, fed live from the frame loop below —
 * `bodyDesignPxToScreenPx(zoom, bodyScale)` — so its design-px geometry
 * lands on screen at the same size as the disc it decorates.
 */

/** 1px rim straddling the disc edge (`border:1px solid hue/<x>`). */
const RIM_WIDTH = 0.01

/** Dark disc fills: `oklch(30% .05 220)` working/materializing, `oklch(28% .05 220)` idle/needs-input. */
const DISC_COLOR = oklchTagColor(220, 0.3, 0.05)
const DISC_COLOR_IDLE = oklchTagColor(220, 0.28, 0.05)
/** Ended moon: flat `oklch(16% .01 230)` like the ended planet body. */
const DISC_COLOR_ENDED = oklchTagColor(230, 0.16, 0.01)

/** Per-state disc fill, summed by weight so the fill eases across a state change. */
const DISC_COLORS: Record<Subagent['state'], THREE.Color> = {
  materializing: DISC_COLOR,
  working: DISC_COLOR,
  idle: DISC_COLOR_IDLE,
  needs_input: DISC_COLOR_IDLE,
  ended: DISC_COLOR_ENDED,
}

/** `orb-blink`: opacity 1 → .3 → 1. */
const BLINK_DEPTH = 0.7

/** Needs-input `orb-pulse-out` ripple: inset -4 on the 22px disc → 15px radius, scale 1 → 1.9 over 2.4s. */
const MOON_RIPPLE_MAX_SCALE = 1.9
const MOON_RIPPLE_DURATION_SEC = 2.4
const MOON_RIPPLE_START_OPACITY = 0.9
const MOON_RIPPLE_INNER = 0.14
const MOON_RIPPLE_OUTER = 0.15

/** Materializing shell fill is drawn at `oklch(30% .05 220 / .6)`. */
const MAT_FILL_ALPHA = 0.6
/** Materializing dashed shell + `orb-matring` both sit on the 24px disc edge. */
const MAT_RADIUS = 0.12

/** Angular orbit speed, radians/sec, at orbitRadius = 1 (scaled by 1/radius so closer moons don't look slower). */
const ORBIT_ANGULAR_SPEED = 0.5

/** Ended grey — `rgba(200,215,235)` in the canvas export. */
const GREY = '#c8d7eb'
const WHITE = '#ffffff'
const GREY_COLOR = new THREE.Color(GREY)
const WHITE_COLOR = new THREE.Color(WHITE)

// --- Interactivity (task 9, spec § 5 / canvas 11e) ------------------------
// Quoted in DESIGN px, like every other value on this map, and converted to
// CSS px by `MoonControl`'s `scale` prop — see that prop's own doc. They are
// NOT CSS px: canvas 11e draws the affordance against the same 100px-planet
// grid the moon's own geometry is quoted in, and the moon's on-screen size
// is not constant (see `bodyDesignPxToScreenPx` in `camera.ts`).

/** "hit area 40px". */
const MOON_HIT_AREA_PX = 40

/**
 * Floor on the hit area's CSS size, and the one value here that is real CSS
 * px rather than design px.
 *
 * At the bottom of the zoom range the scale factor is ~0.17, which would
 * draw the 40 design-px target at 7 CSS px — smaller than the pointer using
 * it. The floor keeps it pressable without going back to the fixed 40 px
 * that swallowed map-drag pointerdowns: at zoom 5 four moons around one
 * planet sit a handful of pixels apart, and 40 px circles merged them into
 * one blob that the pan gesture could not get past.
 *
 * Reasoned from the arithmetic, not measured — no browser tooling exists in
 * the environment this was fixed in. 22 px is the smallest interactive box
 * this repo already ships (`UtilityButton`'s `title` variant), so the floor
 * is borrowed rather than invented here.
 */
const MOON_HIT_AREA_MIN_CSS_PX = 22

/**
 * Relative change in the affordance's scale that is worth a React re-render
 * — see `affordanceScale` in `Moon`. 1% of a 20px control is a fifth of a
 * pixel.
 */
const AFFORDANCE_SCALE_EPSILON = 0.01
/** "label offset 16px outside the moon". */
const MOON_LABEL_OFFSET_PX = 16
/** Hover halo ring: `inset:-14px` on the 26px working-state disc (11e). */
const MOON_HOVER_RING_OFFSET_PX = 14
/** Active accent ring: `inset:-13px` (11e). */
const MOON_ACTIVE_RING_OFFSET_PX = 13
/** Active corner brackets: "19px out, 7px arms" (11e RULES). */
const MOON_BRACKET_OFFSET_PX = 19
const MOON_BRACKET_ARM_PX = 7
/** Active tether: `stroke-dasharray="3 6"` running toward the panel (11e). */
const MOON_TETHER_LENGTH_PX = 64

/** How much the hover disc/rim/glow brighten toward white (11e: "brighter core"). */
const MOON_HOVER_DISC_BRIGHTEN = 0.15
const MOON_HOVER_GLOW_BOOST = 1.15

/** The design accent (`oklch(85% .12 205)`, `--color-accent` in theme.css) —
 * the active ring/bracket-adjacent tether's colour, spec § 8's own fallback
 * accent, reused here via `oklchCss` rather than a second hand-picked hex. */
const MOON_ACCENT_OKLCH: Oklch = { lightness: 0.85, chroma: 0.12, hue: 205 }

/** The four corner brackets' signs — same shape as `Planet.tsx`'s `BRACKET_SIGNS`. */
const MOON_BRACKET_CORNERS: readonly (readonly [1 | -1, 1 | -1])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
]

export interface MoonControlProps {
  subagent: Subagent
  /** This moon's panel is the one currently open (canvas 11e "Active"). */
  active: boolean
  /** The current (possibly ended-overridden) disc radius, in design px —
   * every offset below reads off this, so the hit area and its decorations
   * track the disc through a state crossfade rather than a size frozen at
   * mount. */
  discPx: number
  /**
   * Design px → CSS px, i.e. `bodyDesignPxToScreenPx(zoom, bodyScale)`
   * (`camera.ts`), fed live by `Moon`'s frame loop.
   *
   * Everything in this component is quoted in design px and multiplied by
   * this. `<Html>` (without `transform`) renders its children in real CSS
   * px, unaffected by any world scale, while the moon THEY DECORATE is
   * drawn in world units and therefore changes size with the camera — by a
   * factor of ~23 across the zoom range. Sizing this layer in fixed CSS px
   * put a 40 px button around a 4 px dot at the bottom of the range (where
   * it also ate the map's own drag pointerdowns) and left the halo and
   * brackets INSIDE the disc at the top of it.
   *
   * Defaults to 1 so a bare `render(<MoonControl …/>)` — the whole point of
   * this component existing separately, see the file's "INTERACTIVITY" doc
   * — still draws the canvas's own design-px geometry with no camera to ask.
   */
  scale?: number
  /** Opens the subagent panel for this moon — already bound to `sessionId`
   * and `subagent` by the caller, so this takes no arguments. */
  onOpen: () => void
  /** Mirrors hover/focus back to `Moon`'s frame loop, which owns the
   * three.js material blend (`applyState`) — this component only renders
   * its own DOM decorations off the same boolean. */
  onHoverChange?: (hovered: boolean) => void
}

/**
 * The moon's interactive layer (task 9, spec § 5 / canvas 11e): a real
 * `<button>` sized to the 40px hit area, centred on the moon, with the
 * hover halo, the active corner brackets + accent ring + dashed tether, and
 * the hover label. Deliberately store-free and three-free — see `Moon`'s
 * own "INTERACTIVITY" doc for why this is its own component rather than
 * JSX inlined into `Moon`'s `<Html>` block: it is what makes any of this
 * testable at all under jsdom, which never mounts `<Html>`'s children
 * inside a real `<Canvas>` (no WebGL context to reach the frame that would
 * portal them).
 *
 * A real `<button>` needs no keyboard wiring of its own: `↵`/Space already
 * fire a native `click` (task 9 brief item 9), and `⎋` is the app's shared
 * escape layer (`SubagentPanel`'s own `useEscapeLayer` call), never a
 * listener here — a second one would compete with it (brief § 4).
 */
export function MoonControl({
  subagent,
  active,
  discPx,
  scale = 1,
  onOpen,
  onHoverChange,
}: MoonControlProps) {
  const [hovered, setHovered] = useState(false)

  const setHover = (next: boolean) => {
    setHovered(next)
    onHoverChange?.(next)
  }

  // Every radius below is the design-px offset applied to the DRAWN disc and
  // then converted, so each ring keeps its canvas relationship to the moon
  // at every zoom instead of only at the one the numbers were written for.
  const discR = discPx * scale
  const haloR = discR + MOON_HOVER_RING_OFFSET_PX * scale
  const activeR = discR + MOON_ACTIVE_RING_OFFSET_PX * scale
  const bracketR = discR + MOON_BRACKET_OFFSET_PX * scale
  const bracketArm = MOON_BRACKET_ARM_PX * scale
  const tetherLength = MOON_TETHER_LENGTH_PX * scale
  const labelOffset = discR + MOON_LABEL_OFFSET_PX * scale
  // The one floored value — see `MOON_HIT_AREA_MIN_CSS_PX`. The decorations
  // are not floored: they describe the moon, and a halo that refused to
  // shrink below a floor would sit visibly off the thing it rings.
  const hitAreaPx = Math.max(MOON_HIT_AREA_PX * scale, MOON_HIT_AREA_MIN_CSS_PX)
  const accentBorder = oklchCss(MOON_ACCENT_OKLCH, 0.9)
  const activeGlow = oklchCss(MOON_ACCENT_OKLCH, 0.35)
  const haloGlow = oklchCss(MOON_ACCENT_OKLCH, 0.28)
  const accentDash = oklchCss(MOON_ACCENT_OKLCH, 0.55)

  return (
    <button
      type="button"
      data-moon-open
      aria-label={`Open subagent transcript: ${subagent.name}`}
      onClick={(e) => {
        // The map's own pointer handling lives one level up on the canvas
        // container (drag/pan/select) — a real DOM button inside `<Html>`
        // already stops the underlying pointer event from reaching three.js
        // (drei's own doing), but the click itself still bubbles through
        // the DOM and would otherwise also reach the map surface's own
        // click-to-deselect handling.
        e.stopPropagation()
        onOpen()
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'block',
        width: hitAreaPx,
        height: hitAreaPx,
        appearance: 'none',
        border: 0,
        background: 'none',
        margin: 0,
        padding: 0,
        borderRadius: '50%',
        cursor: 'pointer',
        pointerEvents: 'auto',
      }}
    >
      {hovered && (
        <span
          data-moon-halo
          aria-hidden
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: haloR * 2,
            height: haloR * 2,
            marginLeft: -haloR,
            marginTop: -haloR,
            borderRadius: '50%',
            border: '1px solid rgba(230,245,255,.55)',
            boxShadow: `0 0 16px ${haloGlow}`,
          }}
        />
      )}

      {active && (
        <>
          <span
            data-moon-active-ring
            aria-hidden
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: activeR * 2,
              height: activeR * 2,
              marginLeft: -activeR,
              marginTop: -activeR,
              borderRadius: '50%',
              border: `1px solid ${accentBorder}`,
              boxShadow: `0 0 18px ${activeGlow}`,
            }}
          />
          {MOON_BRACKET_CORNERS.map(([sx, sy]) => (
            <span
              key={`${sx}${sy}`}
              data-moon-bracket
              aria-hidden
              style={{
                position: 'absolute',
                left: `calc(50% + ${sx * bracketR - (sx > 0 ? bracketArm : 0)}px)`,
                top: `calc(50% + ${sy * bracketR - (sy > 0 ? bracketArm : 0)}px)`,
                width: bracketArm,
                height: bracketArm,
                borderLeft: sx < 0 ? '1.5px solid #fff' : undefined,
                borderRight: sx > 0 ? '1.5px solid #fff' : undefined,
                borderTop: sy < 0 ? '1.5px solid #fff' : undefined,
                borderBottom: sy > 0 ? '1.5px solid #fff' : undefined,
              }}
            />
          ))}
          <span
            data-moon-tether
            aria-hidden
            style={{
              position: 'absolute',
              left: `calc(50% + ${activeR}px)`,
              top: '50%',
              width: tetherLength,
              height: 1,
              background: `repeating-linear-gradient(90deg, ${accentDash} 0 3px, transparent 3px 9px)`,
            }}
          />
        </>
      )}

      {hovered && (
        <span
          data-moon-label
          style={{
            position: 'absolute',
            left: `calc(50% + ${labelOffset}px)`,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            padding: '3px 8px',
            borderRadius: 999,
            background: 'rgba(6,10,20,.92)',
            border: '1px solid rgba(150,205,255,.3)',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 9.5,
            letterSpacing: '0.08em',
            color: '#e8eef8',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
          }}
        >
          {subagent.name}
        </span>
      )}
    </button>
  )
}

export interface MoonProps {
  subagent: Subagent
  /** Parent planet's tag hue (oklch hue angle, 0-360); state never changes this. */
  hue: number
  parentX: number
  parentY: number
  orbitRadius: number
  /** Starting angle on the orbit, in radians — keeps multiple moons spread out. */
  phase: number
  /**
   * Appearance → default planet size (canvas 5a): multiplies the moon's BODY
   * only, never `orbitRadius` or the trail — "orbit radii are untouched".
   * The counter-zoom factor is separate and scales the whole system.
   */
  bodyScale?: number
  /**
   * The parent planet's simulation body. When present, the moon anchors to
   * its LIVE position every frame (the sim owns all motion); the
   * `parentX`/`parentY` props then only seed the first frame. Same stable
   * mutated-in-place object as `Planet`'s `simBody`.
   */
  parentBody?: SimBody
  /**
   * The session this moon belongs to — needed only to hand back to `onOpen`
   * (`moon.sessionId` off `SceneMoon`, straight through). Absent in the
   * sandbox, which never wires click behaviour for moons at all.
   */
  sessionId?: string
  /**
   * This moon's subagent is the one the subagent panel currently shows
   * (canvas 11e "Active"). Meaningless — and ignored — unless `onOpen` is
   * also wired, since an inactive-but-unwired moon renders exactly as
   * today's did.
   */
  active?: boolean
  /**
   * Opens the subagent panel for this moon. Absent in the sandbox and in
   * tests that don't drive click behaviour — a moon with no `onOpen` (or no
   * `sessionId`) renders its plain per-state geometry with no interactive
   * layer at all, openable or not: that is what lets the sandbox keep
   * replaying every `Subagent['state']` untouched by this task, since its
   * fixtures carry no `toolUseId` and would otherwise all read as INERT.
   */
  onOpen?: (sessionId: string, subagent: Subagent) => void
  /**
   * The parent planet is muted by the sidebar filters — the moon mutes with
   * it: whole-body opacity down to `MUTED_OPACITY`, hue toward the ended
   * grey, on the same tween as the planet's.
   */
  muted?: boolean
}

/** Circle outline used for the orbit trail, the materializing shell and its expanding ring. */
function circlePoints(radius: number, segments: number): [number, number, number][] {
  const pts: [number, number, number][] = []
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    pts.push([radius * Math.cos(angle), radius * Math.sin(angle), 0])
  }
  return pts
}

/**
 * Module-level so the point arrays keep a stable reference: a fresh array
 * every render makes drei's <Line> tear down and rebuild its live
 * geometry/material, and these circles never change.
 */
const MAT_SHELL_POINTS = circlePoints(MAT_RADIUS, 32)
const MAT_RING_POINTS = circlePoints(MAT_RADIUS, 48)

type LineHandle = ComponentRef<typeof Line>

interface MoonMaterials {
  glow: THREE.MeshBasicMaterial
  disc: THREE.MeshBasicMaterial
  rim: THREE.MeshBasicMaterial
  core: THREE.MeshBasicMaterial
  ripple: THREE.MeshBasicMaterial
  ticks: THREE.MeshBasicMaterial
  matFill: THREE.MeshBasicMaterial
}

/** One material set per moon, created once and mutated by the frame loop. */
function useMoonMaterials(): MoonMaterials {
  const materials = useMemo<MoonMaterials>(() => {
    const soft = (color?: THREE.Color | string, map?: THREE.Texture | null) => {
      const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
      if (color !== undefined) material.color.set(color)
      if (map) material.map = map
      return material
    }
    return {
      glow: soft(undefined, glowTexture()),
      disc: soft(),
      rim: soft(),
      core: soft(),
      ripple: soft(WHITE),
      ticks: soft(),
      matFill: soft(DISC_COLOR),
    }
  }, [])

  useEffect(
    () => () => {
      for (const material of Object.values(materials)) material.dispose()
    },
    [materials]
  )

  return materials
}

export interface MoonInteraction {
  /** Mounts `MoonControl` — the moon takes a hit area, a hover treatment
   * and a tab stop. */
  openable: boolean
  /** Spec § 5: no `toolUseId`, so nothing can join it to a buffer. Forces
   * `effectiveState` to `'ended'` regardless of the subagent's real
   * `state` — "drops to the ended-moon greys and KEEPS ITS MOTION STILL"
   * is true even for a genuinely still-`working` inert agent, not just a
   * flatter-looking one. */
  inert: boolean
  /** What `moonVisuals`/`MOON_STATES` should actually read — `subagent.state`
   * unless `inert`, in which case always `'ended'`. */
  effectiveState: Subagent['state']
}

/**
 * The gating decision behind `openable`/`inert`/`effectiveState`, pulled out
 * of `Moon` as its own pure function purely so it is unit-testable: `Moon`
 * itself cannot be rendered under jsdom at all (no WebGL context for
 * `Canvas` to reach the frame that would mount anything under it, `Html`
 * included — see the file's own "INTERACTIVITY" doc), so this is task 9's
 * one piece of map-visible gating logic that gets a test without a
 * `<Canvas>`.
 *
 * `wired` is `Boolean(onOpen && sessionId)` — false for every caller that
 * never asked for interactivity at all (the sandbox, most component tests),
 * which must render exactly as it always did rather than reading every
 * fixture as INERT for lack of a `toolUseId` it was never asked to carry.
 */
export function moonInteraction(
  subagent: Pick<Subagent, 'toolUseId' | 'state'>,
  wired: boolean
): MoonInteraction {
  const openable = wired && Boolean(subagent.toolUseId)
  const inert = wired && !subagent.toolUseId
  return { openable, inert, effectiveState: inert ? 'ended' : subagent.state }
}

export function Moon({
  subagent,
  hue,
  parentX,
  parentY,
  orbitRadius,
  phase,
  bodyScale = 1,
  parentBody,
  sessionId,
  active = false,
  onOpen,
  muted = false,
}: MoonProps) {
  const { openable, effectiveState } = moonInteraction(subagent, Boolean(onOpen && sessionId))

  const mix = useStateMix(MOON_STATES, effectiveState)
  const hueTween = useHueTween(hue)
  // 0 unmuted, 1 muted — the same tween the parent planet runs, so the two
  // fade together.
  const muteFade = useFadeTween(muted, STATE_TRANSITION_MS, STATE_TRANSITION_MS)
  const materials = useMoonMaterials()
  const hasGlowTexture = glowTexture() !== null

  /**
   * The disc + rim are drawn as unit geometry inside a group scaled to the
   * blended radius, so interpolating the size never rebuilds a geometry. The
   * rim's 1px band is normalised against the TARGET radius, which makes it
   * exact at rest (where the scale equals that radius) and lets it breathe by
   * a sub-pixel fraction only while a transition is actually running.
   */
  const targetDiscRadius = useMemo(() => moonVisuals(effectiveState).discRadius, [effectiveState])
  const rimInner = 1 - RIM_WIDTH / 2 / targetDiscRadius
  const rimOuter = 1 + RIM_WIDTH / 2 / targetDiscRadius

  const trailPoints = useMemo(() => circlePoints(orbitRadius, 64), [orbitRadius])

  /**
   * The radius eases across a change instead of snapping — the tier scale
   * (via `sceneModel`) and the context gauge's clearance both move it, and
   * the parent planet's own size is already tweened on this same curve
   * (docs/fixes/state-change-snaps-the-planet-scale.md, whose "Not covered"
   * note is exactly this). The trail's points stay memoised on the TARGET
   * radius; the frame loop scales its group by `value / orbitRadius`, so the
   * dash pattern is exact at rest and only stretches by the tween's own
   * fraction while a change is in flight — the same normalisation trick as
   * the rim above.
   */
  const radiusTween = useScaleTween(orbitRadius)

  // A moon is positioned from its parent planet, so it has to walk the same
  // path at the same pace — otherwise a retagged session leaves its moons
  // behind and they snap across afterwards.
  const parentMove = usePointTween(parentX, parentY)

  /**
   * The live design-px → CSS-px factor handed to `MoonControl` (see its
   * `scale` prop). React state, not a ref, because `MoonControl` is ordinary
   * DOM and only a re-render can resize it — but written from the frame loop
   * only when it has moved by more than `AFFORDANCE_SCALE_EPSILON`, so an
   * eased zoom (`useZoomTo`, which runs for a few hundred ms per press)
   * costs a bounded handful of re-renders per moon instead of one per frame.
   * A 1% step is far below what an eye can read on a 20px button and keeps
   * the whole 5→400 range inside ~300 discrete steps.
   */
  const [affordanceScale, setAffordanceScale] = useState(() =>
    bodyDesignPxToScreenPx(REFERENCE_ZOOM, bodyScale)
  )
  const affordanceScaleRef = useRef(affordanceScale)

  const parentGroupRef = useRef<THREE.Group>(null)
  const bodyGroupRef = useRef<THREE.Group>(null!)
  const tickGroupRef = useRef<THREE.Group>(null!)
  const discGroupRef = useRef<THREE.Group>(null!)
  const glowRef = useRef<THREE.Mesh>(null!)
  const coreRef = useRef<THREE.Mesh>(null!)
  const rippleRef = useRef<THREE.Mesh>(null!)
  const shellGroupRef = useRef<THREE.Group>(null)
  const shellLineRef = useRef<LineHandle>(null)
  const matRingRef = useRef<LineHandle>(null)
  const trailRef = useRef<LineHandle>(null)
  const trailGroupRef = useRef<THREE.Group>(null)
  const matElapsed = useRef(0)
  const rippleElapsed = useRef(0)
  /** Integrated rather than read off the clock: the blink's period is itself interpolating. */
  const corePhase = useRef(0)
  const hueColor = useRef(new THREE.Color())
  const blendRef = useRef(blendMoon(mix.weights, createMoonBlend()))
  const settled = useRef(false)
  // Mirrors `MoonControl`'s own hover/focus state for the material blend
  // below — a ref, not React state, because nothing here needs a re-render;
  // `applyState` reads it directly from the frame loop. `settled.current`
  // is force-cleared on every change so the NEXT frame recomputes
  // `applyState()` even when the state mix itself isn't moving (a settled
  // `idle` moon hovered by a motionless pointer would otherwise never
  // repaint its rim/core white at all).
  const scheduler = useFrameScheduler()
  const hoveredRef = useRef(false)
  const handleHoverChange = (next: boolean) => {
    hoveredRef.current = next
    settled.current = false
    // No render follows a hover, so nothing else would ask for the frame.
    scheduler?.request()
  }
  // Seeded from the `phase` prop once on mount, then advanced every frame in
  // useFrame — this is the moon's own running angle, not `phase` re-read
  // each render. `phase` only decides WHERE on the orbit each moon starts
  // (so multiple moons around one planet don't all launch from the same
  // point); it intentionally has no effect after the first render.
  const angle = useRef(phase)

  const applyState = () => {
    const w = mix.weights
    const b = blendRef.current
    // The search mute: the whole moon down by `mutedOpacity`, its hue toward
    // the ended grey — the same pair the parent planet applies.
    const mute = mutedOpacity(muteFade.value)
    const hueC = setOklchTagColor(hueColor.current, hueTween.value).lerp(GREY_COLOR, muteFade.value)
    const solid = 1 - b.materializing
    // Canvas 11e Hover: "white rim, brighter core, one outer halo ring" — the
    // ring/label are `MoonControl`'s own DOM (see `Moon`'s "INTERACTIVITY"
    // doc); the rim/core/glow brightening below is the one piece that has to
    // be three.js, because those materials are already driven from here.
    // `openable` gates it so a hover mirrored from an unwired caller (should
    // one ever exist) can never brighten a moon with no button to hover.
    const hoverAmt = openable && hoveredRef.current ? 1 : 0

    // 1f: the needs-input moon's glow is the white `0 0 10px #fff` on its core;
    // every other state glows in the tag hue off the disc.
    materials.glow.color.copy(hueC).lerp(WHITE_COLOR, w.needs_input)
    materials.glow.opacity = Math.min(1, b.glowOpacity * (hoverAmt ? MOON_HOVER_GLOW_BOOST : 1)) * mute
    materials.glow.visible = hasGlowTexture && b.glowOpacity > 0.001 && b.glowSize > 0
    if (glowRef.current) glowRef.current.scale.setScalar(b.glowSize)

    let r = 0
    let g = 0
    let bl = 0
    for (const state of MOON_STATES) {
      const weight = w[state]
      if (weight === 0) continue
      const c = DISC_COLORS[state]
      r += weight * c.r
      g += weight * c.g
      bl += weight * c.b
    }
    materials.disc.color.setRGB(r, g, bl)
    if (hoverAmt) materials.disc.color.lerp(WHITE_COLOR, MOON_HOVER_DISC_BRIGHTEN)
    materials.disc.opacity = solid * b.dim * mute
    materials.disc.visible = materials.disc.opacity > 0.001

    materials.rim.color.copy(hueC).lerp(GREY_COLOR, w.ended).lerp(WHITE_COLOR, hoverAmt)
    materials.rim.opacity = b.rimOpacity * solid * b.dim * mute
    materials.rim.visible = materials.rim.opacity > 0.001
    if (discGroupRef.current) discGroupRef.current.scale.setScalar(b.discRadius)

    materials.ticks.color.copy(hueC)
    materials.ticks.opacity = w.working * MOON_TICK_OPACITY * mute
    materials.ticks.visible = materials.ticks.opacity > 0.001

    materials.core.color.copy(hueC).lerp(WHITE_COLOR, Math.max(w.needs_input, hoverAmt))
    if (coreRef.current) coreRef.current.scale.setScalar(b.coreRadius)

    if (trailRef.current) {
      trailRef.current.material.color.copy(hueC).lerp(GREY_COLOR, w.ended)
      trailRef.current.material.opacity = b.trailOpacity * mute
    }
    if (shellLineRef.current) shellLineRef.current.material.color.copy(hueC)
    if (matRingRef.current) matRingRef.current.material.color.copy(hueC)
  }

  useFrameOnRender()

  // Always moving: a moon orbits for as long as it is on the map, whatever
  // its state, so a map with any moon draws at the cap.
  useMapFrame((state, delta) => {
    if (parentBody) {
      // The sim owns the parent's motion — the moon rides it 1:1, so a
      // dragged or walking planet never leaves its moons behind.
      if (parentGroupRef.current) {
        parentGroupRef.current.position.set(parentBody.x, parentBody.y, 0)
      }
    } else if (advancePointTween(parentMove, delta) && parentGroupRef.current) {
      parentGroupRef.current.position.set(parentMove.x.value, parentMove.y.value, 0)
    }

    if (parentGroupRef.current) {
      // Counter-zoom, same factor as the parent planet's — written on the
      // parent-anchored group so the trail, the orbit radius and the moon's
      // body inflate together as one system ("celý systém měsíce" per the
      // idea's brainstorm). The angular speed below reads the unscaled
      // `orbitRadius`, so the orbit's pace does not change with zoom.
      parentGroupRef.current.scale.setScalar(bodyZoomFactor(state.camera.zoom))
    }

    // The DOM affordance's own scale — the same three factors the disc above
    // is drawn through (`bodyZoomFactor`, `bodyScale`, `zoom`), since
    // `<Html>` is measured in CSS px and inherits none of them. Only mounted
    // moons need it, and only a real change is pushed through React.
    if (openable) {
      const nextScale = bodyDesignPxToScreenPx(state.camera.zoom, bodyScale)
      if (
        Math.abs(nextScale - affordanceScaleRef.current) >
        affordanceScaleRef.current * AFFORDANCE_SCALE_EPSILON
      ) {
        affordanceScaleRef.current = nextScale
        setAffordanceScale(nextScale)
      }
    }

    if (advanceTween(radiusTween, delta) && trailGroupRef.current) {
      trailGroupRef.current.scale.setScalar(radiusTween.value / orbitRadius)
    }
    const radius = radiusTween.value
    angle.current += (ORBIT_ANGULAR_SPEED / Math.max(radius, 0.01)) * delta
    const localX = radius * Math.cos(angle.current)
    const localY = radius * Math.sin(angle.current)
    if (bodyGroupRef.current) {
      bodyGroupRef.current.position.set(localX, localY, 0)
      // Appearance planet-size multiplier, body only — the trail and the
      // orbit radius above deliberately don't move with it (canvas 5a).
      bodyGroupRef.current.scale.setScalar(bodyScale)
    }

    const mixMoved = advanceStateMix(mix, delta)
    const hueMoved = advanceTween(hueTween, delta)
    const b = blendRef.current
    if (mixMoved) blendMoon(mix.weights, b)
    const muteMoved = advanceTween(muteFade, delta)
    if (mixMoved || hueMoved || muteMoved || !settled.current) applyState()
    settled.current = !(mixMoved || hueMoved || muteMoved)
    const mute = mutedOpacity(muteFade.value)

    if (b.tickSpin > 0 && tickGroupRef.current) {
      tickGroupRef.current.rotation.z += b.tickSpin * delta
    }

    corePhase.current += b.corePulseSec > 0 ? delta / b.corePulseSec : 0
    const blink = b.corePulse > 0 ? 1 - BLINK_DEPTH * b.corePulse * oscillate(corePhase.current, 1) : 1
    materials.core.opacity = b.coreOpacity * blink * b.dim * mute
    materials.core.visible = materials.core.opacity > 0.001 && b.coreRadius > 0

    if (b.ripple > 0.001) {
      rippleElapsed.current = (rippleElapsed.current + delta) % MOON_RIPPLE_DURATION_SEC
      const progress = easeOut(rippleElapsed.current / MOON_RIPPLE_DURATION_SEC)
      if (rippleRef.current) rippleRef.current.scale.setScalar(1 + progress * (MOON_RIPPLE_MAX_SCALE - 1))
      materials.ripple.opacity = MOON_RIPPLE_START_OPACITY * (1 - progress) * b.ripple * mute
      materials.ripple.visible = true
    } else {
      rippleElapsed.current = 0
      materials.ripple.visible = false
    }

    // The materializing look is a crossfade, not a blend: the dashed shell and
    // its expanding ring keep their own animation and are scaled in and out by
    // `b.materializing` against the solid disc.
    if (b.materializing > 0.001) {
      matElapsed.current += delta
      // `orb-mat 1.8s ease-in-out`: opacity .3 ↔ .95, scale .85 ↔ 1.
      const breath = oscillate(matElapsed.current, MAT_SHELL_SEC)
      const shellOpacity = MAT_SHELL_MIN_OPACITY + (MAT_SHELL_MAX_OPACITY - MAT_SHELL_MIN_OPACITY) * breath
      const shellScale = MAT_SHELL_MIN_SCALE + (MAT_SHELL_MAX_SCALE - MAT_SHELL_MIN_SCALE) * breath
      if (shellGroupRef.current) shellGroupRef.current.scale.setScalar(shellScale)
      if (shellLineRef.current) {
        shellLineRef.current.material.opacity = shellOpacity * 0.9 * b.materializing * mute
        shellLineRef.current.visible = true
      }
      materials.matFill.opacity = shellOpacity * MAT_FILL_ALPHA * b.materializing * mute
      materials.matFill.visible = true
      // `orb-matring 1.8s ease-out`: scale .6 → 2, opacity .8 → 0.
      const ringProgress = easeOut((matElapsed.current % MAT_RING_SEC) / MAT_RING_SEC)
      if (matRingRef.current) {
        matRingRef.current.scale.setScalar(
          MAT_RING_MIN_SCALE + ringProgress * (MAT_RING_MAX_SCALE - MAT_RING_MIN_SCALE)
        )
        matRingRef.current.material.opacity = MAT_RING_START_OPACITY * (1 - ringProgress) * b.materializing * mute
        matRingRef.current.visible = true
      }
    } else {
      matElapsed.current = 0
      materials.matFill.visible = false
      if (shellLineRef.current) shellLineRef.current.visible = false
      if (matRingRef.current) matRingRef.current.visible = false
    }
    return true
  })

  return (
    // The tween's (or the sim body's) current value, NOT the props — see `usePointTween`.
    <group
      ref={parentGroupRef}
      position={[parentBody?.x ?? parentMove.x.value, parentBody?.y ?? parentMove.y.value, 0]}
    >
      {/* Dashed orbit ring traced once around the parent planet's position
          (`1px dashed hue/.22` in 1f). The group's scale is the radius
          tween's current fraction of the target — see `radiusTween`. */}
      <group ref={trailGroupRef} scale={radiusTween.value / orbitRadius}>
        <Line
          ref={trailRef}
          points={trailPoints}
          lineWidth={1}
          dashed
          dashSize={0.05}
          gapSize={0.05}
          transparent
          opacity={0}
        />
      </group>

      <group ref={bodyGroupRef}>
        {hasGlowTexture && (
          <mesh ref={glowRef} position={[0, 0, -0.01]} material={materials.glow}>
            <planeGeometry args={[1, 1]} />
          </mesh>
        )}

        <group ref={discGroupRef}>
          <mesh material={materials.disc}>
            <circleGeometry args={[1, 24]} />
          </mesh>
          <mesh material={materials.rim}>
            <ringGeometry args={[rimInner, rimOuter, 32]} />
          </mesh>
        </group>

        <group ref={shellGroupRef}>
          <mesh material={materials.matFill}>
            <circleGeometry args={[MAT_RADIUS, 24]} />
          </mesh>
          <Line
            ref={shellLineRef}
            points={MAT_SHELL_POINTS}
            lineWidth={1}
            dashed
            dashSize={0.03}
            gapSize={0.03}
            transparent
            opacity={0}
          />
        </group>

        <Line ref={matRingRef} points={MAT_RING_POINTS} lineWidth={1} transparent opacity={0} />

        <group ref={tickGroupRef}>
          <TickRing
            count={MOON_TICK_COUNT}
            radius={MOON_TICK_RADIUS}
            widthDeg={MOON_TICK_WIDTH_DEG}
            length={MOON_TICK_LENGTH}
            material={materials.ticks}
          />
        </group>

        {/* Unit circle scaled to the blended core radius — see Planet.tsx. */}
        <mesh ref={coreRef} position={[0, 0, 0.01]} material={materials.core}>
          <circleGeometry args={[1, 20]} />
        </mesh>

        <mesh ref={rippleRef} position={[0, 0, 0.02]} material={materials.ripple}>
          <ringGeometry args={[MOON_RIPPLE_INNER, MOON_RIPPLE_OUTER, 32]} />
        </mesh>

        {/* Openable only — an inert moon (no `toolUseId`) mounts nothing
            here at all, which is what keeps it out of the tab order (task 9
            brief item 4/keyboard) without any extra tabIndex bookkeeping.
            `center` puts the control's own centre on the moon's; its SIZE
            comes from `scale`, because `<Html>` is CSS px and the moon is
            not — see `Moon`'s "INTERACTIVITY" doc. */}
        {openable && (
          <Html center zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}>
            <MoonControl
              subagent={subagent}
              active={active}
              // Design px (`moonPx` is `designPx * 0.01`, `visuals.ts`), the
              // unit `scale` converts from — never pre-multiplied here, so
              // the two arrive as a value and its unit rather than as one
              // number nobody can check.
              discPx={targetDiscRadius * 100}
              scale={affordanceScale}
              onOpen={() => onOpen?.(sessionId as string, subagent)}
              onHoverChange={handleHoverChange}
            />
          </Html>
        )}
      </group>
    </group>
  )
}
