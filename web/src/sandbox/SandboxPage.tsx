import { useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import type { ApiSession, SessionStatus } from '../lib/types'
import { Planet } from '../map/Planet'
import { BODY_RADIUS } from '../map/visuals'
import { PLANET_STATES } from '../map/transition'
import { scaleFor } from '../map/layout'
import { Panel } from '../ui/Panel'
import { Select } from '../ui/Select'
import { Checkbox } from '../ui/Checkbox'
import { ErrorBoundary } from '../ui/ErrorBoundary'

/**
 * `/sandbox` — a dev-only workbench for tuning planet state transitions.
 *
 * One planet, four controls, no server: the page renders `<Planet>` exactly
 * as the map does but drives its props by hand, so a state crossfade, the
 * retag hue tween, the selection reticle and the ended suppression can each
 * be replayed on demand instead of waiting for a live session to do it.
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

/** The one fake session the planet is fed; only `status` ever varies. */
function sandboxSession(status: SessionStatus): ApiSession {
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
    parentId: null,
    tagIds: [],
    status,
    subagents: [],
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

  const session = useMemo(() => sandboxSession(status), [status])

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
            />
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
