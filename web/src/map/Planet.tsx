import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentRef, type RefObject } from 'react'
import type { ThreeEvent } from '@react-three/fiber'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { ApiSession } from '../lib/types'
import { sessionStateKey, statePill, type SessionStateKey } from '../lib/types'
import {
  STATE_INPUT_HEX,
  stateBorder,
  stateColor,
  stateDot,
  type MapStatePills,
} from '../lib/stateStyle'
import { StateDot } from '../ui/StateDot'
import {
  BADGE_OFFSET_X,
  BADGE_OFFSET_Y,
  BODY_RADIUS,
  BRACKET_INSET,
  COMPACT_BADGE_OFFSET_X,
  COMPACT_BADGE_OFFSET_Y,
  CONTEXT_GAUGE_OUTER,
  DIMMED_OPACITY,
  HALO_BREATH_MIN,
  HALO_BREATH_SEC,
  LABEL_FAMILY_GAP_PX,
  LABEL_FAMILY_TRACKING_EM,
  LABEL_TITLE_TRACKING_EM,
  STATE_PILL_BORDER_PX,
  STATE_DISC_DOT_PX,
  STATE_DISC_HEIGHT_PX,
  STATE_DISC_PAD_X_PX,
  STATE_PILL_DOT_PX,
  STATE_PILL_FONT_PX,
  STATE_PILL_GAP_PX,
  STATE_PILL_HOLLOW_DOT_PX,
  STATE_PILL_PAD_X_PX,
  STATE_PILL_PAD_Y_PX,
  STATE_PILL_TRACKING_EM,
  easeOut,
  labelRestY,
  oscillate,
  truncateLabel,
  typedLabel,
} from './visuals'
import {
  ENDED_HIDE_MS,
  PLANET_STATES,
  PLANET_TICK_LAYERS,
  RETICLE_ENTER_MS,
  RETICLE_EXIT_MS,
  RETICLE_LINGER_GRACE_MS,
  STATE_TRANSITION_MS,
  advancePointTween,
  advanceStateMix,
  advanceTween,
  blendPlanet,
  easeMotion,
  createPlanetBlend,
  endedHideTransform,
  labelUnderReticle,
  mutedOpacity,
  prefersReducedMotion,
  reticleEnterScale,
  selectionLabelOpacity,
  stackAlphas,
  tickLayerWeight,
  useFadeTween,
  useHueTween,
  useLingering,
  usePointTween,
  useScaleTween,
  useStateMix,
} from './transition'
import { glowTexture, bodyTexture, bodyIdleTexture } from './textures'
import { bodyZoomFactor } from './camera'
import type { SimBody } from './simulation'
import { useFrameOnRender, useMapFrame } from './FrameBudget'
import type { ContextFill } from './sceneModel'
import { DetachGlyph } from '../ui/UtilityButton'
import {
  COMPACTED_CAPTION_MS,
  COMPACTING_SWITCH_MS,
  compactingLabelOpacity,
  formatCompactTokens,
  formatElapsed,
} from '../lib/compaction'
import {
  CONTEXT_CRITICAL_OKLCH,
  contextLevelOklch,
  oklchCss,
  type ContextThresholds,
  type Oklch,
} from '../lib/usage'

/**
 * Flat 2D parametric planet for the orthographic top-down space map.
 * Pure props in, no store/api imports — Task 9 wires this to live data.
 *
 * BINDING rule: hue (via `oklchTagColor`) always paints the atmosphere ring
 * and (for non-ended states) the bright core; session STATE is expressed
 * only through `planetVisuals` (tick spin, core blink, halo breathing,
 * ripple) plus a white core/ripple for needs-input — never by picking a
 * different hue.
 *
 * Layout per the "2d Instrument" canvas variant (`Planet Variants.dc.html`
 * on the Claude Design canvas) and the state sheet (artboard 1f in
 * `Orbital.dc.html`):
 * a dark matte body disc inside a rotating tick ring, with a thin
 * counter-rotating 4-arc inner ring and a small bright core — reads as a
 * gauge, not a ball.
 *
 * STATE CHANGES CROSSFADE (see `transition.ts`). The consequence for this
 * file: every state-dependent layer is mounted ALL the time and its
 * appearance is written onto a component-owned material inside `useFrame`,
 * rather than being mounted/unmounted by React and configured through JSX
 * props. Two rules fall out of that and must hold:
 *
 *   1. Materials are created once per planet (`usePlanetMaterials`) and
 *      handed to meshes via the `material` prop. Nothing passes `color` or
 *      `opacity` as a JSX prop on a state-dependent layer — R3F would
 *      re-apply it on the next render and stamp over the frame loop's value.
 *   2. The frame loop allocates nothing. Colours are mutated in place, the
 *      blend writes into a hoisted object, and a planet at rest does no
 *      blend work at all (`advanceStateMix` returns false immediately).
 *
 * Layers that would otherwise be invisible are switched off with
 * `material.visible`, so an idle planet costs no more draw calls than before.
 */

// --- geometry constants (local units, before the `scale` prop is applied) --
// Transcribed from artboard 1f, whose five planets share a 100px body (50px
// radius) drawn here at BODY_RADIUS; `px()` below converts the export's own
// `inset:`/size values into scene units.

/** designPx → scene units, against 1f's 50px body radius. */
const px = (designPx: number) => (designPx / 50) * BODY_RADIUS

/** Ended body: flat `oklch(16% .01 230)` per the canvas, no gradient. */
const BODY_ENDED_LIGHTNESS = 0.16
const BODY_ENDED_CHROMA = 0.01
const BODY_ENDED_HUE = 230

/** 1px hue border straddling the body edge; alpha varies by state (1f: .6 working, .45 idle/needs-input, grey .35 ended). */
const BORDER_INNER = px(49.5)
const BORDER_OUTER = px(50.5)
const BORDER_OPACITY_ACTIVE = 0.6
const BORDER_OPACITY_IDLE = 0.45
const BORDER_OPACITY_ENDED = 0.35

/** Working body's `inset 0 0 0 6px rgba(0,0,0,.25)` — a dark rim inside the edge. */
const INNER_SHADE_INNER = px(50 - 6)
const INNER_SHADE_OUTER = px(50)
const INNER_SHADE_OPACITY = 0.25

/**
 * Breathing halo: `radial-gradient(circle, transparent 58%, hue/.18 72%,
 * transparent 80%)` on the inset -28 box (78px radius) → a band from 45px
 * to 62px, peaking at 56px.
 */
const HALO_RING_INNER = px(0.58 * 78)
const HALO_RING_OUTER = px(0.8 * 78)

/** Working body glow, `box-shadow: 0 0 22px hue/.25` → reaches 22px past the 50px edge. */
const GLOW_SIZE = px(2 * (50 + 22))
const GLOW_OPACITY = 0.25

/** Needs-input core glow, `0 0 14px rgba(255,255,255,.9), 0 0 30px hue/.6` around the 16px core. */
const CORE_GLOW_WHITE_SIZE = px(2 * (8 + 14))
const CORE_GLOW_WHITE_OPACITY = 0.9
const CORE_GLOW_HUE_SIZE = px(2 * (8 + 30))
const CORE_GLOW_HUE_OPACITY = 0.6

/** Thin inner arc ring: 4 × 60° arcs on a 90° pitch, inset -14 with a 2px mask band. */
const ARC_RING_INNER = px(64 - 2)
const ARC_RING_OUTER = px(64)
const ARC_COUNT = 4
const ARC_SWEEP_DEG = 60
const ARC_PITCH_DEG = 90

/** `orb-blink` keyframes: opacity 1 → .3 → 1. */
const BLINK_DEPTH = 0.7

/** `orb-pulse-out 2.4s ease-out`: scale 1 → 1.9, opacity .9 → 0, at the idle tick ring's radius (inset -21).
 * Amber `--state-input` (`STATE_INPUT_HEX`), not white: the ring says "you are
 * being waited for", a state signal, so it takes the state colour rather than
 * the tag hue (spec 2026-09-24-state-colours-design). */
const RIPPLE_MAX_SCALE = 1.9
const RIPPLE_DURATION_SEC = 2.4
const RIPPLE_START_OPACITY = 0.9
const RIPPLE_INNER = px(71 - 1)
const RIPPLE_OUTER = px(71)

/**
 * Selection reticle (1f, "Selected": `Any state + slow dashed reticle and
 * corner brackets`). The export's markup is a dashed ring at `inset:-42px`
 * carrying `animation: orb-spin 160s linear infinite`, followed by four
 * `10px` `1.5px solid #fff` corner spans at `±50px` which are SIBLINGS of
 * that ring and carry no animation of their own — so the ring turns and the
 * brackets stand still. They are therefore built as two groups here, and
 * only the ring group is rotated.
 */
const RETICLE_RADIUS = px(92)
/**
 * One revolution every 160 seconds — `animation: orb-spin 160s linear
 * infinite` on the dashed ring in `Orbital.dc.html`.
 *
 * This read 40s until it was checked against the canvas, which turns the ring
 * four times faster than designed and is a large part of why a selected
 * planet read as busy. No `orb-spin 40s` exists anywhere in the canvas; the
 * number was mis-transcribed rather than moved.
 */
const RETICLE_SPIN_SPEED = (Math.PI * 2) / 160
const RETICLE_DASH_SIZE = 0.08
const RETICLE_DASH_GAP = 0.06
const RETICLE_COLOR = '#e6f5ff'
const RETICLE_OPACITY = 0.7
// BRACKET_INSET (the `±50px` corner spans) is in `visuals.ts`: the simulation measures it.
const BRACKET_LENGTH = px(10)

/** Ended grey — `rgba(200,215,235)` in the canvas export. */
const GREY = '#c8d7eb'
const WHITE = '#ffffff'
const BLACK = '#000000'

/** Scratch colours for the per-frame hue → grey / hue → white mixes. Module-level and used synchronously, so one pair serves every planet without allocating. */
const GREY_COLOR = new THREE.Color(GREY)
const WHITE_COLOR = new THREE.Color(WHITE)

/**
 * The label is anchored by its TOP edge, which is what the export measures:
 * `top: calc(100% + 34px)` sits the text 34px under the body box, not its
 * centre. That also keeps the gap honest at every zoom — `<Html>` draws at a
 * fixed 11px, so half a line of text is a different number of world units at
 * every zoom level, and a centred anchor would let the gap drift with it.
 *
 * A gauged planet drops the label below the gauge's tick ring instead of the
 * body edge, keeping the same 34px gap — at the rest offset the label sits
 * inside the ring band and the title reads through the arc. Same discrete
 * switch as the badges' `clearsGauge` offsets (owner ruling, no canvas
 * value: 1i draws gauged planets with spec-sheet captions, not map labels).
 *
 * A selected planet drops it below the reticle's bracket square the same
 * way, for the same reason: at the rest offset the bottom brackets run
 * through the title. `labelRestY` in `visuals.ts` picks the lowest of the
 * three, and the simulation measures the label from the same function, so a
 * neighbour keeps clear of the label where it actually hangs.
 *
 * The selection drop never slides. The label used to slide clear of the
 * brackets on the reticle's fade, and the label was then the one thing in
 * the frame NOT fading — so the text slid at full strength while the ring
 * dissolved, and the eye followed it. Now the label fades out where it is,
 * jumps while invisible and fades in at the new place, all on the reticle's
 * own fade (`labelUnderReticle` / `selectionLabelOpacity` in
 * `transition.ts`). The canvas is silent on it: 1f draws the reticle on a
 * planet with no title under it. See
 * `docs/fixes/selection-reticle-drags-the-label.md`.
 *
 * The label group's `y` is a frame-loop write, not a JSX prop — the handoff
 * happens mid-tween, where no render is — so there is exactly one owner.
 */
// LABEL_TOP_REST_Y, LABEL_GAUGED_REST_Y and LABEL_SELECTED_REST_Y are in `visuals.ts`.
const LABEL_COLOR_ACTIVE = 'rgba(220,235,255,.85)'
const LABEL_COLOR_DIMMED = 'rgba(160,190,225,.6)'
/** Family line under the title (canvas 4a). Subordinate to the name in both states. */
const LABEL_MODEL_COLOR = 'rgba(160,190,225,.7)'

/**
 * Hover-expanded label (idea doc `expand-a-planet-label-on-hover`). The
 * canvas draws no hover states anywhere, so every value in this block is a
 * judgement call, not a transcription: the enter/exit fades, the wrap
 * width, the scrim. The typing pace lives beside `typedLabel` in
 * `visuals.ts`.
 */
