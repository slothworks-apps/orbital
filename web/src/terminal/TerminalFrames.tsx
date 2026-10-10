import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { useOrbital } from '../store/store'
import { TerminalSurface } from './TerminalSurface'
import { DOCK_DEFAULT_PX, DOCK_HEIGHT_SETTING, clampDockHeight, parseDockHeight } from './layout'

/**
 * The frame the dock and the side panel share (48a, 48b): the standard panel
 * glass — without its blur, as every docked panel goes without it (adr
 * docked-panels-are-opaque-not-frosted-glass) — around the opaque body.
 */
const FRAME = [
  'rounded-[14px] border border-[rgba(150,205,255,.18)]',
  'bg-gradient-to-b from-[rgba(14,20,34,.9)] to-[rgba(8,12,22,.94)]',
  'shadow-[0_30px_80px_rgba(0,0,0,.55),inset_0_1px_0_rgba(255,255,255,.06)]',
].join(' ')

/** The window's inner height, followed through every resize (as `useViewportWidth` does the width). */
function useViewportHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight)
  useEffect(() => {
    let frame: number | null = null
    const onResize = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        setHeight(window.innerHeight)
      })
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [])
  return height
}

/**
 * The dock's height and the handle on its top edge (48a): the value moves
 * live in the store during the drag and is saved once, on release, as the
 * panels' widths are. A double-click resets it.
 */
function useDockHeight() {
  const viewportHeight = useViewportHeight()
  const height = useOrbital((s) => parseDockHeight(s.settings, viewportHeight))
  const drag = useRef<{ startY: number; startHeight: number } | null>(null)

  const setLocal = (next: number) => {
    const value = String(Math.round(clampDockHeight(next, viewportHeight)))
    useOrbital.setState((state) => ({ settings: { ...state.settings, [DOCK_HEIGHT_SETTING]: value } }))
    return value
  }
  const save = (value: string) => {
    api
      .patchSettings({ [DOCK_HEIGHT_SETTING]: value })
      .catch((err) => reportError(err, 'Failed to save the terminal height'))
  }

  const handle = {
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      drag.current = { startY: e.clientY, startHeight: height }
      // Optional-chained: jsdom has no pointer capture.
      e.currentTarget.setPointerCapture?.(e.pointerId)
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current
      // A bottom-docked panel: the pointer moving UP makes it taller.
      if (d) setLocal(d.startHeight + (d.startY - e.clientY))
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = drag.current
      if (!d) return
      drag.current = null
      save(setLocal(d.startHeight + (d.startY - e.clientY)))
    },
    onDoubleClick: () => save(setLocal(DOCK_DEFAULT_PX)),
  }
  return { height, handle }
}

/** The top edge's drag handle and its grip (48a). */
function DockHandle({ handle }: { handle: ReturnType<typeof useDockHeight>['handle'] }) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal"
      title="Drag to resize · double-click to reset"
      onPointerDown={handle.onPointerDown}
      onPointerMove={handle.onPointerMove}
      onPointerUp={handle.onPointerUp}
      onPointerCancel={handle.onPointerUp}
      onDoubleClick={handle.onDoubleClick}
      className="absolute inset-x-0 top-0 z-[3] h-2 cursor-row-resize touch-none"
    >
      <span
        aria-hidden
        className="absolute top-[5px] left-1/2 -ml-4 block h-[3px] w-8 rounded-[2px] bg-[rgba(150,205,255,.18)]"
      />
    </div>
  )
}

/**
 * Placement A in the main window (48a): under the map, from the sidebar's
 * gutter to just before the detail panel — `App` works out the extent.
 */
export function TerminalDock({ sessionId, leftPx, rightPx }: { sessionId: string; leftPx: number; rightPx: number }) {
  const { height, handle } = useDockHeight()
  return (
    <div
      data-terminal-dock
      className={`absolute bottom-4 z-10 flex flex-col ${FRAME}`}
      style={{ left: leftPx, right: rightPx, height }}
    >
      <DockHandle handle={handle} />
      <TerminalSurface sessionId={sessionId} variant="dock" />
    </div>
  )
}

/**
 * The dock in a detached session window: the window's whole width, under
 * the composer (48a's note). No glass — the window is the frame — only the
 * hairline that parts it from the panel above.
 */
export function TerminalWindowDock({ sessionId }: { sessionId: string }) {
  const { height, handle } = useDockHeight()
  return (
    <div
      data-terminal-dock
      className="relative flex flex-none flex-col border-t border-[rgba(150,205,255,.18)] bg-gradient-to-b from-[#0f1524] to-[#080c16]"
      style={{ height }}
    >
      <DockHandle handle={handle} />
      <TerminalSurface sessionId={sessionId} variant="window" />
    </div>
  )
}

/**
 * Placement B (48b): the side slot at the right edge, full height, at the
 * width `App` resolved for it.
 */
export function TerminalSidePanel({ sessionId, widthPx }: { sessionId: string; widthPx: number }) {
  return (
    <div data-terminal-side className={`flex h-full flex-col ${FRAME}`} style={{ width: widthPx }}>
      <TerminalSurface sessionId={sessionId} variant="side" />
    </div>
  )
}
