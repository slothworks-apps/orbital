import { useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import type { ApiSession, SessionStatus, Subagent } from '../lib/types'
import { Planet } from '../map/Planet'
import { Moon } from '../map/Moon'
import { moonOrbitRadius, type ContextFill } from '../map/sceneModel'
import { contextLevel } from '../lib/usage'
import { BODY_RADIUS } from '../map/visuals'
import { PLANET_STATES } from '../map/transition'
import { GOLDEN_ANGLE, scaleFor } from '../map/layout'
import { Panel } from '../ui/Panel'
import { Select } from '../ui/Select'
import { Checkbox } from '../ui/Checkbox'
import { ErrorBoundary } from '../ui/ErrorBoundary'

/**
 * `/sandbox` — a dev-only workbench for tuning planet state transitions.
 *
 * One planet, a handful of controls, no server: the page renders `<Planet>`
 * (and, on request, orbiting `<Moon>`s) exactly as the map does but drives
 * the props by hand, so a state crossfade, the retag hue tween, the
 * selection reticle, the ended suppression and the moon orbits' gauge
 * clearance can each be replayed on demand instead of waiting for a live
 * session to do it.
 *
 * Mounted INSTEAD of `<App>` (see `main.tsx`), deliberately: the sandbox
 * must not open a WebSocket or touch the store, so a broken server never
 * gets between you and an animation you are tuning.
 */

/**
 * Camera zoom at which one world unit is `50 / BODY_RADIUS` px — the design
 * canvas's own scale (artboard 1f draws a 100px body, i.e. a 50px radius),
 * so what is on screen can be compared against the canvas 1:1. Above the
 * map's reference zoom, so `bodyZoomFactor` stays clamped at identity.
 */
const CANVAS_ZOOM = 50 / BODY_RADIUS

const STATE_OPTIONS = PLANET_STATES.map((state) => ({
  value: state,
  label: state.replace('_', ' '),
}))

/** A few tag hues to replay the retag hue tween with (values as `tagColor`). */
const HUE_OPTIONS = [210, 30, 140, 280, 350].map((hue) => ({
  value: hue,
  label: `hue ${hue}`,
  dotColor: `oklch(80% .13 ${hue})`,
}))

/**
 * Context-arc fills to replay (spec `context-fill-arc`). The four gauged
 * percentages are artboard 1i's own planets, so the arc, its threshold marks
 * and the `/compact` pill can be compared against the canvas 1:1 at
 * `CANVAS_ZOOM`; "none" is a session with no reading at all.
 */
const CONTEXT_OPTIONS = [
  { value: -1, label: 'none (no gauge)' },
  { value: 0, label: '0 %' },
  { value: 25, label: '25 %' },
  { value: 50, label: '50 % (first threshold)' },
  { value: 72, label: '72 % (amber)' },
  { value: 88, label: '88 % (red + pulse)' },
]

/** What the sandbox's thresholds are — the store's defaults, as canvas 1i draws them. */
const SANDBOX_THRESHOLDS = { warn: 50, critical: 80 }

const MOON_COUNT_OPTIONS = [0, 1, 2, 3].map((n) => ({ value: n, label: String(n) }))

/**
 * Each sandbox moon gets a different state, cycling through the live ones,
 * so one count change also previews the state variants side by side.
 */
const MOON_STATE_CYCLE: Subagent['state'][] = ['working', 'idle', 'needs_input', 'materializing']

const sandboxMoons = (count: number): Subagent[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `moon-${i}`,
    name: `moon ${i + 1}`,
    state: MOON_STATE_CYCLE[i % MOON_STATE_CYCLE.length],
    startedAt: Date.now(),
  }))

/**
 * The one fake session the planet is fed. `subagents` is the same list the
 * moons are drawn from, because the `WAITING FOR AGENT` pill counts them —
 * so the label and the orbit are checkable against each other here.
 */
function sandboxSession(
  status: SessionStatus,
  subagents: Subagent[],
  awaitingSubagents: boolean
): ApiSession {
  return {
    id: 'sandbox',
    cwd: '/sandbox',
    title: 'sandbox planet',
    firstAt: null,
    lastAt: null,
    messageCount: 0,
    source: 'web',
    permissionMode: null,
    model: null,
    resolvedModel: null,
    tagIds: [],
    status,
    awaitingSubagents,
    subagents,
  }
}