const HOVER_LABEL_ENTER_MS = 160
const HOVER_LABEL_EXIT_MS = 120
const HOVER_LABEL_MAX_WIDTH_PX = 240
const HOVER_LABEL_SCRIM = 'rgba(4,8,16,.85)'

/**
 * Per-layer z offsets so the (visually transparent) halo never composites
 * OVER the opaque body/core — everything otherwise sits at the group's
 * local origin (z=0), which would let render order + alpha blending paint
 * the halo on top of, say, a white needs-input core and hue-tint it.
 * Ordered back (halo, furthest) to front (ripple/reticle, closest).
 */
const HALO_Z = -0.02
const BODY_Z = 0
const CORE_GLOW_Z = 0.005
const CORE_Z = 0.01
const RIPPLE_Z = 0.02
const RETICLE_Z = 0.02
/**
 * The context gauge is outside every other layer radially, so nothing but the
 * expanding needs-input ripple ever crosses it; sat just behind the ripple so
 * that sweep passes OVER the arc rather than being cut by it.
 */
const CONTEXT_GAUGE_Z = 0.015

/**
 * The three body fills (flat ended / idle gradient / working gradient) are
 * coplanar and all transparent, which leaves three.js no stable way to order
 * them. Tiny z steps behind `BODY_Z` fix the painting order back-to-front
 * without moving the body off the border and tick rings that sit at BODY_Z.
 */
const BODY_ENDED_Z = -0.003
const BODY_IDLE_Z = -0.002
const BODY_WORKING_Z = -0.001

// BADGE_OFFSET_X / BADGE_OFFSET_Y are in `visuals.ts`: the simulation measures the pill from them.

/**
 * The "in its own window" badge (canvas `Feature - Detached window` 22e):
 * 22e's `right: -22px; top: -22px` off the body box of the mock's 96px
 * planet, normalised to a 100px body — but mirrored to the bottom-right
 * corner, where it stays clear of the state pill (Tomin, 2026-09-24). That
 * is the badge's bottom-RIGHT corner, so the badge hangs left and up from
 * it, above the label. Anchored to the body, outside the rings; the scene scale carries the offset with the planet's size while the
 * badge itself stays a fixed number of screen px.
 */
const DETACH_BADGE_CORNER = px((48 + 22) * (50 / 48))
/** The badge's box and its ink, verbatim from 22e. Neutral, never the tag hue. */
const DETACH_BADGE_PX = 20
const DETACH_BADGE_BG = 'rgba(5,7,13,.85)'
const DETACH_BADGE_INK = 'rgba(230,245,255,.7)'
/** A click on the planet focuses the window; the badge answers with one flash (22e). */
const DETACH_BADGE_FLASH_INK = '#e8eef8'
const DETACH_BADGE_FLASH_MS = 160
/** The window closed: the badge goes, and nothing else moves (22e). */
const DETACH_BADGE_EXIT_MS = 200

/**
 * Context gauge — artboard 1i, read against 1f's 100px body.
 *
 * 1i draws each planet at a size derived from its own context (the part of
 * that artboard this feature deliberately does NOT implement), so every
 * `inset:` there has to be normalised by that planet's diameter before it
 * means anything here. All four gauged planets agree once normalised: the
 * fill ring's radius reads 90.5 / 90.2 / 89.6 / 89.6 design px across the
 * 79, 92, 101 and 106px planets, and the tick ring sits 2px outside it
 * every time.
 *
 * The fill ring is the `inset:-Npx` layer masked with
 * `transparent calc(100% - 3px), #000 calc(100% - 2px)` — a 2px opaque band
 * inside its radius, which is the "2 px arc" the brief asks for. The tick
 * layer's mask is 7px/6px, so its marks are 6px long and straddle the fill
 * ring: 2px outside it, 2px inside.
 */
const CONTEXT_FILL_OUTER = px(90)
const CONTEXT_FILL_INNER = px(88)
// The tick ring's outer edge is the gauge's outermost extent, so it lives in
// `visuals.ts` — the scene model keeps moon orbits clear of it.
const CONTEXT_TICK_OUTER = CONTEXT_GAUGE_OUTER
const CONTEXT_TICK_INNER = px(86)
/** Each threshold mark is a 2° slice (`179deg 181deg`, `287deg 289deg`). */
const CONTEXT_TICK_WIDTH_DEG = 2
/** Unfilled track `rgba(190,225,255,.1)`, marks `rgba(240,248,255,.8)`. */
const CONTEXT_TRACK_COLOR = '#bee1ff'
const CONTEXT_TRACK_OPACITY = 0.1
const CONTEXT_TICK_COLOR = '#f0f8ff'
const CONTEXT_TICK_OPACITY = 0.8
/** Below the first threshold the fill is the tag hue at `/ 0.6`; past it, opaque. */
const CONTEXT_OK_OPACITY = 0.6
/**
 * Past the second threshold the arc pulses on the canvas's own `orb-ring`
 * keyframe — the same opacity swing as the halo's breath (hence
 * `HALO_BREATH_MIN`), run at 1.6s instead of 2.4s.
 */
const CONTEXT_PULSE_SEC = 1.6
/**
 * Arrival/departure of the whole gauge. The canvas never draws one appearing
 * (its planets just have one), so this is a judgement call: the state
 * crossfade's duration, so a session that ends dissolves its gauge on the
 * same beat as everything else about it changes.
 */
const CONTEXT_FADE_MS = STATE_TRANSITION_MS

// `/compact` pill: on the same 45° diagonal as the needs-input pill, further
// out because the gauge ring occupies the space that one sits in. The
// offsets, COMPACT_BADGE_OFFSET_X / _Y, are in `visuals.ts` next to
// BADGE_OFFSET_X.

/**
 * The command the badge sends, and the text it shows for it — exported so
 * the caller that actually sends it cannot drift from the word on the pill.
 */
export const COMPACT_COMMAND = '/compact'
/** The command's own colour inside the pill — 1i's `oklch(80% .15 25)`, a
 * lighter red than the border's, so the word reads before the percentage. */
const COMPACT_COMMAND_OKLCH: Oklch = { lightness: 0.8, chroma: 0.15, hue: 25 }

// --- context compaction (canvas `Feature - Context compaction` 26b, 26e) --
// While a session compacts, the planet takes the idle body (ticks still, no
// halo), its core turns into a hollow ring, the arc greys, and two grey rings
// contract inward onto the body (spec 2026-09-28-context-compaction-design).

/** The hollow core: 26b's `border: 1.5px solid` tag hue at .75, on its 16px core. */
const COMPACT_CORE_OUTER = px(8)
const COMPACT_CORE_INNER = px(8 - 1.5)
const COMPACT_CORE_OPACITY = 0.75
/** The greyed arc: `rgba(200,215,235,.3)` (GREY at .3), and the threshold marks at `opacity: .3`. */
const COMPACT_ARC_OPACITY = 0.3
const COMPACT_TICKS_FACTOR = 0.3
/**
 * The condensing rings: `inset: arcIn` — the context fill ring's own radius
 * — with a 1.5px `rgba(214,228,246,.8)` border, drawn in to `scale(.56)`,
 * which is the body's edge.
 */
const CONDENSE_OUTER = CONTEXT_FILL_OUTER
const CONDENSE_INNER = px(90 - 1.5)
const CONDENSE_COLOR = '#d6e4f6'
const CONDENSE_OPACITY = 0.8
const CONDENSE_END_SCALE = 0.56
/** `orb-condense 3.2s`; the second ring runs half a cycle (1.6 s) off the first. */
const CONDENSE_PERIOD_SEC = 3.2
/**
 * `orb-condense`'s opacity keyframes (0 → .9 at 18 % → .6 at 70 % → 0), each
 * segment eased by the animation's `cubic-bezier(.45,0,.7,.5)`, as CSS eases
 * every keyframe interval. The scale has only its two ends.
 */
const CONDENSE_STOPS = [0, 0.18, 0.7, 1] as const
const CONDENSE_VALUES = [0, 0.9, 0.6, 0] as const
/**
 * 26b's `box-shadow: 0 0 10px rgba(214,228,246,.25)`, inside and out, as a
 * wider faint band under each ring — a flat ring cannot blur.
 */
const CONDENSE_GLOW_INNER = px(90 - 6)
const CONDENSE_GLOW_OUTER = px(90 + 4)
const CONDENSE_GLOW_OPACITY = 0.12
/** After a success the arc drains to its new value (26e: 700 ms). */
const ARC_DRAIN_MS = 700
/** 26e "map pill": `COMPACTING` in the compacting grey over a .22 hairline. */
const COMPACTING_PILL_BORDER = 'rgba(150,205,255,.22)'
const COMPACTING_PILL_INK = 'rgba(214,228,246,.85)'
/** Both pills' second word — the timer, the percentage. */
const PILL_SUB_INK = 'rgba(160,190,225,.6)'
/** 26e "failure badge": the /compact badge's red border, a lighter red word. */
const COMPACT_FAILED_INK = 'oklch(80% .12 25)'
/** 26b's caption under the label after a success: 9.5px at .08em. */
const COMPACTED_CAPTION_INK = 'rgba(200,220,245,.75)'

/** One axis of a cubic Bézier with endpoints (0,0) and (1,1). */
function bezierAxis(t: number, p1: number, p2: number): number {
  const u = 1 - t
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t
}

/** `cubic-bezier(.45,0,.7,.5)` at `x`, by bisection (x is monotonic). */
function condenseEase(x: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (bezierAxis(mid, 0.45, 0.7) < x) lo = mid
    else hi = mid
  }
  return bezierAxis((lo + hi) / 2, 0, 0.5)
}

/** Where one condensing ring stands at `phase` cycles: written into `out`, allocation-free. */
function condenseAt(phase: number, out: { opacity: number; scale: number }): void {
  const t = phase - Math.floor(phase)
  out.scale = 1 + (CONDENSE_END_SCALE - 1) * condenseEase(t)
  for (let i = 0; i < CONDENSE_STOPS.length - 1; i++) {
    if (t > CONDENSE_STOPS[i + 1]) continue
    const local = (t - CONDENSE_STOPS[i]) / (CONDENSE_STOPS[i + 1] - CONDENSE_STOPS[i])
    out.opacity = CONDENSE_VALUES[i] + (CONDENSE_VALUES[i + 1] - CONDENSE_VALUES[i]) * condenseEase(local)
    return
  }
  out.opacity = 0
}

