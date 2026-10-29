import { Fragment, useMemo } from 'react'
import {
  useOrbital,
  parseSidebarWidth,
  parseDetailPanelWidth,
  resolvePanelPairWidths,
  PANEL_GUTTER_PX,
} from '../../store/store'
import { sessionStateKey, shownStatus, type SessionStateKey } from '../../lib/types'
import type { SceneModel } from '../sceneModel'
import { stateColor, stateDot } from '../../lib/stateStyle'
import { StateDot } from '../../ui/StateDot'
import { useViewportWidth } from '../../lib/useViewportWidth'
import { mapTopInset, useWindowChromeEnv } from '../../lib/windowChrome'
import { Button } from '../../ui/Button'
import { shortcutLabel } from '../../lib/keymap'
import { useCommand } from '../../lib/commands'
import { EndDialog } from '../../panels/EndDialog'
import type { CameraState } from '../camera'
import { useDockClearancePx, useSideSlotWidth } from '../../terminal/useTerminalHost'

/** The bottom overlays' inset from the window's edge (artboard 1a). */
export const MAP_OVERLAY_BOTTOM_PX = 24

const SIDEBAR_GUTTER_PX = 40
const SIDEBAR_COLLAPSED_PX = 96

/**
 * The panel-driven chrome every map renderer lays itself out against: where
 * the sidebar ends on the left, where the open panels start on the right, and
 * the window chrome on top — the same numbers `SpaceMap` frames its fit with.
 */
export function useMapInsets() {
  const settings = useOrbital((s) => s.settings)
  const selectedId = useOrbital((s) => s.ui.selectedId)
  const sidebarCollapsed = useOrbital((s) => s.ui.sidebarCollapsed)
  // Whatever holds the side slot — an agent's panel or the terminal's (48b).
  const slotWidthPx = useSideSlotWidth()
  const subagentPanelOpen = slotWidthPx > 0
  const viewportWidth = useViewportWidth()
  const sidebarWidth = parseSidebarWidth(settings, viewportWidth)
  const rawDetailPanelWidth = parseDetailPanelWidth(settings, viewportWidth)
  const pairWidths = useMemo(
    () =>
      subagentPanelOpen
        ? resolvePanelPairWidths(rawDetailPanelWidth, slotWidthPx, viewportWidth)
        : { detailWidthPx: rawDetailPanelWidth, subagentWidthPx: 0 },
    [subagentPanelOpen, slotWidthPx, rawDetailPanelWidth, viewportWidth],
  )
  const rightPanelsChromePx =
    pairWidths.detailWidthPx +
    PANEL_GUTTER_PX +
    (subagentPanelOpen ? pairWidths.subagentWidthPx + PANEL_GUTTER_PX : 0)
  const topInset = mapTopInset(useWindowChromeEnv())
  const insets = useMemo(
    () => ({
      left: sidebarCollapsed ? SIDEBAR_COLLAPSED_PX : sidebarWidth + SIDEBAR_GUTTER_PX,
      right: selectedId ? rightPanelsChromePx : 0,
      top: topInset,
    }),
    [sidebarCollapsed, sidebarWidth, selectedId, rightPanelsChromePx, topInset],
  )
  return { insets, overlayRightPx: selectedId ? rightPanelsChromePx + 24 : 24 }
}

/**
 * DOM overlays for the map renderers other than Planets (spec
 * 2026-10-01-map-themes-design § 2): aggregate HUD, zoom column, new-session
 * CTA, error log, camera readout and the End dialog a history drop opens.
 * The floating sloth stays on the planet map only — it belongs to space.
 * Drawn the way `SpaceMap` draws its own, following the panels.
 */
