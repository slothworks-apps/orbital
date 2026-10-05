import type { CSSProperties } from 'react'
import { dotMotionClass, stateColor } from '../../lib/stateStyle'
import { sessionStateKey, type ApiSession, type SessionStateKey } from '../../lib/types'
import { StateDot } from '../../ui/StateDot'
import { glyphFor, isGateRow, waitsForLimit } from '../sessionList'

/** 9b's header dot sizes, px; the fidelity pass owns them. */
export const GLYPH_SOLID_PX = 7
export const GLYPH_HOLLOW_PX = 7

type StateFields = Pick<ApiSession, 'status' | 'interruptedAt' | 'pendingDecision' | 'awaitingSubagents' | 'subagents' | 'backgroundTasks'>

/** The state's bare dot, beside its word (9b's header). */
export function Glyph({ session, offline }: { session: StateFields; offline: boolean }) {
  const key = sessionStateKey(session)
  return (
    <span className={['inline-flex shrink-0 justify-center', offline ? 'opacity-50' : ''].join(' ')}>
      <StateDot dot={glyphFor(key, offline)} color={stateColor(key)} solidPx={GLYPH_SOLID_PX} hollowPx={GLYPH_HOLLOW_PX} />
    </span>
  )
}

/** 9p's planet sizes, px: the body, and its centre dot per shape. */
const PLANET_PX = 28
const PLANET_IDLE_PX = 26
const PLANET_ENDED_PX = 18
const CORE_SOLID_PX = 8
const CORE_HOLLOW_PX = 7
/** Canvas 10a `G.gate`: the gate's centre, a square turned to a diamond, and its corner radius. */
const CORE_DIAMOND_PX = 8
const CORE_DIAMOND_RADIUS_PX = 1.5

type PlanetFields = StateFields & Pick<ApiSession, 'harnessGate' | 'source' | 'limitWait' | 'pinnedAt'>

/**
 * Which states turn their tick ring (9p: "ring turns"), and how slowly — a
 * session asking for you turns slower than one at work, so the eye does not
 * read urgency into speed.
 */
const RING_SPIN: Partial<Record<SessionStateKey, string>> = {
  needs_input: 'orbital-spin 96s linear infinite',
  working: 'orbital-spin 60s linear infinite',
  waiting: 'orbital-spin 60s linear infinite',
}

/** The tick ring: a dashed conic band masked down to a thin circle around the body. */
const RING_MASK = 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))'

/**
 * A session's planet in the list (9a, 9p "STATE GLYPH · 28 PX"): a tick
 * ring, a body lit in the state's colour and the state's dot at its core.
 * Offline it keeps shape and colour, dimmed, and nothing moves.
 *
 * Two rows of 10a differ: a harness gate is NEEDS INPUT's planet held still
 * — no ring turn, a diamond at its core that does not breathe — and a limit
 * wait is IDLE's planet with a hollow core, still and never amber.
 */
export function PlanetGlyph({ session, offline }: { session: PlanetFields; offline: boolean }) {
  const key = sessionStateKey(session)
  const gate = isGateRow(session)
  const limit = !gate && waitsForLimit(session)
  if (key === 'ended') {
    return (
      <span aria-hidden className="grid h-11 w-11 shrink-0 place-items-center">
        <span
          className="block rounded-full border border-[rgba(200,215,235,.35)] bg-[oklch(17%_.01_230)] opacity-60"
          style={{ width: PLANET_ENDED_PX, height: PLANET_ENDED_PX }}
        />
      </span>
    )
  }
  const quiet = key === 'idle' || limit
  const color = quiet ? 'rgba(200,215,235,.7)' : stateColor(key)
  const dot = limit
    ? { shape: 'hollow' as const, motion: 'steady' as const }
    : gate
      ? { ...glyphFor(key, offline), motion: 'steady' as const }
      : glyphFor(key, offline)
  const size = quiet ? PLANET_IDLE_PX : PLANET_PX
  const core = gate ? CORE_DIAMOND_PX : dot.shape === 'solid' ? CORE_SOLID_PX : CORE_HOLLOW_PX
  // oklab, not oklch: mixing amber into a blue-black through oklch hue swings it green.
  const mix = (share: number, onto: string) => `color-mix(in oklab, ${color} ${share}%, ${onto})`
  const ring: CSSProperties = {
    inset: -5,
    background: `repeating-conic-gradient(${quiet ? 'rgba(200,215,235,.32)' : mix(offline ? 55 : 78, 'transparent')} 0 1.5deg, transparent 1.5deg 8deg)`,
    WebkitMask: RING_MASK,
    mask: RING_MASK,
    animation: offline || gate ? undefined : RING_SPIN[key],
  }
  const body: CSSProperties = {
    background: `radial-gradient(circle at 50% 42%, ${mix(quiet ? 12 : 22, 'oklch(22% .02 230)')}, ${mix(quiet ? 4 : 10, 'oklch(14% .015 230)')} 72%)`,
    border: `1px solid ${quiet ? 'rgba(200,215,235,.4)' : mix(offline ? 45 : 62, 'transparent')}`,
    boxShadow: quiet || offline ? undefined : `0 0 13px ${mix(32, 'transparent')}`,
  }
  return (
    <span aria-hidden className="grid h-11 w-11 shrink-0 place-items-center">
      <span className="relative block" style={{ width: size, height: size }}>
        <span className="absolute rounded-full" style={ring} />
        <span className="absolute inset-0 rounded-full" style={body} />
        {dot.shape !== 'none' && (
          <span
            className={['absolute left-1/2 top-1/2 box-border', gate ? '' : 'rounded-full', dotMotionClass(dot.motion)].join(' ')}
            style={{
              width: core,
              height: core,
              margin: `-${core / 2}px 0 0 -${core / 2}px`,
              ...(gate ? { borderRadius: CORE_DIAMOND_RADIUS_PX, transform: 'rotate(45deg)' } : {}),
              ...(dot.shape === 'solid'
                ? { background: offline ? mix(78, 'transparent') : color }
                : { border: `1.5px solid ${color}` }),
            }}
          />
        )}
      </span>
    </span>
  )
}