export interface PlanetProps {
  session: ApiSession
  /** Tag hue (oklch hue angle, 0-360); state never changes this. */
  hue: number
  x: number
  y: number
  /**
   * Tier scale from the layout (`ACTIVE_SCALE`/`IDLE_SCALE`/`ENDED_SCALE`).
   * Tweened inside on the state-change curve, because the layout ties it to
   * `session.status` — passing a new value snaps nothing (see
   * `useScaleTween`).
   */
  scale: number
  /**
   * The Appearance `planet_scale` slider — kept OUT of the tween so a drag
   * tracks the pointer 1:1 instead of easing a state-transition behind it.
   */
  scaleMultiplier?: number
  selected: boolean
  /**
   * Leaving the map (`ScenePlanet.leaving`): the session ended, or an ended
   * one lost its pin. Fades and shrinks out in place (canvas 2a's ENDED
   * suppression) rather than unmounting, so an Undo brings it back the same
   * way; the scene drops it once the fade has played.
   */
  hidden?: boolean
  /**
   * The session does not match the sidebar tag filter or search. Drawn in place at
   * `MUTED_OPACITY` and desaturated toward the ended grey, faded on the
   * state-change curve (ADR `search-mutes-planets-instead-of-hiding-them`).
   */
  muted?: boolean
  /**
   * Second label line, family only (`Opus`) — null when the map's model
   * toggle is off or the session's model matches no catalog row.
   */
  modelFamily?: string | null
  /**
   * Label font sizes from `labelFontPx` — the canvas's 11/9.5px unless the
   * Appearance "scale labels with bodies" toggle multiplies them (floored;
   * canvas 5a). Computed by the caller so the floor logic lives in one place.
   */
  labelTitlePx?: number
  labelFamilyPx?: number
  /**
   * How full this session's context window is, or null for no gauge at all
   * — `contextFillFor` in `sceneModel.ts` decides which, master toggle
   * included. The arc fades out rather than popping when it becomes null.
   */
  contextFill?: ContextFill | null
  /**
   * Where the gauge's two threshold marks sit. Absent (the sandbox, tests)
   * draws the arc without marks rather than inventing a pair here — the
   * defaults live in the store, with the settings that produce them.
   */
  contextThresholds?: ContextThresholds
  /** `map_show_compact_badge`, already AND-ed with the master toggle by the caller. */
  showCompactBadge?: boolean
  /**
   * Sends `/compact` to the session. The caller owns whether that is
   * possible at all right now (`SpaceMap`), for the same reason the composer
   * does: this component knows nothing about the store.
   */
  onCompact?: (sessionId: string) => void
  /**
   * When the session's compaction started (epoch ms), or null — `compactingOf`
   * via the scene model, which is where "it outranks working, loses to needs
   * input, never on a terminal planet" is decided. The start time is what
   * phases the condensing rings, so planets compacting together never pulse
   * in step.
   */
  compactingSince?: number | null
  /** The `COMPACT FAILED` badge was clicked: open the session at its mark. */
  onCompactFailedClick?: (sessionId: string) => void
  onClick?: (sessionId: string) => void
  /**
   * How the state pill is drawn (`map_state_pills`): a resting dot that
   * spells its word out on hover, or the word always (canvas 24e / 24a).
   */
  statePills?: MapStatePills
  /**
   * A click on the dot-mode disc. The disc takes the pointer so it can be
   * hovered, which keeps the click away from the canvas underneath — this is
   * how it still selects its planet.
   */
  onPillClick?: (sessionId: string) => void
  /**
   * The session is open in a detached window (spec:
   * 2026-09-23-detached-session-windows-design) — the planet wears the badge
   * that says so, and a click flashes it on its way to focusing the window.
   */
  detached?: boolean
  /**
   * The planet's body in the tag-cluster simulation. When present, the frame
   * loop reads the LIVE position off it every frame
   * instead of tweening the `x`/`y` props — the sim owns all motion,
   * including the retag walk. The object is mutated in place by the sim and
   * keeps a stable identity, so it never causes re-renders. Absent in the
   * sandbox and unit tests, where the props position stands.
   */
  simBody?: SimBody
  /**
   * Starts a body drag (canvas 4a). Fired from pointer-down on the planet's
   * meshes; the drag itself (threshold, capture, drop-on-the-hole) lives in
   * `SpaceMap`, which owns the pointer and the camera.
   */
  onBodyPointerDown?: (sessionId: string, e: ThreeEvent<PointerEvent>) => void
}

/**
 * Writes the app's `tagColor(hue)` (`oklch(<lightness> <chroma> <hue>)`) into
 * an existing THREE.Color. three@0.162's `Color.setStyle` does not parse
 * `oklch()` strings, so the OKLCH -> linear-sRGB math (Björn Ottosson's
 * OKLab) is inlined here rather than passing the CSS string straight into a
 * material.
 *
 * Mutating form: the hue tween recomputes this every frame while a session is
 * being retagged, and a planet that allocated a Color per frame would hand
 * the GC 50+ objects a frame across the map.
 *
 * The matrices below produce LINEAR sRGB primaries — three's default
 * working color space — so the result is loaded via
 * `THREE.LinearSRGBColorSpace` (a no-op copy). Loading it as
 * `THREE.SRGBColorSpace` instead would tell three the values are still
 * gamma-encoded and re-linearize them, darkening every color and shifting
 * its hue (pinned by `colors.test.ts` against independently computed CSS
 * Color 4 reference hex values).
 */
export function setOklchTagColor(
  target: THREE.Color,
  hue: number,
  lightness = 0.8,
  chroma = 0.13
): THREE.Color {
  const hRad = (hue * Math.PI) / 180
  const a = chroma * Math.cos(hRad)
  const b = chroma * Math.sin(hRad)

  const l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
  const m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
  const s_ = lightness - 0.0894841775 * a - 1.291485548 * b

  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s

  target.setRGB(
    THREE.MathUtils.clamp(r, 0, 1),
    THREE.MathUtils.clamp(g, 0, 1),
    THREE.MathUtils.clamp(bl, 0, 1),
    THREE.LinearSRGBColorSpace
  )
  return target
}

/** Allocating form of `setOklchTagColor`, for one-off/static colours. */
export function oklchTagColor(hue: number, lightness = 0.8, chroma = 0.13): THREE.Color {
  return setOklchTagColor(new THREE.Color(), hue, lightness, chroma)
}

/** Flat ended-body color (`oklch(16% .01 230)` in the canvas) — active bodies use `bodyTexture()`. */
const BODY_ENDED_COLOR = oklchTagColor(BODY_ENDED_HUE, BODY_ENDED_LIGHTNESS, BODY_ENDED_CHROMA)

/**
 * Radial ring of thin instanced tick marks; rotated as a group in useFrame.
 * Exported so `Moon.tsx` reuses the same primitive for its micro tick ring.
 *
 * `widthDeg` is the export's angular tick width (the "on" slice of its
 * `repeating-conic-gradient`); the chord it subtends at `radius` is the
 * plane's width, so a tick keeps the design's duty cycle at any radius.
 *
 * The material is supplied by the caller rather than declared here: a tick
 * ring is one of the crossfaded layers, so its owner drives its opacity and
 * colour from the frame loop.
 */
export function TickRing({
  count,
  radius,
  widthDeg,
  length,
  material,
}: {
  count: number
  radius: number
  widthDeg: number
  length: number
  material: THREE.Material
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null!)
  const width = radius * widthDeg * (Math.PI / 180)

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D()
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2
      dummy.position.set(radius * Math.cos(angle), radius * Math.sin(angle), 0)
      // planeGeometry's long axis (length, local Y) defaults to pointing at
      // 90°; adding 90° here aligns it with the radius direction at this
      // tick's own placement angle, so ticks read as radial "clock marks"
      // (matching the canvas) rather than tangential dashes.
      dummy.rotation.z = angle + Math.PI / 2
      dummy.updateMatrix()
      meshRef.current.setMatrixAt(i, dummy.matrix)
    }
    meshRef.current.instanceMatrix.needsUpdate = true
  }, [count, radius])

  return (
    <instancedMesh ref={meshRef} material={material} args={[undefined, undefined, count]}>
      <planeGeometry args={[width, length]} />
    </instancedMesh>
  )
}

/**
 * The thin inner instrument ring:
 * `repeating-conic-gradient(hue/.5 0 60deg, transparent 60deg 90deg)` masked
 * to a 2px band at inset -14, spinning `orb-spin 60s linear infinite reverse`
 * (artboard 1f / 1a / 2d). Four 60° arcs with 30° gaps, counter-rotating
 * against the tick ring.
 *
 * All four arcs share ONE material, so the frame loop fades the ring in and
 * out with a single write.
 */
export function ArcRing({ material }: { material: THREE.Material }) {
  return (
    <>
      {Array.from({ length: ARC_COUNT }, (_, i) => (
        <mesh key={i} material={material}>
          <ringGeometry
            args={[
              ARC_RING_INNER,
              ARC_RING_OUTER,
              48,
              1,
              (i * ARC_PITCH_DEG * Math.PI) / 180,
              (ARC_SWEEP_DEG * Math.PI) / 180,
            ]}
          />
        </mesh>
      ))}
    </>
  )
}

/**
 * Angle of a point `percent` of the way round the gauge, in three's own
 * convention (0 = 3 o'clock, counter-clockwise positive).
 *
 * The canvas draws the gauge as `conic-gradient(from -90deg, …)`: it starts
 * at 12 o'clock and runs CLOCKWISE, which is the opposite direction from
 * everything `ringGeometry` measures — hence the subtraction.
 */
function gaugeAngle(percent: number): number {
  return Math.PI / 2 - (percent / 100) * Math.PI * 2
}

/**
 * The context gauge (artboard 1i): a 2px ring split between the filled arc
 * (clockwise from 12 o'clock) and the unfilled track, with the two threshold
 * marks 2px further out — which the canvas shows even on a planet at 0 %
 * fill, so the scale is readable before there is anything on it.
 *
 * Geometry, not shader tricks, because the sweep and the marks both change
 * only when the data does (a turn ends, a threshold is edited), never per
 * frame. Materials come from the parent for the usual reason: the frame loop
 * owns their opacity and colour.
 */
function ContextGauge({
  fraction,
  thresholds,
  trackMaterial,
  fillMaterial,
  tickMaterial,
}: {
  fraction: number
  thresholds?: ContextThresholds
  trackMaterial: THREE.Material
  fillMaterial: THREE.Material
  tickMaterial: THREE.Material
}) {
  const drained = useDrainedFraction(fraction)
  const sweep = drained * Math.PI * 2
  const tickWidth = (CONTEXT_TICK_WIDTH_DEG * Math.PI) / 180
  // Track and fill divide the ring between them rather than stacking, the
  // way the canvas's single conic gradient does — two overlapping
  // transparent layers would tint the filled arc with the track underneath
  // it, which is visible at the 0.6 alpha the `ok` level is drawn at.
  const track = Math.PI * 2 - sweep
  return (
    <group position={[0, 0, CONTEXT_GAUGE_Z]}>
      {track > 0 && (
        <mesh material={trackMaterial}>
          <ringGeometry
            args={[
              CONTEXT_FILL_INNER,
              CONTEXT_FILL_OUTER,
              Math.max(1, Math.ceil((track / (Math.PI * 2)) * 96)),
              1,
              gaugeAngle(0),
              track,
            ]}
          />
        </mesh>
      )}
      {drained > 0 && (
        <mesh material={fillMaterial}>
          <ringGeometry
            args={[
              CONTEXT_FILL_INNER,
              CONTEXT_FILL_OUTER,
              Math.max(1, Math.ceil(drained * 96)),
              1,
              // A clockwise arc of `sweep` ending at 12 o'clock is the same
              // shape as a counter-clockwise one starting `sweep` before it.
              gaugeAngle(0) - sweep,
              sweep,
            ]}
          />
        </mesh>
      )}
      {thresholds &&
        // Keyed by position, not by value: editing a threshold should move
        // its mark, not tear one mesh down and build another.
        [thresholds.warn, thresholds.critical].map((percent, i) => (
          <mesh key={i} material={tickMaterial}>
            <ringGeometry
              args={[
                CONTEXT_TICK_INNER,
                CONTEXT_TICK_OUTER,
                1,
                1,
                gaugeAngle(percent) - tickWidth / 2,
                tickWidth,
              ]}
            />
          </mesh>
        ))}
    </group>
  )
}

/**
 * The fraction the arc draws: a rise lands at once, as it always has, and a
 * fall — which only a compaction produces — drains over `ARC_DRAIN_MS` on the
 * app's motion curve (26e). The geometry is rebuilt per step, so this renders
 * the gauge alone, a few dozen times, once per compaction.
 */
function useDrainedFraction(fraction: number): number {
  const [drain, setDrain] = useState<{ from: number; to: number; value: number } | null>(null)
  const shown = useRef(fraction)
  useEffect(() => {
    const from = shown.current
    shown.current = fraction
    if (fraction >= from || prefersReducedMotion()) return
    const start = performance.now()
    let frame = 0
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ARC_DRAIN_MS)
      const value = from + (fraction - from) * easeMotion(k)
      shown.current = value
      setDrain(k < 1 ? { from, to: fraction, value } : null)
      if (k < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [fraction])
  // Asks the demand-driven map for a frame after each step.
  useFrameOnRender()
  return drain && drain.to === fraction ? drain.value : fraction
}

/**
 * The four corner brackets' polylines. Module-level so the arrays keep a
 * stable reference: a fresh array every render makes drei's `<Line>` tear
 * down and rebuild its live geometry/material, and these points never change.
 */
const BRACKET_SIGNS: readonly (readonly [number, number])[] = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
]

const BRACKET_POINTS: [number, number, number][][] = BRACKET_SIGNS.map(([signX, signY]) => {
  const cx = signX * BRACKET_INSET
  const cy = signY * BRACKET_INSET
  return [
    [cx - signX * BRACKET_LENGTH, cy, 0],
    [cx, cy, 0],
    [cx, cy - signY * BRACKET_LENGTH, 0],
  ] as [number, number, number][]
})

const RETICLE_RING_POINTS: [number, number, number][] = (() => {
  const pts: [number, number, number][] = []
  const segments = 96
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    pts.push([RETICLE_RADIUS * Math.cos(angle), RETICLE_RADIUS * Math.sin(angle), 0])
  }
  return pts
})()

type LineHandle = ComponentRef<typeof Line>