export function SandboxPage() {
  const [status, setStatus] = useState<SessionStatus>('working')
  const [hue, setHue] = useState(210)
  const [selected, setSelected] = useState(false)
  const [hidden, setHidden] = useState(false)
  // On by default so the sandbox shows what the map shows: the layout ties
  // scale to status (`scaleFor`), and that size change is part of the
  // transition being tuned. Off = pure crossfade at full size.
  const [tierScale, setTierScale] = useState(true)
  const [contextPercent, setContextPercent] = useState(-1)
  const [moonCount, setMoonCount] = useState(0)
  const [awaiting, setAwaiting] = useState(false)

  const moons = useMemo(() => sandboxMoons(moonCount), [moonCount])
  const session = useMemo(
    () => sandboxSession(status, moons, awaiting),
    [status, moons, awaiting]
  )
  const contextFill = useMemo<ContextFill | null>(
    () =>
      contextPercent < 0
        ? null
        : {
            fraction: contextPercent / 100,
            level: contextLevel(contextPercent / 100, SANDBOX_THRESHOLDS),
          },
    [contextPercent]
  )

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-space">
      <div className="absolute inset-0">
        {/* Same net App puts around SpaceMap: WebGL is the part of this page
            that can throw (and gets hot-swapped mid-edit while tuning). */}
        <ErrorBoundary label="Planet preview">
          <Canvas orthographic camera={{ zoom: CANVAS_ZOOM, position: [0, 0, 100] }}>
            <Planet
              session={session}
              hue={hue}
              x={0}
              y={0}
              scale={tierScale ? scaleFor(session) : 1}
              selected={selected}
              hidden={hidden}
              contextFill={contextFill}
              contextThresholds={SANDBOX_THRESHOLDS}
              showCompactBadge
            />
            {/* Same orbit derivation the map uses (`moonOrbitRadius`), so the
                gauge clearance is checkable here without a live session. */}
            {moons.map((subagent, i) => (
              <Moon
                key={subagent.id}
                subagent={subagent}
                hue={hue}
                parentX={0}
                parentY={0}
                orbitRadius={moonOrbitRadius(
                  tierScale ? scaleFor(session) : 1,
                  i,
                  contextFill !== null
                )}
                phase={i * GOLDEN_ANGLE}
              />
            ))}
          </Canvas>
        </ErrorBoundary>
      </div>

      <Panel side="float" className="absolute left-4 top-4 z-10 w-[240px]">
        <div className="flex flex-col gap-4 p-4">
          <h1 className="font-mono text-[11px] tracking-[0.14em] text-text-bright">
            PLANET SANDBOX
          </h1>

          <div className="flex flex-col gap-1.5">
            <label
              id="sandbox-state-label"
              className="font-mono text-[10px] tracking-[0.1em] text-text-soft"
            >
              STATE
            </label>
            <Select
              aria-labelledby="sandbox-state-label"
              options={STATE_OPTIONS}
              value={status}
              onChange={setStatus}
              font="mono"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              id="sandbox-hue-label"
              className="font-mono text-[10px] tracking-[0.1em] text-text-soft"
            >
              TAG HUE
            </label>
            <Select
              aria-labelledby="sandbox-hue-label"
              options={HUE_OPTIONS}
              value={hue}
              onChange={setHue}
              font="mono"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              id="sandbox-context-label"
              className="font-mono text-[10px] tracking-[0.1em] text-text-soft"
            >
              CONTEXT FILL
            </label>
            <Select
              aria-labelledby="sandbox-context-label"
              options={CONTEXT_OPTIONS}
              value={contextPercent}
              onChange={setContextPercent}
              font="mono"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              id="sandbox-moons-label"
              className="font-mono text-[10px] tracking-[0.1em] text-text-soft"
            >
              MOONS
            </label>
            <Select
              aria-labelledby="sandbox-moons-label"
              options={MOON_COUNT_OPTIONS}
              value={moonCount}
              onChange={setMoonCount}
              font="mono"
            />
          </div>

          {/* Only bites on a `working` planet with moons in orbit — the
              state that is busy without being busy here. */}
          <Checkbox
            checked={awaiting}
            onChange={setAwaiting}
            label="waiting for its agents (pill)"
          />
          <Checkbox checked={selected} onChange={setSelected} label="selected (reticle)" />
          <Checkbox checked={hidden} onChange={setHidden} label="hidden (ended suppression)" />
          <Checkbox
            checked={tierScale}
            onChange={setTierScale}
            label="scale follows state (layout tiers)"
          />
        </div>
      </Panel>
    </div>
  )
}
