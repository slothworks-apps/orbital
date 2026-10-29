import { swatch } from '../lib/palette'
import { useEffect, useState, type CSSProperties } from 'react'

/** 10e2 LATE: how long a load shows only the faint surface before the moon fades in. */
export const LOADER_DELAY_MS = 400
/** 10e2: the moon's fade in, and the image's over it. */
export const LOADER_FADE_MS = 600
/** One turn of the moon and of the orbit (10e2 VALUES); `theme.css`'s `.orbital-moon*` run the same. */
const MOON_TURN_MS = 8_000
const ORBIT_TURN_MS = 60_000

/** 10e2 VALUES: orbit Ø, planet and moon per place — viewer, tool row, thumbnail. */
const SIZES = {
  viewer: { orbit: 60, planet: 16, moon: 6 },
  row: { orbit: 32, planet: 8, moon: 4.5 },
  thumb: { orbit: 24, planet: 6, moon: 4 },
} as const

/** The faint surface of a reserved box while its bytes are on their way (10e2). */
export const LOADING_SURFACE = swatch('line', 0.035)

const RING_MASK = 'radial-gradient(farthest-side,transparent calc(100% - 1.5px),#000 calc(100% - 1px))'

/** True once `ms` have passed since mount — 10e2's "for 400 ms it is only a faint surface". */
export function useLate(ms = LOADER_DELAY_MS): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setLate(true), ms)
    return () => clearTimeout(t)
  }, [ms])
  return late
}

/** A negative delay putting an animation where one clock would have it, so every loader turns in step. */
function inStep(period: number): string {
  return `-${Math.round(performance.now() % period)}ms`
}

/**
 * Canvas 10e2 MOON — a small neutral planet with one moon on a dashed orbit,
 * where a picture's bytes are still on their way. Hidden for
 * `LOADER_DELAY_MS`, then fades in. With `progress` (the size is known) the
 * orbit fills as an arc and the moon rides its head; without it the moon
 * orbits on its own. `stalled` stops all motion where it is.
 */
export function MoonLoader({
  size,
  progress = null,
  stalled = false,
}: {
  size: keyof typeof SIZES
  /** 0–1 of the bytes in, when the total is known. */
  progress?: number | null
  stalled?: boolean
}) {
  const late = useLate()
  const [delays] = useState(() => ({ moon: inStep(MOON_TURN_MS), orbit: inStep(ORBIT_TURN_MS) }))
  const s = SIZES[size]
  const paused: CSSProperties = stalled ? { animationPlayState: 'paused' } : {}
  const ring: CSSProperties = { WebkitMask: RING_MASK, mask: RING_MASK }
  const pct = progress === null ? null : Math.max(0, Math.min(1, progress)) * 100
  return (
    <span
      aria-hidden
      className="absolute left-1/2 top-1/2 block"
      style={{
        width: s.orbit,
        height: s.orbit,
        margin: `${-s.orbit / 2}px 0 0 ${-s.orbit / 2}px`,
        opacity: late ? 1 : 0,
        transition: `opacity ${LOADER_FADE_MS}ms ease`,
      }}
    >
      <span
        className="orbital-moon-orbit absolute inset-0 rounded-full"
        style={{
          ...ring,
          ...paused,
          animationDelay: delays.orbit,
          background: 'repeating-conic-gradient(color-mix(in oklab, var(--color-line) 42%, transparent) 0 2deg,transparent 2deg 10deg)',
        }}
      />
      {pct !== null && (
        <span
          className="absolute inset-0 rounded-full"
          style={{ ...ring, background: `conic-gradient(color-mix(in oklab, var(--color-ink-200) 80%, transparent) 0 ${pct}%,transparent 0)` }}
        />
      )}
      <span
        className="absolute left-1/2 top-1/2 box-border block rounded-full border border-line/30"
        style={{
          width: s.planet,
          height: s.planet,
          margin: `${-s.planet / 2}px 0 0 ${-s.planet / 2}px`,
          background: 'radial-gradient(circle at 50% 38%,var(--color-disc-off),var(--color-body-ended) 74%)',
        }}
      />
      <span
        className={['absolute inset-0', pct === null ? 'orbital-moon' : ''].join(' ')}
        style={pct === null ? { ...paused, animationDelay: delays.moon } : { transform: `rotate(${pct * 3.6}deg)` }}
      >
        <span
          className="absolute left-1/2 block rounded-full bg-ink-100 shadow-[0_0_6px_color-mix(in_oklab,_var(--color-ink-300)_50%,_transparent)]"
          style={{ top: -s.moon / 2 + 0.75, width: s.moon, height: s.moon, marginLeft: -s.moon / 2 }}
        />
      </span>
    </span>
  )
}