/**
 * Selection reticle: the export's slow dashed ring plus four static corner
 * brackets. Only `ringGroupRef` is spun — in the export the brackets are
 * unanimated siblings of the spinning ring, so they hold their corners while
 * the ring turns inside them.
 *
 * Both parts fade with the selection rather than popping, which is why their
 * line materials are handed back to the parent through refs.
 */
function SelectionReticle({
  scaleGroupRef,
  ringGroupRef,
  ringRef,
  bracketRefs,
}: {
  /** Outer group the frame loop scales for the arrival. Owns `scale` alone;
   * the group inside it owns `rotation.z` alone. */
  scaleGroupRef: RefObject<THREE.Group | null>
  ringGroupRef: RefObject<THREE.Group | null>
  ringRef: RefObject<LineHandle | null>
  bracketRefs: RefObject<(LineHandle | null)[]>
}) {
  // Rule 1 in this file's header, for the reticle: the frame loop owns these
  // opacities, so they cannot also be JSX props. As props R3F re-applied `0`
  // on every render and blanked the reticle for a frame — and a SELECTED
  // `working` session re-renders on every WS update, so that frame came up
  // constantly. Zeroed here instead, before the first paint, so the group
  // still starts invisible and fades in from nothing.
  useLayoutEffect(() => {
    if (ringRef.current) ringRef.current.material.opacity = 0
    for (const bracket of bracketRefs.current) {
      if (bracket) bracket.material.opacity = 0
    }
  }, [ringRef, bracketRefs])

  return (
    <group ref={scaleGroupRef} position={[0, 0, RETICLE_Z]}>
      <group ref={ringGroupRef}>
        <Line
          ref={ringRef}
          points={RETICLE_RING_POINTS}
          color={RETICLE_COLOR}
          lineWidth={1}
          dashed
          dashSize={RETICLE_DASH_SIZE}
          gapSize={RETICLE_DASH_GAP}
          transparent
        />
      </group>
      {BRACKET_POINTS.map((points, i) => (
        // 1f draws the brackets `1.5px solid #fff`, opaque at rest — only the
        // dashed ring is tinted. They still fade with the selection.
        <Line
          key={i}
          ref={(handle) => {
            bracketRefs.current[i] = handle
          }}
          points={points}
          color={WHITE}
          lineWidth={1.5}
          transparent
        />
      ))}
    </group>
  )
}

/**
 * The state pill right of the planet (canvas `Feature - State colours` 24a,
 * 24e). A planet with a context gauge uses 1i's pill position instead
 * (`clearsGauge` — the same offsets as the `/compact` pill), because 1f's
 * sits inside the band the gauge ring occupies.
 *
 * Colour and dot come from the one state mapping (`lib/stateStyle`), so the
 * pill says what the sidebar, the chip and the summary line say. Two modes
 * (`map_state_pills`, ADR state-labels-are-dots-first-on-the-map):
 *
 * - `label` (24a): the dot, if the state has one, and the word, always.
 * - `dot` (24e): at rest a small disc holding only the dot. Hovering the
 *   planet (`expanded`) or the disc itself slides the word out and
 *   strengthens the border; leaving slides it back. Plain CSS transitions on
 *   DOM — nothing here asks the canvas for a frame.
 *
 * The disc takes the pointer so it can be hovered, and keeps its presses to
 * itself: they would otherwise bubble into the canvas's raycaster with
 * offsets measured against the disc, not the canvas, and hit whatever planet
 * sits at the matching corner of the map. A click selects its own planet
 * instead (`onClick`). A map pan cannot start on the disc; it is small
 * enough that that costs nothing.
 */
function StatePill({
  stateKey,
  label,
  mode,
  expanded,
  innerRef,
  clearsGauge,
  initialOpacity,
  onClick,
}: {
  stateKey: SessionStateKey
  label: string
  mode: MapStatePills
  /** The planet under it is hovered — dot mode spells the word out. */
  expanded: boolean
  innerRef: RefObject<HTMLSpanElement | null>
  clearsGauge: boolean
  /** Where the fade stands at mount — see the `opacity` line below. */
  initialOpacity: number
  onClick?: () => void
}) {
  const [discHovered, setDiscHovered] = useState(false)
  const color = stateColor(stateKey)
  const dotMode = mode === 'dot'
  const open = !dotMode || expanded || discHovered
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation()
  // zIndexRange keeps map text under the z-10 side panels and z-50 dialogs
  // (drei's default range is in the millions).
  return (
    <Html
      position={
        clearsGauge
          ? [COMPACT_BADGE_OFFSET_X, COMPACT_BADGE_OFFSET_Y, CORE_Z]
          : [BADGE_OFFSET_X, BADGE_OFFSET_Y, CORE_Z]
      }
      zIndexRange={[5, 0]}
      style={{ pointerEvents: 'none' }}
    >
      <span
        ref={innerRef}
        data-state-pill={stateKey}
        data-mode={mode}
        onPointerEnter={dotMode ? () => setDiscHovered(true) : undefined}
        onPointerLeave={dotMode ? () => setDiscHovered(false) : undefined}
        onPointerDown={dotMode ? stop : undefined}
        onPointerMove={dotMode ? stop : undefined}
        onPointerUp={dotMode ? stop : undefined}
        onClick={
          dotMode
            ? (event) => {
                event.stopPropagation()
                onClick?.()
              }
            : undefined
        }
        style={{
          display: 'flex',
          alignItems: 'center',
          boxSizing: 'border-box',
          borderRadius: 999,
          background: 'var(--state-pill-bg)',
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: STATE_PILL_FONT_PX,
          letterSpacing: `${STATE_PILL_TRACKING_EM}em`,
          color,
          whiteSpace: 'nowrap',
          ...(dotMode
            ? {
                // 24e: `height: 20px; padding: 0 6px`; the border goes from
                // .3 to .75 as the word slides out.
                height: STATE_DISC_HEIGHT_PX,
                padding: `0 ${STATE_DISC_PAD_X_PX}px`,
                border: `${STATE_PILL_BORDER_PX}px solid ${stateBorder(color, open ? 'map' : 'map-rest')}`,
                transition: 'border-color .18s ease',
                pointerEvents: 'auto',
                cursor: 'pointer',
              }
            : {
                gap: STATE_PILL_GAP_PX,
                padding: `${STATE_PILL_PAD_Y_PX}px ${STATE_PILL_PAD_X_PX}px`,
                border: `${STATE_PILL_BORDER_PX}px solid ${stateBorder(color, 'map')}`,
              }),
          // Where the fade stands right now, exactly like the label's own
          // seed — and for a sharper reason. `applyState` is the only thing
          // that writes this opacity, and it runs while the state mix is
          // MOVING plus one settled frame; a planet that mounts already in
          // `needs_input` therefore gets a single pass at it. `<Html>`
          // renders its children through a React root of its own
          // (`ReactDOM.createRoot(...).render()` in a layout effect), which
          // commits a tick late, so on that one frame `innerRef` is still
          // null — and a hardcoded 0 here left the pill invisible for the
          // rest of the session
          // (fix `needs-input-pill-never-fades-in-on-a-settled-planet`).
          opacity: initialOpacity,
        }}
      >
        {dotMode ? (
          <>
            <StateDot
              dot={stateDot(stateKey, 'dot')}
              color={color}
              solidPx={STATE_DISC_DOT_PX}
              hollowPx={STATE_DISC_DOT_PX}
            />
            {/* 24e: the word stays in the document (and in the accessible
                name) and slides out from zero width. */}
            <span
              style={{
                display: 'block',
                overflow: 'hidden',
                maxWidth: open ? 200 : 0,
                opacity: open ? 1 : 0,
                marginLeft: open ? STATE_PILL_GAP_PX : 0,
                transition:
                  'max-width .22s cubic-bezier(.2,.8,.2,1), opacity .16s ease, margin-left .22s ease',
              }}
            >
              {label}
            </span>
          </>
        ) : (
          <>
            <StateDot
              dot={stateDot(stateKey, 'label')}
              color={color}
              solidPx={STATE_PILL_DOT_PX}
              hollowPx={STATE_PILL_HOLLOW_DOT_PX}
            />
            {label}
          </>
        )}
      </span>
    </Html>
  )
}

/**
 * `NN% · /compact` pill (artboard 1i), shown past the second threshold. A
 * real `<button>`: it is the one thing on the map that does something other
 * than select, so it has to be reachable and pressable like a control.
 *
 * The `<Html>` wrapper keeps `pointerEvents: none` so the pill never eats a
 * drag aimed at the planet behind it; the button itself takes them back.
 */
function CompactBadge({
  percent,
  innerRef,
  onClick,
}: {
  percent: number
  innerRef: RefObject<HTMLButtonElement | null>
  onClick: () => void
}) {
  return (
    <Html
      position={[COMPACT_BADGE_OFFSET_X, COMPACT_BADGE_OFFSET_Y, CORE_Z]}
      zIndexRange={[5, 0]}
      style={{ pointerEvents: 'none' }}
    >
      <button
        ref={innerRef}
        type="button"
        title={`Send ${COMPACT_COMMAND} to this session`}
        onClick={onClick}
        style={{
          appearance: 'none',
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          borderRadius: 999,
          background: 'rgba(6,10,20,.9)',
          border: `1px solid ${oklchCss(CONTEXT_CRITICAL_OKLCH, 0.7)}`,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 9.5,
          letterSpacing: '0.08em',
          color: '#fff',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          pointerEvents: 'auto',
          opacity: 0,
        }}
      >
        {percent}% ·{' '}
        <span style={{ color: oklchCss(COMPACT_COMMAND_OKLCH) }}>{COMPACT_COMMAND}</span>
      </button>
    </Html>
  )
}

/**
 * `COMPACTING m:ss` (26b, 26e), in the pill slot once a compaction has run
 * three seconds. Its opacity and its timer are written by the frame loop, so
 * a second ticking by costs no render.
 */
function CompactingPill({
  clearsGauge,
  innerRef,
  timeRef,
}: {
  clearsGauge: boolean
  innerRef: RefObject<HTMLSpanElement | null>
  timeRef: RefObject<HTMLSpanElement | null>
}) {
  return (
    <Html
      position={
        clearsGauge ? [COMPACT_BADGE_OFFSET_X, COMPACT_BADGE_OFFSET_Y, CORE_Z] : [BADGE_OFFSET_X, BADGE_OFFSET_Y, CORE_Z]
      }
      zIndexRange={[5, 0]}
      style={{ pointerEvents: 'none' }}
    >
      <span
        ref={innerRef}
        data-compacting-pill
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          borderRadius: 999,
          background: 'rgba(6,10,20,.88)',
          border: `1px solid ${COMPACTING_PILL_BORDER}`,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 9.5,
          letterSpacing: '0.1em',
          color: COMPACTING_PILL_INK,
          whiteSpace: 'nowrap',
          opacity: 0,
        }}
      >
        COMPACTING
        <span ref={timeRef} style={{ color: PILL_SUB_INK }} />
      </span>
    </Html>
  )
}

/**
 * `COMPACT FAILED · NN%` (26e), in the `/compact` badge's slot while the
 * session's last compaction stands failed. A button: it opens the session at
 * the failure's mark.
 */
function CompactFailedBadge({
  percent,
  innerRef,
  initialOpacity,
  onClick,
}: {
  percent: number
  innerRef: RefObject<HTMLButtonElement | null>
  initialOpacity: number
  onClick: () => void
}) {
  return (
    <Html
      position={[COMPACT_BADGE_OFFSET_X, COMPACT_BADGE_OFFSET_Y, CORE_Z]}
      zIndexRange={[5, 0]}
      style={{ pointerEvents: 'none' }}
    >
      <button
        ref={innerRef}
        type="button"
        data-compact-failed
        title="The last compaction failed · open the session at it"
        onClick={onClick}
        style={{
          appearance: 'none',
          margin: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          borderRadius: 999,
          background: 'rgba(6,10,20,.88)',
          border: `1px solid ${oklchCss(CONTEXT_CRITICAL_OKLCH, 0.7)}`,
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 9.5,
          letterSpacing: '0.1em',
          color: COMPACT_FAILED_INK,
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          pointerEvents: 'auto',
          opacity: initialOpacity,
        }}
      >
        COMPACT FAILED
        <span style={{ color: PILL_SUB_INK }}>· {percent}%</span>
      </button>
    </Html>
  )
}

/**
 * The one mark a planet wears while its session sits in a window of its own
 * (canvas `Feature - Detached window` 22e): the detach glyph on a small dark
 * tile at the body's top-right. Static — the window is a place, not an
 * activity — and never clickable: a click on the planet already goes to the
 * window.
 */