export function MapShell(props: {
  model: SceneModel
  camera: CameraState
  children?: React.ReactNode
  showZoomColumn?: boolean
  showCameraReadout?: boolean
  onZoomIn?: () => void
  onZoomOut?: () => void
  onFit?: () => void
  onNewSession?: () => void
  onErrorsClick?: () => void
  confirmEndId?: string | null
  onConfirmEndClose?: () => void
  onConfirmEnd?: (id: string) => Promise<void>
}) {
  const errorLogOpen = useOrbital((s) => s.ui.dialog === 'errors')
  const errorsUnseen = useOrbital((s) => s.errorsUnseen)
  const resizingPanel = useOrbital((s) => s.ui.resizingPanel ?? false)
  const { insets: mapInsets, overlayRightPx } = useMapInsets()
  // The export's bottom inset (`bottom-6`), raised above the terminal's dock
  // while it is shown, so the dock never covers these (48a).
  const overlayBottomPx = MAP_OVERLAY_BOTTOM_PX + useDockClearancePx()

  const overlayTransition = resizingPanel
    ? ''
    : 'transition-[right] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]'
  const overlayLeftTransition = resizingPanel
    ? ''
    : 'transition-[left] duration-[420ms] ease-[cubic-bezier(.2,.8,.2,1)]'

  const { model } = props
  // Split like `SpaceMap`'s readout: only a parked question is NEEDS INPUT,
  // an interrupted one says so, the rest finished. Muted planets are left out,
  // and so are those of a device whose chip is off.
  const aggregateSegments = useMemo(() => {
    const { working, needs_input: needsInput, idle, ended } = model.counts
    let asking = 0
    let interrupted = 0
    for (const p of model.planets) {
      if (p.muted || p.deviceOff || shownStatus(p.session) !== 'needs_input') continue
      const key = sessionStateKey(p.session)
      if (key === 'needs_input') asking++
      else if (key === 'interrupted') interrupted++
    }
    const done = needsInput - asking - interrupted
    const segments: Array<{ key: SessionStateKey; text: string }> = [
      { key: 'working', text: `${working} WORKING` },
      ...(asking > 0 ? [{ key: 'needs_input' as const, text: `${asking} NEEDS INPUT` }] : []),
      ...(interrupted > 0
        ? [{ key: 'interrupted' as const, text: `${interrupted} INTERRUPTED` }]
        : []),
      ...(done > 0 ? [{ key: 'done' as const, text: `${done} DONE` }] : []),
      { key: 'idle', text: `${idle} IDLE` },
      { key: 'ended', text: `${ended} ENDED` },
    ]
    return segments
  }, [model.counts, model.planets])

  const zoomPercent = Math.round(props.camera.zoom)
  const camX = Math.round(props.camera.x)
  const camY = Math.round(props.camera.y)

  const handleFit = () => {
    props.onFit?.()
  }

  useCommand('map.fit', handleFit)

  const showZoomColumn = props.showZoomColumn !== false

  return (
    <div className="pointer-events-none absolute inset-0 z-[6]">
      {/* Aggregate readout (1a, right:24px/top:24px) */}
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
        <div className="flex items-center gap-2 font-mono fs-10.5 tracking-[0.1em] text-ink-900/70">
          {aggregateSegments.map(({ key, text }, i) => {
            const color = stateColor(key)
            return (
              <Fragment key={key}>
                {i > 0 && <span className="text-ink-900/28">·</span>}
                <span data-state={key} className="flex items-center gap-[5px]" style={{ color }}>
                  <StateDot dot={stateDot(key, 'label')} color={color} solidPx={5} hollowPx={6} />
                  {text}
                </span>
              </Fragment>
            )
          })}
        </div>
      </div>

      {/* Camera readout */}
      {props.showCameraReadout !== false && (
        // Canvas 1a/2a: `rgba(160,190,225,.5)`, ink-900 at 50.
        <div
          data-overlay="camera-readout"
          style={{ bottom: overlayBottomPx, left: mapInsets.left }}
          className={[
            'pointer-events-none absolute font-mono fs-10.5 tracking-[0.08em] text-ink-900/50',
            overlayLeftTransition,
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {zoomPercent}% · x {camX} y {camY}
        </div>
      )}

      {/* Zoom column and error log — the zoom buttons only where there is a camera */}
      {
        <div
          data-overlay="zoom-column"
          className={[
            'pointer-events-auto absolute flex flex-col items-stretch gap-2',
            overlayTransition,
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ bottom: overlayBottomPx, right: overlayRightPx }}
        >
          <button
            type="button"
            aria-label={errorsUnseen > 0 ? `Error log — ${errorsUnseen} unseen` : 'Error log'}
            title={`Error log · ${shortcutLabel('global.errors')}`}
            onClick={props.onErrorsClick}
            className={[
              'relative grid h-[34px] w-[34px] place-items-center rounded-[9px] border bg-panel/92 fs-16 font-bold leading-none transition-colors',
              errorLogOpen
                ? 'border-accent/50 text-ink-100 shadow-[0_0_0_3px_color-mix(in_oklab,_var(--color-accent)_10%,_transparent)]'
                : [
                    'border-line/16 hover:border-line/30 hover:bg-line/10 hover:text-ink-50',
                    errorsUnseen > 0 ? 'text-ink-100' : 'text-ink-500/60',
                  ].join(' '),
            ].join(' ')}
          >
            <span aria-hidden>!</span>
            {errorsUnseen > 0 && (
              <span
                aria-hidden
                className={[
                  'absolute -top-1.5 grid h-4 min-w-[16px] place-items-center rounded-full border border-space/80 bg-danger font-mono fs-9.5 font-medium tracking-[0.02em] text-white',
                  errorsUnseen > 99 ? '-right-2.5 px-[5px]' : '-right-1.5 px-1',
                ].join(' ')}
              >
                {errorsUnseen > 99 ? '99+' : errorsUnseen}
              </span>
            )}
          </button>

          {showZoomColumn && (
            <div className="flex flex-col overflow-hidden rounded-[9px] border border-line/16 bg-panel/92">
              <button
                type="button"
                aria-label="Zoom in"
                onClick={props.onZoomIn}
                className="grid h-[34px] w-[34px] place-items-center border-b border-line/10 fs-16 leading-(--text-base--line-height) text-ink-100 hover:bg-ink-50/5"
              >
                +
              </button>
              <button
                type="button"
                aria-label="Zoom out"
                onClick={props.onZoomOut}
                className="grid h-[34px] w-[34px] place-items-center border-b border-line/10 fs-16 leading-(--text-base--line-height) text-ink-100 hover:bg-ink-50/5"
              >
                −
              </button>
              <button
                type="button"
                aria-label="Fit view"
                title={`Fit view · ${shortcutLabel('map.fit')}`}
                onClick={handleFit}
                className="grid h-[34px] w-[34px] place-items-center fs-14 leading-(--text-sm--line-height) text-ink-100 hover:bg-ink-50/5"
              >
                ⌖
              </button>
            </div>
          )}
        </div>
      }

      {/* New session CTA */}
      <div
        data-overlay="new-session"
        style={{ bottom: overlayBottomPx, left: mapInsets.left, right: mapInsets.right }}
        className={[
          'pointer-events-none absolute flex justify-center',
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
          onClick={props.onNewSession}
        >
          <span aria-hidden className="fs-16 leading-none text-accent">
            +
          </span>
          New session
          <span className="rounded border border-line/20 px-1.5 py-0.5 font-mono fs-10 text-ink-500/70">
            {shortcutLabel('global.new-session')}
          </span>
        </Button>
      </div>

      {/* End dialog */}
      <EndDialog
        open={props.confirmEndId !== null}
        sessionId={props.confirmEndId ?? null}
        onClose={props.onConfirmEndClose ?? (() => {})}
        onEnd={props.onConfirmEnd}
      />

      {props.children}
    </div>
  )
}
