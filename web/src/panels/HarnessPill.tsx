import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent, RefObject } from 'react'
import { useOrbital } from '../store/store'
import { harnessEnabled } from '../lib/experimental'
import { pillReading, type PillGlyph } from '../lib/harnessSession'
import { shortcutLabel } from '../lib/keymap'
import type { ApiSession, SessionHarness } from '../lib/types'

/** 30a-d: "flyout after 250 ms, no motion beyond a 120 ms fade". */
const FLYOUT_DELAY_MS = 250

/** Sessions whose first harness read is out: the pill, the strip and the transcript all ask at once. */
const firstReads = new Set<string>()

/** Reads the session's harness unless a first read of it is already out. */
export function readHarnessOnce(sessionId: string): void {
  if (firstReads.has(sessionId)) return
  firstReads.add(sessionId)
  void useOrbital.getState().loadHarness(sessionId).finally(() => firstReads.delete(sessionId))
}

/**
 * The session's harness, read the first time something shows the session:
 * the live one, null for none, undefined while unread or while the
 * experimental switch is off. Only Orbital's own sessions can take one.
 */
export function useSessionHarness(session: Pick<ApiSession, 'id' | 'source'> | undefined): SessionHarness | null | undefined {
  const enabled = useOrbital((s) => harnessEnabled(s.settings))
  const id = session?.source === 'web' ? session.id : undefined
  const harness = useOrbital((s) => (id ? s.harnesses[id] : undefined))
  useEffect(() => {
    if (enabled && id && harness === undefined) readHarnessOnce(id)
  }, [enabled, id, harness])
  return enabled && id ? harness : undefined
}