function DetachedBadge({
  innerRef,
  flashing,
  initialOpacity,
}: {
  innerRef: RefObject<HTMLSpanElement | null>
  flashing: boolean
  /** Where the fade stands at mount — the same one-frame-late `<Html>` root as the pill's. */
  initialOpacity: number
}) {
  return (
    <Html
      position={[DETACH_BADGE_CORNER, -DETACH_BADGE_CORNER, CORE_Z]}
      zIndexRange={[5, 0]}
      style={{ pointerEvents: 'none' }}
    >
      <span
        ref={innerRef}
        aria-hidden
        style={{
          display: 'grid',
          placeItems: 'center',
          width: DETACH_BADGE_PX,
          height: DETACH_BADGE_PX,
          // The anchor is the badge's bottom-right corner (see DETACH_BADGE_CORNER).
          transform: 'translate(-100%, -100%)',
          borderRadius: 5,
          background: DETACH_BADGE_BG,
          color: flashing ? DETACH_BADGE_FLASH_INK : DETACH_BADGE_INK,
          opacity: initialOpacity,
        }}
      >
        <DetachGlyph />
      </span>
    </Html>
  )
}

interface PlanetMaterials {
  glow: THREE.MeshBasicMaterial
  halo: THREE.MeshBasicMaterial
  arc: THREE.MeshBasicMaterial
  contextTrack: THREE.MeshBasicMaterial
  contextFill: THREE.MeshBasicMaterial
  contextTicks: THREE.MeshBasicMaterial
  bodyEnded: THREE.MeshBasicMaterial
  bodyIdle: THREE.MeshBasicMaterial
  bodyWorking: THREE.MeshBasicMaterial
  innerShade: THREE.MeshBasicMaterial
  border: THREE.MeshBasicMaterial
  ticks: THREE.MeshBasicMaterial[]
  coreGlowHue: THREE.MeshBasicMaterial
  coreGlowWhite: THREE.MeshBasicMaterial
  core: THREE.MeshBasicMaterial
  ripple: THREE.MeshBasicMaterial
  /** Compaction (26b): the hollow core and the two condensing rings with their glow bands. */
  coreHollow: THREE.MeshBasicMaterial
  condense: THREE.MeshBasicMaterial[]
  condenseGlow: THREE.MeshBasicMaterial[]
}

/**
 * One material set per planet, created once and mutated by the frame loop.
 * Per-planet rather than shared because every one of these carries that
 * planet's own hue, opacity and visibility.
 */
function usePlanetMaterials(): PlanetMaterials {
  const materials = useMemo<PlanetMaterials>(() => {
    // `MeshBasicMaterial`'s constructor warns on an explicitly-undefined
    // parameter, so optional ones are only set when they exist (textures are
    // null wherever no 2D canvas is available).
    const soft = (color?: THREE.Color | string, map?: THREE.Texture | null) => {
      const material = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })
      if (color !== undefined) material.color.set(color)
      if (map) material.map = map
      return material
    }
    const glowMap = glowTexture()
    const core = new THREE.MeshBasicMaterial({ transparent: true })
    // The gauge starts invisible and is faded in by the frame loop, so it
    // cannot flash at full strength for the frame before the first
    // `applyState` — same reasoning as the reticle's zeroing below.
    const gauge = (color?: THREE.Color | string) => {
      const material = soft(color)
      material.opacity = 0
      material.visible = false
      return material
    }
    return {
      glow: soft(undefined, glowMap),
      halo: soft(),
      arc: soft(),
      contextTrack: gauge(CONTEXT_TRACK_COLOR),
      contextFill: gauge(),
      contextTicks: gauge(CONTEXT_TICK_COLOR),
      bodyEnded: soft(BODY_ENDED_COLOR),
      bodyIdle: soft(undefined, bodyIdleTexture()),
      bodyWorking: soft(undefined, bodyTexture()),
      innerShade: soft(BLACK),
      border: soft(),
      ticks: PLANET_TICK_LAYERS.map((layer) => soft(layer.grey ? GREY : undefined)),
      coreGlowHue: soft(undefined, glowMap),
      coreGlowWhite: soft(WHITE, glowMap),
      core,
      ripple: soft(STATE_INPUT_HEX),
      // Hidden until a compaction fades them in, for the same reason as the gauge.
      coreHollow: gauge(),
      condense: [gauge(CONDENSE_COLOR), gauge(CONDENSE_COLOR)],
      condenseGlow: [gauge(CONDENSE_COLOR), gauge(CONDENSE_COLOR)],
    }
  }, [])

  useEffect(
    () => () => {
      for (const value of Object.values(materials)) {
        if (Array.isArray(value)) value.forEach((m) => m.dispose())
        else value.dispose()
      }
    },
    [materials]
  )

  return materials
}