/** The pill's state glyph (30a-d, the six states' row). */
function Glyph({ glyph, ink }: { glyph: PillGlyph; ink: string }) {
  if (glyph === 'pause') {
    return (
      <span aria-hidden className="flex h-[7px] gap-[2px]">
        <span className="block h-[7px] w-[2px] rounded-[.5px]" style={{ background: ink }} />
        <span className="block h-[7px] w-[2px] rounded-[.5px]" style={{ background: ink }} />
      </span>
    )
  }
  if (glyph === 'eye') {
    return (
      <span
        aria-hidden
        className="box-border flex size-2 rotate-45 items-center justify-center rounded-[75%_0] border-[1.3px] border-solid"
        style={{ borderColor: ink }}
      >
        <span className="block size-[2.6px] rounded-full" style={{ background: ink }} />
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className={[
        'box-border block size-1.5 border-[1.3px] border-solid',
        glyph === 'gate' ? 'rotate-45 rounded-[1px]' : 'rounded-full',
      ].join(' ')}
      style={{ borderColor: ink, background: ink }}
    />
  )
}

/**
 * The drawer handle (canvas `Feature - Harness` 30a-d, chosen): a 20 px pill
 * half over the session panel's right edge, on the side the harness panel
 * opens, top-aligned with the state row. At rest a state glyph and one
 * segment per step; hovering raises a flyout with the step and its state;
 * a click toggles the panel, and the pill fades out while the panel is open
 * — the panel shows the harness then. Nothing in it moves but the fades.
 *
 * Sits outside the panel's clipping shell — the caller mounts it in the
 * panel's positioned wrapper — on a layer of its own over the panel, and
 * follows the state row (`stateRowRef`) as the header grows and shrinks.
 */
export function HarnessPill({
  session,
  stateRowRef,
  edge,
}: {
  session: ApiSession
  stateRowRef: RefObject<HTMLElement | null>
  /** `over` half over the panel's edge; `inside` against a window's own edge, where half would be cut off. */
  edge: 'over' | 'inside'
}) {
  const harness = useSessionHarness(session)
  const panelOpen = useOrbital((s) => s.harnessPanel?.sessionId === session.id)
  const openHarness = useOrbital((s) => s.openHarness)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const [top, setTop] = useState<number | null>(null)
  const [hovered, setHovered] = useState(false)
  const [flyout, setFlyout] = useState(false)
  const shown = Boolean(harness)

  // Top-aligned with the state row (30a-d), whatever the title above it wraps to.
  useLayoutEffect(() => {
    const layer = layerRef.current
    const row = stateRowRef.current
    if (!shown || !layer || !row) return
    const measure = () => setTop(row.getBoundingClientRect().top - layer.getBoundingClientRect().top)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(layer)
    if (row.parentElement) observer.observe(row.parentElement)
    return () => observer.disconnect()
  }, [shown, stateRowRef])

  useEffect(() => {
    if (!hovered || panelOpen) {
      setFlyout(false)
      return
    }
    const timer = setTimeout(() => setFlyout(true), FLYOUT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [hovered, panelOpen])

  if (!harness) return null
  return (
    // Pointer-transparent, so only the pill itself takes a press. Measured
    // first: the pill appears once it knows where the state row is.
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-30">
      {top !== null && (
        <Pill
          harness={harness}
          top={top}
          edge={edge}
          panelOpen={panelOpen}
          hovered={hovered}
          flyout={flyout}
          onHover={setHovered}
          onClick={(e) => {
            setHovered(false)
            // ⌥-click goes straight to the full window (30a-d / 30h); a mouse modifier, so QWERTZ is no concern.
            openHarness(session.id, { full: e.altKey })
          }}
        />
      )}
    </div>
  )
}

function Pill({
  harness,
  top,
  edge,
  panelOpen,
  hovered,
  flyout,
  onHover,
  onClick,
}: {
  harness: SessionHarness
  top: number
  edge: 'over' | 'inside'
  panelOpen: boolean
  hovered: boolean
  flyout: boolean
  onHover: (hovered: boolean) => void
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
}) {
  const reading = pillReading(harness)
  const lit = hovered || panelOpen
  return (
    <button
      type="button"
      data-harness-pill
      aria-label={`Harness: step ${reading.count.replace('/', ' of ')}, ${reading.status}`}
      aria-expanded={panelOpen}
      tabIndex={panelOpen ? -1 : undefined}
      onClick={onClick}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      // `orbital-no-drag`: the main window's drag band would take a press near its top.
      className="orbital-no-drag absolute z-30 box-border flex w-5 cursor-pointer flex-col items-center gap-[9px] rounded-[10px] border border-solid py-3 shadow-[0_6px_18px_rgba(0,0,0,.45)] backdrop-blur-[12px] transition-opacity duration-[180ms] ease-[ease] focus-visible:outline-none"
      style={{
        top,
        right: edge === 'over' ? -11 : 6,
        background: lit ? 'rgba(150,205,255,.14)' : 'rgba(10,15,27,.9)',
        borderColor: lit ? 'rgba(150,205,255,.3)' : 'rgba(150,205,255,.18)',
        opacity: panelOpen ? 0 : 1,
        pointerEvents: panelOpen ? 'none' : 'auto',
      }}
    >
      <Glyph glyph={reading.glyph} ink={reading.ink} />
      <span aria-hidden className="flex flex-col gap-[2px]">
        {reading.segments.map((colour, i) => (
          <span key={i} className="block h-2 w-1 rounded-[1px]" style={{ background: colour }} />
        ))}
      </span>
      {/* The flyout (30a-d): on the panel's side of the pill, its top on the pill's. */}
      <span
        aria-hidden
        className="pointer-events-none absolute top-[-1px] right-[calc(100%+8px)] box-border flex w-[290px] cursor-default flex-col gap-1.5 rounded-[10px] border border-solid border-[rgba(150,205,255,.18)] bg-[rgba(10,16,28,.96)] px-[13px] pt-[11px] pb-3 text-left shadow-[0_18px_50px_rgba(0,0,0,.6)]"
        style={{
          opacity: flyout ? 1 : 0,
          visibility: flyout ? 'visible' : 'hidden',
          // Visibility flips at the fade's far end, so the fade out is seen.
          transition: 'opacity 120ms ease, visibility 0s linear ' + (flyout ? '0s' : '120ms'),
        }}
      >
        <span className="flex items-center gap-2 font-mono text-[9.5px] tracking-[0.16em] text-[rgba(160,190,225,.6)]">
          HARNESS
          <span className="min-w-0 flex-1 truncate tracking-[0.02em]">{harness.name}</span>
          <span className="tracking-[0.04em] text-[#e8eef8]">{reading.count}</span>
        </span>
        <span className="line-clamp-2 text-[12.5px] leading-[1.4] font-semibold text-[#e8eef8]">{reading.title}</span>
        <span className="flex items-center gap-2 font-mono text-[10px]" style={{ color: reading.statusInk }}>
          {reading.status}
          {reading.detail && <span className="text-[rgba(160,190,225,.6)]">· {reading.detail}</span>}
        </span>
        <span className="border-t border-solid border-[rgba(150,205,255,.08)] pt-[7px] font-mono text-[9.5px] text-[rgba(160,190,225,.55)]">
          click · open the harness panel · {shortcutLabel('session.harness')}
        </span>
      </span>
    </button>
  )
}