function PlanetBody({
  session,
  hue,
  x,
  y,
  scale,
  scaleMultiplier = 1,
  selected,
  hidden = false,
  muted = false,
  modelFamily = null,
  labelTitlePx = 11,
  labelFamilyPx = 9.5,
  contextFill = null,
  contextThresholds,
  showCompactBadge = false,
  onCompact,
  compactingSince = null,
  onCompactFailedClick,
  onClick,
  statePills = 'dot',
  onPillClick,
  detached = false,
  simBody,
  onBodyPointerDown,
}: PlanetProps) {
  /**
   * A compaction borrows the idle body — ticks still, no halo, no glow (26b:
   * "arc greyed · ticks still") — and switches into it and back out in
   * `COMPACTING_SWITCH_MS` rather than the state change's own pace (26e).
   * The edge is read during render, before the mix is retargeted.
   */
  const compacting = compactingSince !== null
  const compactingSinceRef = useRef(compactingSince)
  if (compactingSince !== null) compactingSinceRef.current = compactingSince
  const compactEdgeRef = useRef(compacting)
  const compactEdge = compactEdgeRef.current !== compacting
  const mix = useStateMix(
    PLANET_STATES,
    compacting ? 'idle' : session.status,
    compactEdge ? COMPACTING_SWITCH_MS : STATE_TRANSITION_MS,
  )
  useLayoutEffect(() => {
    compactEdgeRef.current = compacting
  })
  const compactFade = useFadeTween(compacting, COMPACTING_SWITCH_MS, COMPACTING_SWITCH_MS)
  const compactingPillMounted = useLingering(compacting, COMPACTING_SWITCH_MS)
  const hueTween = useHueTween(hue)
  // The tier scale changes WITH the status (layout.ts), so it rides the same
  // curve and duration as the material crossfade — un-tweened it snapped the
  // body size in one frame and masked the whole transition
  // (docs/fixes/state-change-snaps-the-planet-scale.md).
  const scaleTween = useScaleTween(scale)
  // Retagging moves the session into another cluster and renumbers both
  // spirals, so the planet walks there rather than cutting.
  const move = usePointTween(x, y)
  const reticleFade = useFadeTween(selected, RETICLE_ENTER_MS, RETICLE_EXIT_MS)
  // 1 shown, 0 suppressed. Symmetric durations: the artboard transitions
  // opacity and transform over .5s in both directions.
  const hideFade = useFadeTween(!hidden, ENDED_HIDE_MS, ENDED_HIDE_MS)
  // 0 unmuted, 1 muted by the search. Its own tween on the state-change
  // curve, multiplied into the same whole-planet opacity as `hideFade`.
  const muteFade = useFadeTween(muted, STATE_TRANSITION_MS, STATE_TRANSITION_MS)
  const materials = usePlanetMaterials()

  // Textures are process-wide singletons; null only where no 2D canvas exists
  // (jsdom), in which case the gradient bodies are skipped and the flat fill
  // stands in — same fallback as before.
  const hasBodyTextures = bodyTexture() !== null && bodyIdleTexture() !== null
  const hasGlowTexture = glowTexture() !== null

  // Kept mounted through their fade-out, so deselecting and leaving
  // needs-input dissolve instead of being yanked out of the tree by React.
  // The reticle is held a frame or two PAST its tween, not for exactly as
  // long as it: `useLingering` counts wall-clock while the fade needs that
  // many rendered frames. A dropped frame lets the timer win and the group
  // leaves while the ring is still faintly visible — a pop at the end of the
  // exit, which is the thing the exit exists to avoid.
  const reticleMounted = useLingering(selected, RETICLE_EXIT_MS + RETICLE_LINGER_GRACE_MS)

  /** The state pill's state and word, or null for a planet that needs none (`statePill`). */
  const pill = compacting ? null : statePill(session)
  const pillLabel = pill?.label ?? null
  /**
   * The pill's own fade, rather than a weight read off the state mix.
   *
   * It has to be independent of `applyState`, which runs only while the mix
   * is MOVING (plus one settled frame): a planet that mounts already parked
   * got exactly one pass at it, and `<Html>` commits its children through a
   * React root of its own a tick later, so the ref was still null on that
   * frame and the pill stayed at `opacity: 0` for good
   * (fix `needs-input-pill-never-fades-in-on-a-settled-planet`). It also
   * spans two different states now — needs-input and a working planet
   * waiting on its agents — which no single weight can express.
   */
  const pillFade = useFadeTween(pillLabel !== null, STATE_TRANSITION_MS, STATE_TRANSITION_MS)
  const pillMounted = useLingering(pillLabel !== null, STATE_TRANSITION_MS)
  /**
   * Gate on the needs-input ripple ring, multiplied into the weight the state
   * mix gives it. The ring says "you are being waited for", which only a
   * NEEDS INPUT planet is (`sessionStateKey`): not a DONE one, and not an
   * interrupted one either — its coral pill says enough. DONE and NEEDS INPUT
   * share the `needs_input` status, so the mix never moves when a decision
   * parks or resolves; this tween fades the ring on that flip instead of
   * snapping it.
   *
   * It follows the decision itself rather than "not DONE": leaving
   * `needs_input` already fades the ring out through the mix, and a gate
   * rising against that fall (DONE → working) would flash a ghost ring.
   */
  const rippleFade = useFadeTween(
    sessionStateKey(session) === 'needs_input',
    STATE_TRANSITION_MS,
    STATE_TRANSITION_MS,
  )
  /** The last pill it had, so a pill on its way out fades with its own word and colour. */
  const lastPill = useRef(pill)
  if (pill) lastPill.current = pill
  const shownPill = pill ?? lastPill.current

  /**
   * The context gauge (artboard 1i). `contextFill` going null — the session
   * ended, the toggle went off, a compaction erased the reading — has to
   * fade the arc out rather than yanking it, so the last fill it had is kept
   * to draw the departure with.
   */
  const lastFill = useRef<ContextFill | null>(contextFill)
  if (contextFill) lastFill.current = contextFill
  const gaugeMounted = useLingering(contextFill !== null, CONTEXT_FADE_MS)
  const gaugeFade = useFadeTween(contextFill !== null, CONTEXT_FADE_MS, CONTEXT_FADE_MS)
  const shownFill = contextFill ?? lastFill.current
  /**
   * The `/compact` pill. Never at the same time as the state one — that pill
   * sits in the same corner and answers a more urgent question, so it wins
   * outright, including while it is fading away.
   */
  /**
   * `COMPACT FAILED · NN%` (26e) takes the `/compact` badge's slot while the
   * last compaction stands failed. It needs the percentage, so it rides the
   * gauge; it is swapped in with no motion of its own and leaves on the
   * state change's fade.
   */
  const failedDue = session.lastCompactionFailed != null && contextFill !== null && !compacting && !pillMounted
  const failedMounted = useLingering(failedDue, STATE_TRANSITION_MS)
  const failedFade = useFadeTween(failedDue, 0, STATE_TRANSITION_MS)
  // A running compaction takes the badge's place (its own pill does), and a
  // failed one has already said what the badge would.
  const compactDue =
    showCompactBadge && contextFill?.level === 'critical' && !pillMounted && !compacting && !failedDue
  const compactMounted = useLingering(compactDue, STATE_TRANSITION_MS)
  const compactBadgeFade = useFadeTween(compactDue, STATE_TRANSITION_MS, STATE_TRANSITION_MS)

  /**
   * `compacted · 186k → 22k` under the label for six seconds after a success
   * (26b, 26e). Only an Orbital session has `lastCompacted`, and only in the
   * server process that saw it — after a restart there is nothing to show.
   * Shown and hidden from timers, never from the render itself.
   */
  const lastCompacted = session.lastCompacted ?? null
  const compactedAt = lastCompacted?.at ?? null
  const [captionFor, setCaptionFor] = useState<number | null>(null)
  useEffect(() => {
    if (compactedAt === null) return
    const left = compactedAt + COMPACTED_CAPTION_MS - Date.now()
    if (left <= 0) return
    const show = setTimeout(() => setCaptionFor(compactedAt), 0)
    const hide = setTimeout(() => setCaptionFor(null), left)
    return () => {
      clearTimeout(show)
      clearTimeout(hide)
    }
  }, [compactedAt])
  const captionShown = captionFor !== null && captionFor === compactedAt
  const captionMounted = useLingering(captionShown, STATE_TRANSITION_MS)
  const captionText =
    lastCompacted && lastCompacted.preTokens !== null && lastCompacted.postTokens !== null
      ? `compacted · ${formatCompactTokens(lastCompacted.preTokens)} → ${formatCompactTokens(lastCompacted.postTokens)}`
      : 'compacted'
  /**
   * A suppressed planet's title has to LEAVE the document, not just turn
   * invisible: `<Html>` portals its content into a plain DOM overlay that the
   * group's `visible = false` never reaches, so hiding the ended planets used
   * to leave their titles floating over empty space. Held through the fade so
   * the text goes with the planet rather than vanishing a beat early.
   */
  const labelMounted = useLingering(!hidden, ENDED_HIDE_MS)
  /**
   * The detached badge (22e). It arrives at once — detaching already moved
   * the panel off screen, and the badge is where the session went — and
   * leaves over `DETACH_BADGE_EXIT_MS` when the window closes. An ended
   * session keeps it for as long as its window stays open.
   */
  const detachedMounted = useLingering(detached, DETACH_BADGE_EXIT_MS)
  const detachedFade = useFadeTween(detached, 0, DETACH_BADGE_EXIT_MS)
  const [detachFlash, setDetachFlash] = useState(false)
  useEffect(() => {
    if (!detachFlash) return
    const timer = setTimeout(() => setDetachFlash(false), DETACH_BADGE_FLASH_MS)
    return () => clearTimeout(timer)
  }, [detachFlash])
  const reduced = prefersReducedMotion()

  /**
   * Hover-expanded label. `labelHovered` is the planet's first hover state
   * — anything else that wants hover later (a cursor, a tooltip) should
   * grow from it. The overlay only exists while the title actually
   * truncates: hovering a short-named planet changes nothing, so no scrim
   * ever flashes over a label that is already whole.
   */
  const [labelHovered, setLabelHovered] = useState(false)
  const hoverActive = labelHovered && !hidden && truncateLabel(session.title) !== session.title
  const hoverFade = useFadeTween(hoverActive, HOVER_LABEL_ENTER_MS, HOVER_LABEL_EXIT_MS)
  const overlayMounted = useLingering(hoverActive, HOVER_LABEL_EXIT_MS)

  /**
   * The root group. The JSX `scale` prop renders the TWEEN's current value
   * (times the multiplier), not the incoming prop — same reasoning as
   * `usePointTween`'s position: the re-render that delivers a new tier
   * happens a frame before the tween starts, so rendering the target would
   * flash the new size for a frame and then yank it back. The frame loop
   * multiplies the hide fade and counter-zoom into it; R3F re-applying the
   * prop on an unrelated re-render can stamp over those for a frame, which
   * the next frame corrects.
   */
  const groupRef = useRef<THREE.Group>(null)
  const tickGroupRef = useRef<THREE.Group>(null!)
  const arcGroupRef = useRef<THREE.Group>(null!)
  const coreRef = useRef<THREE.Mesh>(null!)
  const rippleRef = useRef<THREE.Mesh>(null!)
  const reticleScaleRef = useRef<THREE.Group>(null)
  const reticleGroupRef = useRef<THREE.Group>(null)
  const reticleRingRef = useRef<LineHandle | null>(null)
  const bracketRefs = useRef<(LineHandle | null)[]>([])
  const badgeRef = useRef<HTMLSpanElement | null>(null)
  const detachedBadgeRef = useRef<HTMLSpanElement | null>(null)
  const compactBadgeRef = useRef<HTMLButtonElement | null>(null)
  const failedBadgeRef = useRef<HTMLButtonElement | null>(null)
  const compactingPillRef = useRef<HTMLSpanElement | null>(null)
  const compactingTimeRef = useRef<HTMLSpanElement | null>(null)
  const coreHollowRef = useRef<THREE.Mesh>(null!)
  const condenseRef0 = useRef<THREE.Group>(null)
  const condenseRef1 = useRef<THREE.Group>(null)
  /** Scratch for `condenseAt`, so the frame loop allocates nothing. */
  const condenseState = useRef({ opacity: 0, scale: 1 })
  const labelRef = useRef<HTMLSpanElement | null>(null)
  const labelGroupRef = useRef<THREE.Group>(null)
  /** Where the label hangs right now: under the gauge, and under the reticle once its fade is past the handoff. */
  const labelGauged = gaugeMounted && shownFill !== null
  const labelY = () => labelRestY(labelGauged, labelUnderReticle(reticleFade.value))
  // The frame loop owns the label group's `y`; this places it before the
  // first paint, so a label that mounts does not start a frame at the centre.
  useLayoutEffect(() => {
    if (labelGroupRef.current) labelGroupRef.current.position.y = labelY()
  })
  const overlayRef = useRef<HTMLSpanElement | null>(null)
  const overlayTextRef = useRef<HTMLSpanElement | null>(null)
  const overlayCursorRef = useRef<HTMLSpanElement | null>(null)
  /** Milliseconds the pointer has rested on the planet — drives `typedLabel`. */
  const hoverTypeElapsed = useRef(0)
  const rippleElapsed = useRef(0)
  /**
   * The blink's own phase, advanced by `delta / period` rather than read off
   * the global clock: the period itself is interpolating (2.4s working ⇄ 1.2s
   * needs-input), and `cos(t / p)` with a changing `p` jumps whenever `p`
   * moves. Integrating the phase keeps the blink continuous through the
   * transition.
   */
  const corePhase = useRef(0)
  const bodyAlphas = useRef<number[]>([0, 0, 0])
  const hueColor = useRef(new THREE.Color())
  /** Seeded from the table so a planet is correct on its very first frame. */
  const blendRef = useRef(blendPlanet(mix.weights, createPlanetBlend()))
  /** False until the settled values have been written once after a transition ends. */
  const settled = useRef(false)
  /**
   * The arc crossing a threshold changes a colour without anything else
   * about the planet moving, and `applyState` is the only place that writes
   * it — so ask for one more pass of it.
   */
  useLayoutEffect(() => {
    settled.current = false
  }, [shownFill?.level])

  // A search-muted planet's label drops to the ended ink too — the colour
  // rides the label's own CSS transition, the opacity the frame loop below.
  const dimmedLabel = session.status === 'ended' || muted

  /**
   * Writes everything that depends only on the state weights and the hue.
   * Called on any frame where either moved, plus the one frame after they
   * stop — never on a resting planet.
   */
  const applyState = () => {
    const w = mix.weights
    // The whole-planet multiplier: the ENDED suppression times the search
    // mute. Every opacity below takes it, so both reach every layer.
    const fade = endedHideTransform(hideFade.value).opacity * mutedOpacity(muteFade.value)
    const b = blendRef.current
    // Desaturated toward the ended grey by the mute weight, here where the
    // hue is resolved, so every layer that wears the hue greys with it.
    const hueC = setOklchTagColor(hueColor.current, hueTween.value).lerp(GREY_COLOR, muteFade.value)
    const idleShare = w.idle + w.needs_input

    materials.glow.color.copy(hueC)
    materials.glow.opacity = w.working * GLOW_OPACITY * fade
    materials.glow.visible = hasGlowTexture && materials.glow.opacity > 0.001

    materials.halo.color.copy(hueC)

    materials.arc.color.copy(hueC)
    materials.arc.opacity = b.arcOpacity * fade
    materials.arc.visible = b.arcOpacity > 0.001

    // Context gauge colour (1i): green below the first threshold, then
    // amber, then red — the same on every planet, never the tag hue. The
    // opacities (and the critical pulse) belong to the frame loop below.
    if (shownFill) {
      const gauge = contextLevelOklch(shownFill.level)
      setOklchTagColor(materials.contextFill.color, gauge.hue, gauge.lightness, gauge.chroma)
        // A compacting arc goes to the grey (26b), whatever its level.
        .lerp(GREY_COLOR, compactFade.value)
        .lerp(GREY_COLOR, muteFade.value)
    }
    materials.coreHollow.color.copy(hueC)

    if (hasBodyTextures) {
      // Bottom-to-top: flat ended fill, idle gradient, working gradient.
      const alphas = stackAlphas([w.ended, idleShare, w.working], bodyAlphas.current)
      materials.bodyEnded.opacity = alphas[0] * DIMMED_OPACITY * fade
      materials.bodyEnded.visible = alphas[0] > 0.001
      materials.bodyIdle.opacity = alphas[1] * fade
      materials.bodyIdle.visible = alphas[1] > 0.001
      materials.bodyWorking.opacity = alphas[2] * fade
      materials.bodyWorking.visible = alphas[2] > 0.001
    } else {
      materials.bodyEnded.opacity = b.dim * fade
      materials.bodyEnded.visible = true
      materials.bodyIdle.visible = false
      materials.bodyWorking.visible = false
    }

    materials.innerShade.opacity = w.working * INNER_SHADE_OPACITY * fade
    materials.innerShade.visible = materials.innerShade.opacity > 0.001

    materials.border.color.copy(hueC).lerp(GREY_COLOR, w.ended)
    materials.border.opacity =
      (w.working * BORDER_OPACITY_ACTIVE +
        idleShare * BORDER_OPACITY_IDLE +
        w.ended * BORDER_OPACITY_ENDED) *
      b.dim *
      fade

    // Crossfade: each distinct tick ring is drawn at the summed weight of the
    // states that wear it. Counts (60/45/30) cannot be interpolated, so the
    // rings dissolve into one another instead.
    PLANET_TICK_LAYERS.forEach((layer, i) => {
      const material = materials.ticks[i]
      const weight = tickLayerWeight(layer, w)
      material.opacity = weight * layer.opacity * b.dim * fade
      material.visible = material.opacity > 0.001
      if (!layer.grey) material.color.copy(hueC)
    })

    materials.coreGlowHue.color.copy(hueC)
    materials.coreGlowHue.opacity = w.needs_input * CORE_GLOW_HUE_OPACITY * fade
    materials.coreGlowHue.visible = hasGlowTexture && materials.coreGlowHue.opacity > 0.001
    materials.coreGlowWhite.opacity = w.needs_input * CORE_GLOW_WHITE_OPACITY * fade
    materials.coreGlowWhite.visible = hasGlowTexture && materials.coreGlowWhite.opacity > 0.001

    materials.core.color.copy(hueC).lerp(WHITE_COLOR, w.needs_input)
    if (coreRef.current) coreRef.current.scale.setScalar(b.coreRadius)

    // The label is plain DOM: `group.visible = false` hides the meshes under
    // it but says nothing about a portalled `<Html>`, so the fade has to be
    // written onto the span itself (and the span unmounted once it is out —
    // see `labelMounted`).
    if (labelRef.current) {
      labelRef.current.style.opacity = String(fade * selectionLabelOpacity(reticleFade.value))
    }
  }

  // Hover, the detach flash and every prop change arrive as a render; each
  // one asks for a frame, and the loop below keeps them coming while it
  // reports motion (`moving`).
  useFrameOnRender()

  useMapFrame((state, delta) => {
    const mixMoved = advanceStateMix(mix, delta)
    const hueMoved = advanceTween(hueTween, delta)
    const hideMoved = advanceTween(hideFade, delta)
    const muteMoved = advanceTween(muteFade, delta)
    const compactMoved = advanceTween(compactFade, delta)
    const b = blendRef.current
    if (mixMoved) blendPlanet(mix.weights, b)
    // The hide fade and the search mute multiply into every opacity (and the
    // mute into the hue) `applyState` writes, so either moving has to re-run
    // it — otherwise the layers it only touches on a state change would keep
    // their pre-fade alpha.
    const applied = mixMoved || hueMoved || hideMoved || muteMoved || compactMoved || !settled.current
    if (applied) applyState()
    settled.current = !(mixMoved || hueMoved || hideMoved || muteMoved || compactMoved)
    // Whether anything this frame writes will differ next frame. The body's
    // position is the simulation's, and `SimStepper` reports that.
    let moving = mixMoved || hueMoved || hideMoved || muteMoved || compactMoved

    if (simBody) {
      // The simulation owns the position outright — walks and drags both
      // arrive through the mutated body, never through the props.
      if (groupRef.current) {
        groupRef.current.position.x = simBody.x
        groupRef.current.position.y = simBody.y
      }
    } else if (advancePointTween(move, delta)) {
      moving = true
      if (groupRef.current) {
        groupRef.current.position.x = move.x.value
        groupRef.current.position.y = move.y.value
      }
    }

    if (advanceTween(scaleTween, delta)) moving = true
    const hide = endedHideTransform(hideFade.value)
    if (groupRef.current) {
      // Counter-zoom: planets shrink more slowly than the map when zooming
      // out (identity at/above the default zoom) — see `bodyZoomFactor`.
      groupRef.current.scale.setScalar(
        scaleTween.value * scaleMultiplier * hide.scale * bodyZoomFactor(state.camera.zoom)
      )
      // Fully faded out: stop drawing the subtree altogether rather than
      // paying for a dozen invisible meshes every frame.
      groupRef.current.visible = hide.opacity > 0.001
    }
    // The whole-planet opacity every per-frame write below multiplies in: the
    // ENDED suppression times the search mute, the same product `applyState`
    // writes. The mute never touches the scale — a muted planet holds its size.
    const whole = hide.opacity * mutedOpacity(muteFade.value)
    // Both pills are plain DOM, and both are written before the early return
    // below, or a planet on its way out would leave one hanging at full
    // strength. Written on EVERY frame they are mounted — not from
    // `applyState`, which stops as soon as the state mix settles and whose
    // one pass at a freshly mounted planet lands before `<Html>` has
    // committed the node to write to.
    if (pillMounted) {
      if (advanceTween(pillFade, delta)) moving = true
      if (badgeRef.current) {
        badgeRef.current.style.opacity = String(pillFade.value * whole)
      }
    }
    if (compactMounted) {
      if (advanceTween(compactBadgeFade, delta)) moving = true
      if (compactBadgeRef.current) {
        compactBadgeRef.current.style.opacity = String(compactBadgeFade.value * whole)
      }
    }
    if (failedMounted) {
      if (advanceTween(failedFade, delta)) moving = true
      if (failedBadgeRef.current) failedBadgeRef.current.style.opacity = String(failedFade.value * whole)
    }
    // The compacting pill: nothing for three seconds, then a 200 ms fade, and
    // a timer that counts up (26e). Written every frame it is mounted — the
    // condensing rings keep frames coming for as long as it is.
    if (compactingPillMounted) {
      const since = compactingSinceRef.current
      const elapsed = since !== null ? Date.now() - since : 0
      if (compactingPillRef.current) {
        compactingPillRef.current.style.opacity = String(compactingLabelOpacity(elapsed) * compactFade.value * whole)
      }
      const time = formatElapsed(elapsed)
      if (compactingTimeRef.current && compactingTimeRef.current.textContent !== time) {
        compactingTimeRef.current.textContent = time
      }
    }
    if (detachedMounted) {
      if (advanceTween(detachedFade, delta)) moving = true
      if (detachedBadgeRef.current) {
        detachedBadgeRef.current.style.opacity = String(detachedFade.value * whole)
      }
    }

    if (!(hide.opacity > 0.001)) return moving

    // Context gauge (1i). Past the second threshold the ring pulses on the
    // canvas's `orb-ring` keyframe at 1.6s — the same .55 ↔ 1 swing the halo
    // breathes on, which is why `HALO_BREATH_MIN` is the floor here too. The
    // pulse carries the track with the fill, because 1i paints both of them
    // as one conic-gradient element and animates that; the threshold marks
    // are a separate layer there and hold still here. Skipped entirely on a
    // settled planet whose arc is not pulsing, so a resting map still does
    // no per-frame work.
    const gaugeMoved = advanceTween(gaugeFade, delta)
    const critical = shownFill?.level === 'critical'
    if (gaugeMoved || (gaugeMounted && critical)) moving = true
    if (gaugeMounted && (gaugeMoved || applied || critical)) {
      // A compacting arc holds still at the grey's .3 (26b), and its
      // threshold marks drop to .3 with it.
      const held = compactFade.value
      const beat = critical
        ? HALO_BREATH_MIN + (1 - HALO_BREATH_MIN) * oscillate(state.clock.elapsedTime, CONTEXT_PULSE_SEC)
        : 1
      const pulse = beat + (1 - beat) * held
      const gauge = gaugeFade.value * whole
      materials.contextTrack.opacity = CONTEXT_TRACK_OPACITY * pulse * gauge
      materials.contextTrack.visible = materials.contextTrack.opacity > 0.001
      materials.contextTicks.opacity = CONTEXT_TICK_OPACITY * (1 - (1 - COMPACT_TICKS_FACTOR) * held) * gauge
      materials.contextTicks.visible = materials.contextTicks.opacity > 0.001
      const fillOpacity = (shownFill?.level === 'ok' ? CONTEXT_OK_OPACITY : 1) * pulse
      materials.contextFill.opacity =
        (fillOpacity + (COMPACT_ARC_OPACITY - fillOpacity) * held) * gauge
      materials.contextFill.visible = materials.contextFill.opacity > 0.001
    }

    // The ambient motion: spins, the blink, the breath and the ripple never
    // settle while their state wears them.
    if (b.tickSpin !== 0 || b.arcSpin !== 0 || b.corePulse > 0 || b.haloBreath > 0) moving = true

    if (b.tickSpin !== 0 && tickGroupRef.current) {
      tickGroupRef.current.rotation.z += b.tickSpin * delta
    }

    if (b.arcSpin !== 0 && arcGroupRef.current) {
      arcGroupRef.current.rotation.z += b.arcSpin * delta
    }

    // `orb-blink`: opacity 1 → .3 → 1 over corePulseSec (a blink, not a scale pulse).
    corePhase.current += b.corePulseSec > 0 ? delta / b.corePulseSec : 0
    const blink = b.corePulse > 0 ? 1 - BLINK_DEPTH * b.corePulse * oscillate(corePhase.current, 1) : 1
    // The solid core gives way to the hollow ring while compacting (26b).
    const held = compactFade.value
    materials.core.opacity = b.coreOpacity * blink * b.dim * whole * (1 - held)
    materials.core.visible = materials.core.opacity > 0.001
    materials.coreHollow.opacity = COMPACT_CORE_OPACITY * held * whole
    materials.coreHollow.visible = materials.coreHollow.opacity > 0.001

    // Two grey rings drawn in onto the body, half a cycle apart, phased off
    // the compaction's own start (26b, 26e). They run for as long as the
    // compaction does and fade with it.
    if (held > 0.001) {
      moving = true
      const since = compactingSinceRef.current ?? 0
      const cycles = (Date.now() - since) / 1000 / CONDENSE_PERIOD_SEC
      const rings = [condenseRef0.current, condenseRef1.current]
      for (let i = 0; i < 2; i++) {
        condenseAt(cycles + i * 0.5, condenseState.current)
        rings[i]?.scale.setScalar(condenseState.current.scale)
        const alpha = condenseState.current.opacity * held * whole
        materials.condense[i].opacity = CONDENSE_OPACITY * alpha
        materials.condense[i].visible = materials.condense[i].opacity > 0.001
        materials.condenseGlow[i].opacity = CONDENSE_GLOW_OPACITY * alpha
        materials.condenseGlow[i].visible = materials.condenseGlow[i].opacity > 0.001
      }
    } else {
      for (let i = 0; i < 2; i++) {
        materials.condense[i].visible = false
        materials.condenseGlow[i].visible = false
      }
    }

    // `orb-ring`: opacity ×.55 → ×1 → ×.55 over 2.4s, faded in by haloBreath.
    const breath =
      1 - b.haloBreath * (1 - HALO_BREATH_MIN) * (1 - oscillate(state.clock.elapsedTime, HALO_BREATH_SEC))
    materials.halo.opacity = b.haloOpacity * breath * whole
    materials.halo.visible = materials.halo.opacity > 0.001

    if (advanceTween(rippleFade, delta)) moving = true
    const ripple = b.ripple * rippleFade.value
    if (ripple > 0.001) {
      moving = true
      rippleElapsed.current = (rippleElapsed.current + delta) % RIPPLE_DURATION_SEC
      const progress = easeOut(rippleElapsed.current / RIPPLE_DURATION_SEC)
      if (rippleRef.current) rippleRef.current.scale.setScalar(1 + progress * (RIPPLE_MAX_SCALE - 1))
      materials.ripple.opacity = RIPPLE_START_OPACITY * (1 - progress) * ripple * whole
      materials.ripple.visible = true
    } else {
      rippleElapsed.current = 0
      materials.ripple.visible = false
    }

    const reticleMoved = advanceTween(reticleFade, delta)
    if (reticleMoved) moving = true
    if (reticleGroupRef.current) {
      // The canvas spins the dashed ring (`orb-spin 160s`); the bracket spans
      // are its unanimated siblings and stay put.
      reticleGroupRef.current.rotation.z += RETICLE_SPIN_SPEED * delta
      // It spins for as long as it is mounted.
      moving = true
    }
    if (reticleMoved || reticleFade.value > 0) {
      if (reticleRingRef.current) reticleRingRef.current.material.opacity = RETICLE_OPACITY * reticleFade.value * whole
      for (const bracket of bracketRefs.current) {
        if (bracket) bracket.material.opacity = reticleFade.value * whole
      }
      // Ring and brackets settle together, so the whole mark arrives as one
      // object rather than as a fade with a spinning part. Scale is written on
      // the outer group, which nothing else touches — the spin owns
      // `rotation.z` on the group inside it, and neither writes the other's
      // property (rule 1 in this file's header).
      if (reticleScaleRef.current) {
        const scale = reticleEnterScale(reticleFade.value)
        reticleScaleRef.current.scale.set(scale, scale, 1)
      }
      // The label changes place on this fade without sliding: it fades out,
      // jumps at the handoff while invisible, and fades back in (see the
      // label block at the top of this file).
      if (labelRef.current) {
        labelRef.current.style.opacity = String(whole * selectionLabelOpacity(reticleFade.value))
      }
    }
    // Every frame, not only while the reticle fades: the gauge's discrete
    // drop arrives through a render, and the handoff mid-tween through none.
    if (labelGroupRef.current) labelGroupRef.current.position.y = labelY()

    // Hover-expanded label: the typing reveal and both fades are written
    // straight onto the overlay's DOM, like `labelRef`'s opacity above —
    // no React re-render per character.
    if (overlayMounted) {
      if (hoverActive) hoverTypeElapsed.current += delta * 1000
      if (advanceTween(hoverFade, delta)) moving = true
      if (overlayRef.current) {
        // The ENDED suppression only, not the search mute: hovering is asking
        // to read the title, and a muted planet's name is no less worth
        // reading on request. Its moons' hover affordances stay unmuted too.
        overlayRef.current.style.opacity = String(hoverFade.value * hide.opacity)
        overlayRef.current.style.transform = `translate(-50%, ${(1 - hoverFade.value) * 2}px)`
      }
      if (overlayTextRef.current) {
        const text = reduced ? session.title : typedLabel(session.title, hoverTypeElapsed.current)
        if (overlayTextRef.current.textContent !== text) overlayTextRef.current.textContent = text
        if (overlayCursorRef.current) {
          overlayCursorRef.current.style.display =
            hoverActive && text !== session.title ? 'inline' : 'none'
        }
        // Still typing the title out.
        if (hoverActive && text !== session.title) moving = true
      }
    }
    return moving
  })

  // A planet fading off the map is on its way out: nothing to select or pick
  // up, so the pointer passes through to the map beneath.
  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (hidden) return
    event.stopPropagation()
    if (detached) setDetachFlash(true)
    onClick?.(session.id)
  }

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    if (hidden) return
    onBodyPointerDown?.(session.id, event)
  }

  const handleHoverOver = () => {
    hoverTypeElapsed.current = 0
    setLabelHovered(true)
  }
  const handleHoverOut = () => setLabelHovered(false)

  return (
    <group
      ref={groupRef}
      // The tweens' (or the sim body's) current values, NOT `x`/`y`/`scale`
      // — see `usePointTween` and the `groupRef` comment above.
      position={[simBody?.x ?? move.x.value, simBody?.y ?? move.y.value, 0]}
      scale={scaleTween.value * scaleMultiplier}
      onClick={onClick ? handleClick : undefined}
      onPointerDown={onBodyPointerDown ? handlePointerDown : undefined}
    >
      {hasGlowTexture && (
        <mesh position={[0, 0, HALO_Z]} material={materials.glow}>
          <planeGeometry args={[GLOW_SIZE, GLOW_SIZE]} />
        </mesh>
      )}

      <mesh position={[0, 0, HALO_Z]} material={materials.halo}>
        <ringGeometry args={[HALO_RING_INNER, HALO_RING_OUTER, 64]} />
      </mesh>

      <group ref={arcGroupRef} position={[0, 0, HALO_Z]}>
        <ArcRing material={materials.arc} />
      </group>

      <mesh position={[0, 0, BODY_ENDED_Z]} material={materials.bodyEnded}>
        <circleGeometry args={[BODY_RADIUS, 48]} />
      </mesh>
      {hasBodyTextures && (
        <>
          <mesh position={[0, 0, BODY_IDLE_Z]} material={materials.bodyIdle}>
            <circleGeometry args={[BODY_RADIUS, 48]} />
          </mesh>
          <mesh position={[0, 0, BODY_WORKING_Z]} material={materials.bodyWorking}>
            <circleGeometry args={[BODY_RADIUS, 48]} />
          </mesh>
        </>
      )}

      <mesh position={[0, 0, BODY_Z]} material={materials.innerShade}>
        <ringGeometry args={[INNER_SHADE_INNER, INNER_SHADE_OUTER, 48]} />
      </mesh>

      <mesh position={[0, 0, BODY_Z]} material={materials.border}>
        <ringGeometry args={[BORDER_INNER, BORDER_OUTER, 64]} />
      </mesh>

      <group ref={tickGroupRef} position={[0, 0, BODY_Z]}>
        {PLANET_TICK_LAYERS.map((layer, i) => (
          <TickRing
            key={layer.count}
            count={layer.count}
            radius={layer.radius}
            widthDeg={layer.widthDeg}
            length={layer.length}
            material={materials.ticks[i]}
          />
        ))}
      </group>

      {hasGlowTexture && (
        <>
          <mesh position={[0, 0, CORE_GLOW_Z]} material={materials.coreGlowHue}>
            <planeGeometry args={[CORE_GLOW_HUE_SIZE, CORE_GLOW_HUE_SIZE]} />
          </mesh>
          <mesh position={[0, 0, CORE_GLOW_Z]} material={materials.coreGlowWhite}>
            <planeGeometry args={[CORE_GLOW_WHITE_SIZE, CORE_GLOW_WHITE_SIZE]} />
          </mesh>
        </>
      )}

      {/* Unit circle scaled to the blended core radius: interpolating the
          geometry's own radius would rebuild it every frame. */}
      <mesh ref={coreRef} position={[0, 0, CORE_Z]} material={materials.core}>
        <circleGeometry args={[1, 32]} />
      </mesh>

      <mesh ref={coreHollowRef} position={[0, 0, CORE_Z]} material={materials.coreHollow}>
        <ringGeometry args={[COMPACT_CORE_INNER, COMPACT_CORE_OUTER, 32]} />
      </mesh>

      {/* The condensing rings (26b). Scaled from the frame loop, which owns
          each group's `scale` alone. */}
      <group ref={condenseRef0} position={[0, 0, CONTEXT_GAUGE_Z]}>
        <mesh material={materials.condenseGlow[0]}>
          <ringGeometry args={[CONDENSE_GLOW_INNER, CONDENSE_GLOW_OUTER, 64]} />
        </mesh>
        <mesh material={materials.condense[0]}>
          <ringGeometry args={[CONDENSE_INNER, CONDENSE_OUTER, 64]} />
        </mesh>
      </group>
      <group ref={condenseRef1} position={[0, 0, CONTEXT_GAUGE_Z]}>
        <mesh material={materials.condenseGlow[1]}>
          <ringGeometry args={[CONDENSE_GLOW_INNER, CONDENSE_GLOW_OUTER, 64]} />
        </mesh>
        <mesh material={materials.condense[1]}>
          <ringGeometry args={[CONDENSE_INNER, CONDENSE_OUTER, 64]} />
        </mesh>
      </group>

      <mesh ref={rippleRef} position={[0, 0, RIPPLE_Z]} material={materials.ripple}>
        <ringGeometry args={[RIPPLE_INNER, RIPPLE_OUTER, 48]} />
      </mesh>

      {gaugeMounted && shownFill && (
        <ContextGauge
          fraction={shownFill.fraction}
          thresholds={contextThresholds}
          trackMaterial={materials.contextTrack}
          fillMaterial={materials.contextFill}
          tickMaterial={materials.contextTicks}
        />
      )}

      {reticleMounted && (
        <SelectionReticle
          scaleGroupRef={reticleScaleRef}
          ringGroupRef={reticleGroupRef}
          ringRef={reticleRingRef}
          bracketRefs={bracketRefs}
        />
      )}

      {pillMounted && shownPill && (
        <StatePill
          stateKey={shownPill.key}
          label={shownPill.label}
          mode={statePills}
          expanded={labelHovered && !hidden}
          onClick={onPillClick ? () => onPillClick(session.id) : undefined}
          innerRef={badgeRef}
          clearsGauge={gaugeMounted && shownFill !== null}
          initialOpacity={pillFade.value * endedHideTransform(hideFade.value).opacity * mutedOpacity(muteFade.value)}
        />
      )}

      {detachedMounted && (
        <DetachedBadge
          innerRef={detachedBadgeRef}
          flashing={detachFlash}
          initialOpacity={detachedFade.value * endedHideTransform(hideFade.value).opacity * mutedOpacity(muteFade.value)}
        />
      )}

      {compactMounted && shownFill && (
        <CompactBadge
          percent={Math.round(shownFill.fraction * 100)}
          innerRef={compactBadgeRef}
          onClick={() => onCompact?.(session.id)}
        />
      )}

      {failedMounted && shownFill && (
        <CompactFailedBadge
          percent={Math.round(shownFill.fraction * 100)}
          innerRef={failedBadgeRef}
          initialOpacity={failedFade.value * endedHideTransform(hideFade.value).opacity * mutedOpacity(muteFade.value)}
          onClick={() => onCompactFailedClick?.(session.id)}
        />
      )}

      {compactingPillMounted && (
        <CompactingPill
          clearsGauge={gaugeMounted && shownFill !== null}
          innerRef={compactingPillRef}
          timeRef={compactingTimeRef}
        />
      )}

      {/* Hover target: ONE invisible disc, not over/out on the group — the
          planet is a stack of overlapping child meshes, and the pointer
          crossing between them fires out/over pairs on the group, which
          would restart the label's typing mid-hover. An invisible mesh
          still raycasts. Sized to the halo ring's outer edge, roughly the
          planet's visual footprint; clicks on it bubble to the group's
          onClick unchanged. */}
      <mesh
        position={[0, 0, RETICLE_Z]}
        visible={false}
        onPointerOver={handleHoverOver}
        onPointerOut={handleHoverOut}
      >
        <circleGeometry args={[HALO_RING_OUTER, 32]} />
      </mesh>

      {labelMounted && (
        // No `position` prop: the frame loop owns `y` (`labelY`), and a prop
        // would have R3F stamp over the handoff on the next render.
        <group ref={labelGroupRef}>
          <Html zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
            {/* All three of display/width/transform below are load-bearing.
                `transform` does not apply to an inline box, and the shift is
                what centres the label under the planet (the anchor is its
                top-LEFT corner). `block` rather than `inline-block` because an
                inline-block sits on a line box and gets baseline-aligned
                against the wrapper's strut — measured at ~6px of leading
                pushing the label off its anchor. A block box has no line box
                above it and starts exactly at the anchor; `max-content` keeps
                it shrink-to-fit so the -50% is half the text, not half the
                wrapper. This trio must stay on this OUTER span only — moving
                it to (or duplicating it onto) either child un-centres the
                label. */}
            <span
              // The per-frame fade is written straight onto this node, so it
              // has to be the outer one: the title and the family line fade as
              // a single label, not as two that can drift apart.
              ref={labelRef}
              style={{
                display: 'block',
                width: 'max-content',
                transform: 'translateX(-50%)',
                // Where the fade stands right now, so a label that mounts mid
                // transition starts from it instead of flashing at full
                // opacity for the frame before `applyState` runs.
                opacity:
                  hideFade.value *
                  mutedOpacity(muteFade.value) *
                  selectionLabelOpacity(reticleFade.value),
              }}
            >
              <span
                style={{
                  display: 'block',
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: labelTitlePx,
                  letterSpacing: `${LABEL_TITLE_TRACKING_EM}em`,
                  color: dimmedLabel ? LABEL_COLOR_DIMMED : LABEL_COLOR_ACTIVE,
                  // The label is plain DOM, so its half of the state change is a
                  // CSS transition on the same curve — dropped entirely under
                  // reduced motion, which an inline style cannot express as a
                  // media query.
                  transition: reduced ? undefined : `color ${STATE_TRANSITION_MS}ms cubic-bezier(.2,.8,.2,1)`,
                  whiteSpace: 'nowrap',
                }}
              >
                {truncateLabel(session.title)}
              </span>
              {modelFamily && (
                // canvas 4a, "Map label, second line under the planet title":
                // mono 9.5px / .1em tracking, 5px below the title.
                <span
                  style={{
                    display: 'block',
                    marginTop: LABEL_FAMILY_GAP_PX,
                    textAlign: 'center',
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontSize: labelFamilyPx,
                    letterSpacing: `${LABEL_FAMILY_TRACKING_EM}em`,
                    // The canvas value while live; falls to the same dimmed
                    // value as the title once ended, so the family line stops
                    // competing rather than out-shining the name above it.
                    color: dimmedLabel ? LABEL_COLOR_DIMMED : LABEL_MODEL_COLOR,
                    // Same curve as the title's color transition, so the two
                    // lines dim together rather than the family snapping.
                    transition: reduced ? undefined : `color ${STATE_TRANSITION_MS}ms cubic-bezier(.2,.8,.2,1)`,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {modelFamily.toUpperCase()}
                </span>
              )}
              {captionMounted && (
                // 26b: the caption line under the name, 4px below it, for six
                // seconds after a successful compaction.
                <span
                  data-compacted-caption
                  style={{
                    display: 'block',
                    marginTop: 4,
                    textAlign: 'center',
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontSize: labelFamilyPx,
                    letterSpacing: '0.08em',
                    color: COMPACTED_CAPTION_INK,
                    opacity: captionShown ? 1 : 0,
                    transition: reduced ? undefined : `opacity ${STATE_TRANSITION_MS}ms ease`,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {captionText}
                </span>
              )}
            </span>
          </Html>

          {/* Hover-expanded label: the full title typing itself out over a
              scrim, laid OVER the resting label (which stays put — the
              overlay's first characters are identical, so it reads as the
              ellipsis unfolding). zIndexRange above the resting labels'
              [5, 0] so the full title reads over the neighbours' labels
              instead of tangled into them. Opacity, transform and text are
              all frame-loop writes — see the hover block in useFrame. */}
          {overlayMounted && (
            <Html zIndexRange={[20, 10]} style={{ pointerEvents: 'none' }}>
              <span
                ref={overlayRef}
                style={{
                  display: 'block',
                  width: 'max-content',
                  maxWidth: HOVER_LABEL_MAX_WIDTH_PX,
                  transform: 'translateX(-50%)',
                  opacity: 0,
                  textAlign: 'center',
                  background: HOVER_LABEL_SCRIM,
                  borderRadius: 4,
                  padding: '3px 8px',
                  // Keeps the overlay's first text line on the resting
                  // label's anchor, so the expansion grows around the title
                  // instead of nudging it down by the padding.
                  marginTop: -3,
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  fontSize: labelTitlePx,
                  letterSpacing: `${LABEL_TITLE_TRACKING_EM}em`,
                  lineHeight: 1.5,
                  color: LABEL_COLOR_ACTIVE,
                  overflowWrap: 'anywhere',
                }}
              >
                <span ref={overlayTextRef} />
                <span ref={overlayCursorRef} style={{ display: 'none' }}>
                  ▌
                </span>
              </span>
            </Html>
          )}
        </group>
      )}
    </group>
  )
}

/**
 * Memoised because every `sessions` event rebuilds the scene model and
 * re-renders `SpaceMap`, and a busy turn sends many: without it the whole
 * map re-rendered for one planet's change. Shallow props only — `SpaceMap`
 * passes stable callbacks and `useSceneModel` keeps an unchanged
 * `contextFill` object, so keep any new prop stable too rather than
 * reaching for a custom comparator.
 */
export const Planet = memo(PlanetBody)
